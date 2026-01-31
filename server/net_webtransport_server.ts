// WebTransport server driver for Deno
// Handles incoming client connections via WebTransport/HTTP3

import { Sys_Printf } from './sys_server.ts';
import { listRooms, createRoom, getRoom, updateRoomPlayerCount, type Room } from './rooms.ts';
import { net_message } from '../src/net.js';

// Server configuration
let serverPort = 4433;
let certFile = 'cert.pem';
let keyFile = 'key.pem';
let directMode = false; // Skip lobby protocol, accept game connections directly

/**
 * Set direct mode (skip lobby protocol)
 * Used by room servers that accept connections directly
 */
export function WT_SetDirectMode(enabled: boolean): void {
	directMode = enabled;
}

// Callback for map changes when joining rooms
let _mapChangeCallback: ((mapName: string) => Promise<void>) | null = null;
let _getCurrentMap: (() => string) | null = null;

/**
 * Set callbacks for map management
 */
export function WT_SetMapCallbacks(
	changeMap: (mapName: string) => Promise<void>,
	getCurrentMap: () => string
): void {
	_mapChangeCallback = changeMap;
	_getCurrentMap = getCurrentMap;
}

// Connection tracking
interface ClientConnection {
	id: number;
	webTransport: WebTransport;
	bidirectionalStream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null;
	reliableWriter: WritableStreamDefaultWriter<Uint8Array> | null;
	reliableReader: ReadableStreamDefaultReader<Uint8Array> | null;
	pendingMessages: Array<{ reliable: boolean; data: Uint8Array }>;
	connected: boolean;
	address: string;
	lastMessageTime: number;
	roomId: string | null;  // Track which room this client is in
}

// Socket structure compatible with Quake's qsocket_t
export interface QSocket {
	next: QSocket | null;
	connecttime: number;
	lastMessageTime: number;
	lastSendTime: number;
	disconnected: boolean;
	canSend: boolean;
	sendNext: boolean;
	driver: number;
	landriver: number;
	socket: number;
	driverdata: ClientConnection | null;
	ackSequence: number;
	sendSequence: number;
	unreliableSendSequence: number;
	sendMessageLength: number;
	sendMessage: Uint8Array;
	receiveSequence: number;
	unreliableReceiveSequence: number;
	receiveMessageLength: number;
	receiveMessage: Uint8Array;
	addr: unknown;
	address: string;
}

// Active sockets
let activeSockets: QSocket | null = null;
let freeSockets: QSocket | null = null;
let numSockets = 0;

// Pending new connections
const pendingConnections: QSocket[] = [];

// QUIC endpoint and listener
let quicEndpoint: Deno.QuicEndpoint | null = null;

// Connection ID counter
let nextConnectionId = 1;

// Room resolver callback (set by main.ts)
type RoomResolver = (roomId: string) => { id: string; map: string } | null;
let roomResolver: RoomResolver | null = null;

/**
 * Set room resolver callback
 */
export function WT_SetRoomResolver(resolver: RoomResolver): void {
	roomResolver = resolver;
}

// Driver level (set by net_main)
let net_driverlevel = 0;

const NET_MAXMESSAGE = 8192;

// Callback for socket allocation (injected from game_server.js)
// This allows using the shared socket pool from net_main.js
let _NET_NewQSocket: (() => QSocket | null) | null = null;

/**
 * Set the socket allocator callback
 */
export function WT_SetSocketAllocator(allocator: () => QSocket | null): void {
	_NET_NewQSocket = allocator;
}

/**
 * Initialize the WebTransport server driver
 */
export function WT_Init(): number {
	Sys_Printf('WebTransport server driver initialized\n');
	return 0;
}

/**
 * Shutdown the WebTransport server driver
 */
export function WT_Shutdown(): void {
	Sys_Printf('WebTransport server driver shutting down\n');

	if (quicEndpoint) {
		quicEndpoint.close();
		quicEndpoint = null;
	}

	// Close all connections
	let sock = activeSockets;
	while (sock) {
		if (sock.driverdata) {
			try {
				sock.driverdata.webTransport.close();
			} catch {
				// Ignore errors during shutdown
			}
		}
		sock = sock.next;
	}
}

// Store cert/key for listen()
let serverCert = '';
let serverKey = '';

/**
 * Start or stop listening for connections
 */
export async function WT_Listen(state: boolean): Promise<void> {
	if (state) {
		if (quicEndpoint) return; // Already listening

		try {
			// Read TLS certificate and key
			serverCert = await Deno.readTextFile(certFile);
			serverKey = await Deno.readTextFile(keyFile);

			// Create QUIC endpoint
			quicEndpoint = new Deno.QuicEndpoint({
				hostname: '0.0.0.0',
				port: serverPort,
			});

			Sys_Printf('WebTransport server listening on port ' + serverPort + '\n');

			// Start accepting connections in background
			_acceptConnections();
		} catch (error) {
			Sys_Printf(
				'Failed to start WebTransport listener: ' +
					(error as Error).message +
					'\n'
			);
		}
	} else {
		if (quicEndpoint) {
			quicEndpoint.close();
			quicEndpoint = null;
			Sys_Printf('WebTransport server stopped listening\n');
		}
	}
}

/**
 * Background task to accept incoming connections
 */
async function _acceptConnections(): Promise<void> {
	if (!quicEndpoint) return;

	try {
		// Get listener from endpoint with TLS options
		const listener = quicEndpoint.listen({
			cert: serverCert,
			key: serverKey,
			alpnProtocols: ['h3'], // HTTP/3 for WebTransport
		});

		// Accept connections using listener.accept() which returns QuicConn directly
		while (quicEndpoint) {
			try {
				Sys_Printf('Waiting for connection...\n');

				// Use listener.accept() to get QuicConn directly
				const conn = await listener.accept();

				const remoteAddr = conn.remoteAddr;
				const address = remoteAddr.hostname + ':' + remoteAddr.port;
				Sys_Printf('Accepted connection from ' + address + '\n');

				// Handle in background
				(async () => {
					try {
						// Upgrade to WebTransport
						Sys_Printf('Upgrading to WebTransport...\n');
						// @ts-ignore - unstable API
						const wt: WebTransport = await Deno.upgradeWebTransport(conn);
						Sys_Printf('WebTransport upgrade successful!\n');

						await _handleWebTransportSession(wt, address);
					} catch (error) {
						Sys_Printf('Connection error: ' + (error as Error).message + '\n');
						try { conn.close(); } catch { /* ignore */ }
					}
				})();
			} catch (error) {
				if (quicEndpoint) {
					Sys_Printf('Accept error: ' + (error as Error).message + '\n');
				}
			}
		}
	} catch (error) {
		if (quicEndpoint) {
			Sys_Printf(
				'Listener error: ' + (error as Error).message + '\n'
			);
		}
	}
}

// Lobby message types (first byte of message)
const LOBBY_LIST = 0x01;    // Request room list
const LOBBY_JOIN = 0x02;    // Join a room
const LOBBY_CREATE = 0x03;  // Create a room
const LOBBY_ROOMS = 0x81;   // Room list response
const LOBBY_ERROR = 0x82;   // Error response

/**
 * Handle an already-upgraded WebTransport session
 */
async function _handleWebTransportSession(wt: WebTransport, address: string): Promise<void> {
	Sys_Printf('Handling WebTransport session from ' + address + '\n');

	try {
		await wt.ready;
		Sys_Printf('WebTransport session ready\n');
		Sys_Printf('Waiting for bidirectional stream from client...\n');

		const clientConn: ClientConnection = {
			id: nextConnectionId++,
			webTransport: wt,
			bidirectionalStream: null,
			reliableWriter: null,
			reliableReader: null,
			pendingMessages: [],
			connected: true,
			address: address,
			lastMessageTime: Date.now(),
			roomId: null,
		};

		// Accept the first bidirectional stream (reliable channel)
		const streamReader = wt.incomingBidirectionalStreams.getReader();
		const { value: stream, done } = await streamReader.read();
		streamReader.releaseLock();

		Sys_Printf('Got stream: done=' + done + ', stream=' + (stream ? 'yes' : 'no') + '\n');

		if (done || !stream) {
			Sys_Printf('Client disconnected before establishing stream\n');
			wt.close();
			return;
		}

		Sys_Printf('Setting up stream reader/writer...\n');
		clientConn.bidirectionalStream = stream;
		clientConn.reliableWriter = stream.writable.getWriter();
		clientConn.reliableReader = stream.readable.getReader();

		// In direct mode (room servers), skip lobby protocol entirely
		if (directMode) {
			Sys_Printf('Direct mode: accepting game connection from %s\n', address);
		} else {
			Sys_Printf('Stream ready, handling lobby protocol...\n');

			// Handle lobby protocol first
			const isGameConnection = await _handleLobbyProtocol(clientConn, wt);
			if (!isGameConnection) {
				return;
			}
		}

		// Create a socket for this game connection
		const sock = _newQSocket();
		if (!sock) {
			Sys_Printf('No free sockets for new connection\n');
			wt.close();
			return;
		}

		sock.address = clientConn.address;
		sock.driverdata = clientConn;
		sock.connecttime = Date.now() / 1000;
		sock.lastMessageTime = Date.now() / 1000;

		pendingConnections.push(sock);
		_startBackgroundReaders(sock, clientConn);

		wt.closed.then(() => {
			Sys_Printf('WebTransport closed: ' + address + '\n');
			clientConn.connected = false;
			sock.disconnected = true;
		}).catch((error) => {
			Sys_Printf('WebTransport error: ' + (error as Error).message + '\n');
			clientConn.connected = false;
			sock.disconnected = true;
		});

	} catch (error) {
		Sys_Printf('Error in WebTransport session: ' + (error as Error).message + '\n');
		try { wt.close(); } catch { /* ignore */ }
	}
}

/**
 * Handle a new incoming QUIC connection
 */
// deno-lint-ignore no-explicit-any
async function _handleNewConnection(conn: any): Promise<void> {
	Sys_Printf('Connection object keys: ' + Object.keys(conn).join(', ') + '\n');
	Sys_Printf('Connection prototype: ' + Object.getPrototypeOf(conn)?.constructor?.name + '\n');

	const remoteAddr = conn.remoteAddr;
	const address = remoteAddr ? (remoteAddr.hostname + ':' + remoteAddr.port) : 'unknown';

	Sys_Printf('New QUIC connection from ' + address + '\n');

	try {
		// Check if Deno.upgradeWebTransport exists
		// @ts-ignore - check for unstable API
		if (typeof Deno.upgradeWebTransport !== 'function') {
			Sys_Printf('ERROR: Deno.upgradeWebTransport is not available!\n');
			Sys_Printf('Make sure you are running Deno 2.2+ with --unstable-net flag\n');
			conn.close?.();
			return;
		}

		Sys_Printf('Calling Deno.upgradeWebTransport...\n');

		// Upgrade QUIC connection to WebTransport
		// This handles the HTTP/3 CONNECT handshake automatically
		// @ts-ignore - Deno.upgradeWebTransport is unstable
		const wt: WebTransport = await Deno.upgradeWebTransport(conn);

		// Wait for WebTransport session to be ready
		await wt.ready;

		Sys_Printf('WebTransport session established with ' + address + '\n');

		const clientConn: ClientConnection = {
			id: nextConnectionId++,
			webTransport: wt,
			bidirectionalStream: null,
			reliableWriter: null,
			reliableReader: null,
			pendingMessages: [],
			connected: true,
			address: address,
			lastMessageTime: Date.now(),
			roomId: null,
		};

		// Accept the first bidirectional stream (reliable channel)
		const streamReader = wt.incomingBidirectionalStreams.getReader();
		const { value: stream, done } = await streamReader.read();
		streamReader.releaseLock();

		if (done || !stream) {
			Sys_Printf('Client disconnected before establishing stream\n');
			wt.close();
			return;
		}

		clientConn.bidirectionalStream = stream;
		clientConn.reliableWriter = stream.writable.getWriter();
		clientConn.reliableReader = stream.readable.getReader();

		// Handle lobby protocol first
		const isGameConnection = await _handleLobbyProtocol(clientConn, wt);
		if (!isGameConnection) {
			// Lobby-only connection (e.g., room list query), already handled
			return;
		}

		// Create a socket for this game connection
		const sock = _newQSocket();
		if (!sock) {
			Sys_Printf('No free sockets for new connection\n');
			wt.close();
			return;
		}

		sock.address = clientConn.address;
		sock.driverdata = clientConn;
		sock.connecttime = Date.now() / 1000;
		sock.lastMessageTime = Date.now() / 1000;

		// Add to pending connections queue
		pendingConnections.push(sock);

		// Start background readers for this connection
		_startBackgroundReaders(sock, clientConn);

		// Handle connection close
		wt.closed.then(() => {
			Sys_Printf('WebTransport closed: ' + address + '\n');
			clientConn.connected = false;
			sock.disconnected = true;
		}).catch((error) => {
			Sys_Printf('WebTransport error: ' + (error as Error).message + '\n');
			clientConn.connected = false;
			sock.disconnected = true;
		});

	} catch (error) {
		Sys_Printf(
			'Error setting up WebTransport: ' + (error as Error).message + '\n'
		);
		try {
			conn.close();
		} catch {
			// Ignore
		}
	}
}

/**
 * Handle lobby protocol messages
 * Returns true if this is a game connection, false if lobby-only
 */
async function _handleLobbyProtocol(
	conn: ClientConnection,
	wt: WebTransport
): Promise<boolean> {
	Sys_Printf('_handleLobbyProtocol: starting\n');
	if (!conn.reliableReader || !conn.reliableWriter) {
		Sys_Printf('_handleLobbyProtocol: no reader/writer!\n');
		return true;
	}

	try {
		// Read first message with a short timeout
		Sys_Printf('_handleLobbyProtocol: reading framed message...\n');
		const msg = await _readFramedMessage(conn.reliableReader);
		Sys_Printf('_handleLobbyProtocol: got message, type=' + (msg ? msg.type : 'null') + ', dataLen=' + (msg ? msg.data.length : 'null') + '\n');
		if (!msg) {
			Sys_Printf('_handleLobbyProtocol: null message, closing\n');
			wt.close();
			return false;
		}

		const msgType = msg.type;
		Sys_Printf('_handleLobbyProtocol: msgType=' + msgType + '\n');

		switch (msgType) {
			case LOBBY_LIST: {
				// Send room list
				const rooms = listRooms();
				const json = JSON.stringify(rooms);
				const data = new TextEncoder().encode(json);

				// Send response: [LOBBY_ROOMS][length:2][json]
				const response = new Uint8Array(3 + data.length);
				response[0] = LOBBY_ROOMS;
				response[1] = data.length & 0xff;
				response[2] = (data.length >> 8) & 0xff;
				response.set(data, 3);

				await conn.reliableWriter.write(response);
				Sys_Printf('Sent room list to ' + conn.address + '\n');

				// Close the writer properly before closing WebTransport
				try {
					await conn.reliableWriter.close();
				} catch {
					// Ignore close errors
				}

				// Small delay to ensure data is flushed before closing transport
				await new Promise(resolve => setTimeout(resolve, 100));
				wt.close();
				return false;
			}

			case LOBBY_JOIN: {
				// Join existing room - room ID is in msg.data
				const roomId = new TextDecoder().decode(msg.data).trim();
				const room = getRoom(roomId);
				if (!room) {
					Sys_Printf('Room not found: ' + roomId + '\n');
					// Send error response
					const errorMsg = 'Room not found. The game may have ended.';
					const errorData = new TextEncoder().encode(errorMsg);
					const response = new Uint8Array(3 + errorData.length);
					response[0] = LOBBY_ERROR;
					response[1] = errorData.length & 0xff;
					response[2] = (errorData.length >> 8) & 0xff;
					response.set(errorData, 3);
					await conn.reliableWriter.write(response);
					await conn.reliableWriter.close().catch(() => {});
					await new Promise(resolve => setTimeout(resolve, 100));
					wt.close();
					return false;
				}
				Sys_Printf('Client joining room: ' + roomId + '\n');

				// Track room membership and update player count
				conn.roomId = roomId;
				updateRoomPlayerCount(roomId, room.playerCount + 1);

				// Check if we need to change map for this room
				if (_mapChangeCallback != null && _getCurrentMap != null) {
					const currentMap = _getCurrentMap();
					if (room.map !== currentMap) {
						Sys_Printf('Changing map from %s to %s for room %s\n', currentMap, room.map, roomId);
						await _mapChangeCallback(room.map);
					}
				}

				// Continue to game connection
				return true;
			}

			case LOBBY_CREATE: {
				// Create new room - JSON config is in msg.data
				const configJson = new TextDecoder().decode(msg.data);
				try {
					const config = JSON.parse(configJson);
					const room = createRoom({
						map: config.map || 'start',
						maxPlayers: config.maxPlayers || 8,
						hostName: config.hostName || 'Player',
					});

					// Check if room creation failed (limit reached)
					if (!room) {
						Sys_Printf('Room creation failed (limit reached)\n');
						// Send error response
						const errorMsg = JSON.stringify({ error: 'Server room limit reached. Try again later.' });
						const errorData = new TextEncoder().encode(errorMsg);
						const response = new Uint8Array(3 + errorData.length);
						response[0] = LOBBY_ROOMS;
						response[1] = errorData.length & 0xff;
						response[2] = (errorData.length >> 8) & 0xff;
						response.set(errorData, 3);
						await conn.reliableWriter.write(response);
						await conn.reliableWriter.close().catch(() => {});
						wt.close();
						return false;
					}

					Sys_Printf('Client created room: ' + room.id + '\n');

					// Load the map for this room (like original Quake's "map" command)
					if (_mapChangeCallback != null && _getCurrentMap != null) {
						const currentMap = _getCurrentMap();
						if (room.map !== currentMap) {
							Sys_Printf('Loading map %s for new room %s\n', room.map, room.id);
							await _mapChangeCallback(room.map);
						}
					}

					// Send the room info back to the client
					const roomJson = JSON.stringify(room);
					const roomData = new TextEncoder().encode(roomJson);
					const response = new Uint8Array(3 + roomData.length);
					response[0] = LOBBY_ROOMS;
					response[1] = roomData.length & 0xff;
					response[2] = (roomData.length >> 8) & 0xff;
					response.set(roomData, 3);

					await conn.reliableWriter.write(response);
					Sys_Printf('Sent room info to host: ' + room.id + '\n');

					// Close after sending (host will reconnect to play)
					try {
						await conn.reliableWriter.close();
					} catch {
						// Ignore close errors
					}
					await new Promise(resolve => setTimeout(resolve, 100));
					wt.close();
					return false;
				} catch (e) {
					Sys_Printf('Invalid room config: ' + (e as Error).message + '\n');
					wt.close();
					return false;
				}
			}

			default:
				// Unknown lobby message or direct game connection
				// Put this message back for the game to process (just the data, not the frame type)
				conn.pendingMessages.push({ reliable: true, data: msg.data });
				return true;
		}
	} catch (error) {
		Sys_Printf('Lobby error: ' + (error as Error).message + '\n');
		return true; // Assume game connection on error
	}
}

/**
 * Start background readers for reliable stream and datagrams
 */
function _startBackgroundReaders(
	sock: QSocket,
	conn: ClientConnection
): void {
	// Read reliable messages
	(async () => {
		try {
			Sys_Printf('Reliable reader started for %s\n', conn.address);
			while (conn.connected && conn.reliableReader) {
				const msg = await _readFramedMessage(conn.reliableReader);
				if (!msg) break;

				// Push just the data, not the frame type (game code expects raw message data)
				Sys_Printf('Received reliable message: type=%d, %d bytes from %s\n', msg.type, msg.data.length, conn.address);
				conn.pendingMessages.push({ reliable: true, data: msg.data });
				conn.lastMessageTime = Date.now();
			}
			Sys_Printf('Reliable reader ended for %s\n', conn.address);
		} catch (error) {
			Sys_Printf('Reliable reader error for %s: %s\n', conn.address, String(error));
			if (conn.connected) {
				conn.connected = false;
				sock.disconnected = true;
			}
		}
	})();

	// Read datagrams (unreliable)
	(async () => {
		try {
			const reader = conn.webTransport.datagrams.readable.getReader();
			Sys_Printf('Datagram reader started for %s\n', conn.address);
			while (conn.connected) {
				const { value, done } = await reader.read();
				if (done) break;
				conn.pendingMessages.push({ reliable: false, data: value });
				conn.lastMessageTime = Date.now();
			}
			reader.releaseLock();
		} catch (error) {
			Sys_Printf('Datagram reader error for %s: %s\n', conn.address, String(error));
		}
	})();
}

/**
 * Read a framed message from the reliable stream
 * Frame format: [type:1][length:2][data:N]
 * Returns: { type: number, data: Uint8Array } or null on error
 */
async function _readFramedMessage(
	reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<{ type: number; data: Uint8Array } | null> {
	Sys_Printf('_readFramedMessage: reading 3-byte header...\n');
	// Read header (3 bytes)
	const header = await _readExact(reader, 3);
	if (!header) {
		Sys_Printf('_readFramedMessage: header read failed (null)\n');
		return null;
	}

	const type = header[0];
	const length = header[1] | (header[2] << 8);
	Sys_Printf('_readFramedMessage: type=' + type + ', length=' + length + '\n');

	if (length === 0) {
		return { type, data: new Uint8Array(0) };
	}

	// Read message data
	Sys_Printf('_readFramedMessage: reading ' + length + ' bytes of data...\n');
	const data = await _readExact(reader, length);
	if (!data) {
		Sys_Printf('_readFramedMessage: data read failed (null)\n');
		return null;
	}

	Sys_Printf('_readFramedMessage: got data, length=' + data.length + '\n');
	return { type, data };
}

// Buffer for leftover bytes from previous reads (per-reader tracking)
const _readerBuffers = new WeakMap<ReadableStreamDefaultReader<Uint8Array>, { data: Uint8Array | null; offset: number }>();

function _getReaderBuffer(reader: ReadableStreamDefaultReader<Uint8Array>): { data: Uint8Array | null; offset: number } {
	let buf = _readerBuffers.get(reader);
	if (!buf) {
		buf = { data: null, offset: 0 };
		_readerBuffers.set(reader, buf);
	}
	return buf;
}

/**
 * Read exactly n bytes from a reader, with buffering for leftover bytes
 */
async function _readExact(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	n: number
): Promise<Uint8Array | null> {
	const result = new Uint8Array(n);
	let offset = 0;
	const buf = _getReaderBuffer(reader);

	// First, use any leftover bytes from previous read
	if (buf.data && buf.offset < buf.data.length) {
		const available = buf.data.length - buf.offset;
		const bytesToCopy = Math.min(available, n);
		result.set(buf.data.subarray(buf.offset, buf.offset + bytesToCopy), 0);
		offset = bytesToCopy;
		buf.offset += bytesToCopy;

		// Clear buffer if fully consumed
		if (buf.offset >= buf.data.length) {
			buf.data = null;
			buf.offset = 0;
		}
	}

	// Read more data if needed
	while (offset < n) {
		const { value, done } = await reader.read();
		if (done) return null;

		const bytesToCopy = Math.min(value.length, n - offset);
		result.set(value.subarray(0, bytesToCopy), offset);
		offset += bytesToCopy;

		// Save leftover bytes for next read
		if (bytesToCopy < value.length) {
			buf.data = value;
			buf.offset = bytesToCopy;
		}
	}

	return result;
}

/**
 * Create a new socket
 * Uses the injected allocator from net_main.js if available (preferred)
 * Otherwise falls back to internal allocation
 */
function _newQSocket(): QSocket | null {
	// If we have an external allocator (from net_main.js), use it
	if (_NET_NewQSocket !== null) {
		const sock = _NET_NewQSocket();
		if (sock !== null) {
			sock.driver = net_driverlevel;
		}
		return sock;
	}

	// Fallback to internal allocation (for standalone testing)
	if (!freeSockets) {
		// Allocate more sockets if needed
		if (numSockets >= 32) return null; // Max sockets

		const sock: QSocket = {
			next: null,
			connecttime: 0,
			lastMessageTime: 0,
			lastSendTime: 0,
			disconnected: false,
			canSend: true,
			sendNext: false,
			driver: net_driverlevel,
			landriver: 0,
			socket: 0,
			driverdata: null,
			ackSequence: 0,
			sendSequence: 0,
			unreliableSendSequence: 0,
			sendMessageLength: 0,
			sendMessage: new Uint8Array(NET_MAXMESSAGE),
			receiveSequence: 0,
			unreliableReceiveSequence: 0,
			receiveMessageLength: 0,
			receiveMessage: new Uint8Array(NET_MAXMESSAGE),
			addr: null,
			address: '',
		};

		numSockets++;
		return sock;
	}

	const sock = freeSockets;
	freeSockets = sock.next;

	// Reset socket state
	sock.next = activeSockets;
	activeSockets = sock;
	sock.disconnected = false;
	sock.canSend = true;
	sock.driverdata = null;

	return sock;
}

/**
 * Free a socket
 */
export function WT_FreeQSocket(sock: QSocket): void {
	// Remove from active list
	if (sock === activeSockets) {
		activeSockets = sock.next;
	} else {
		let s = activeSockets;
		while (s) {
			if (s.next === sock) {
				s.next = sock.next;
				break;
			}
			s = s.next;
		}
	}

	// Add to free list
	sock.next = freeSockets;
	freeSockets = sock;
	sock.disconnected = true;
}

/**
 * Search for hosts (server doesn't search)
 */
export function WT_SearchForHosts(_xmit: boolean): void {
	// Server doesn't search for other servers
}

/**
 * Connect (server doesn't connect out)
 */
export function WT_Connect(_host: string): null {
	// Server doesn't connect to other servers
	return null;
}

/**
 * Check for new incoming connections
 */
export function WT_CheckNewConnections(): QSocket | null {
	if (pendingConnections.length === 0) return null;
	return pendingConnections.shift()!;
}

/**
 * Get a message from a socket
 */
export function WT_QGetMessage(sock: QSocket): number {
	const conn = sock.driverdata;
	if (!conn) return -1;

	if (!conn.connected && conn.pendingMessages.length === 0) {
		return -1;
	}

	if (conn.pendingMessages.length === 0) {
		return 0;
	}

	// Get next message
	const msg = conn.pendingMessages.shift()!;

	// Copy to net_message
	net_message.cursize = 0;
	for (let i = 0; i < msg.data.length && i < net_message.maxsize; i++) {
		net_message.data[i] = msg.data[i];
		net_message.cursize++;
	}

	sock.lastMessageTime = Date.now() / 1000;

	return msg.reliable ? 1 : 2;
}

/**
 * Send a reliable message
 */
export function WT_QSendMessage(
	sock: QSocket,
	data: { data: Uint8Array; cursize: number }
): number {
	const conn = sock.driverdata;
	if (!conn || !conn.connected || !conn.reliableWriter) {
		Sys_Printf('WT_QSendMessage: no connection/writer, returning -1\n');
		return -1;
	}

	Sys_Printf('WT_QSendMessage: sending %d bytes to %s\n', data.cursize, conn.address);

	// Frame the message
	const frame = new Uint8Array(3 + data.cursize);
	frame[0] = 1; // reliable type
	frame[1] = data.cursize & 0xff;
	frame[2] = (data.cursize >> 8) & 0xff;
	frame.set(data.data.subarray(0, data.cursize), 3);

	// Log first few bytes for debugging
	const preview = Array.from(data.data.subarray(0, Math.min(16, data.cursize))).map(b => b.toString(16).padStart(2, '0')).join(' ');
	Sys_Printf('WT_QSendMessage: frame header [%d, %d, %d], data preview: %s\n', frame[0], frame[1], frame[2], preview);

	// Send asynchronously
	conn.reliableWriter.write(frame).then(() => {
		Sys_Printf('WT_QSendMessage: write completed successfully\n');
	}).catch((err) => {
		Sys_Printf('WT_QSendMessage: write FAILED: %s\n', (err as Error).message);
		conn.connected = false;
		sock.disconnected = true;
	});

	return 1;
}

/**
 * Send an unreliable message via datagrams
 */
let _lastSendLogTime = 0;
export function WT_SendUnreliableMessage(
	sock: QSocket,
	data: { data: Uint8Array; cursize: number }
): number {
	const conn = sock.driverdata;
	if (!conn || !conn.connected) return -1;

	// Copy the data
	const dgram = new Uint8Array(data.cursize);
	dgram.set(data.data.subarray(0, data.cursize));

	// Debug: log sending datagram (rate limited)
	const now = Date.now();
	if (now - _lastSendLogTime > 1000) {
		Sys_Printf('WT_SendUnreliableMessage: sending %d bytes to %s, cmd=%d\n', data.cursize, conn.address, dgram[0]);
		_lastSendLogTime = now;
	}

	// Send via datagram
	const writer = conn.webTransport.datagrams.writable.getWriter();
	writer.write(dgram).catch((error) => {
		Sys_Printf('WT_SendUnreliableMessage: write failed: %s\n', String(error));
	}).finally(() => {
		writer.releaseLock();
	});

	return 1;
}

/**
 * Check if we can send a reliable message
 */
export function WT_CanSendMessage(sock: QSocket): boolean {
	const conn = sock.driverdata;
	return conn !== null && conn.connected;
}

/**
 * Check if we can send an unreliable message
 */
export function WT_CanSendUnreliableMessage(sock: QSocket): boolean {
	const conn = sock.driverdata;
	return conn !== null && conn.connected;
}

/**
 * Close a connection
 */
export function WT_Close(sock: QSocket): void {
	const conn = sock.driverdata;
	if (!conn) return;

	conn.connected = false;

	// Decrement player count if client was in a room
	if (conn.roomId) {
		const room = getRoom(conn.roomId);
		if (room && room.playerCount > 0) {
			updateRoomPlayerCount(conn.roomId, room.playerCount - 1);
		}
		conn.roomId = null;
	}

	try {
		if (conn.reliableWriter) {
			conn.reliableWriter.close().catch(() => {});
		}
		conn.webTransport.close();
	} catch {
		// Ignore errors during close
	}

	Sys_Printf('Connection closed: ' + conn.address + '\n');
	sock.driverdata = null;
}

/**
 * Configure the server
 */
export function WT_SetConfig(config: {
	port?: number;
	certFile?: string;
	keyFile?: string;
}): void {
	if (config.port) serverPort = config.port;
	if (config.certFile) certFile = config.certFile;
	if (config.keyFile) keyFile = config.keyFile;
}

/**
 * Set driver level (called by net_main)
 */
export function WT_SetDriverLevel(level: number): void {
	net_driverlevel = level;
}

/**
 * Export socket type for external use
 */
export type { QSocket as qsocket_t };
