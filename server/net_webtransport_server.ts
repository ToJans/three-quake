// WebTransport server driver for Deno
// Handles incoming client connections via WebTransport/HTTP3

import { Sys_Printf } from './sys_server.ts';
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
let _setMaxClients: ((maxClients: number) => void) | null = null;

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

/**
 * Set callback for changing max clients
 */
export function WT_SetMaxClientsCallback(setMaxClients: (maxClients: number) => void): void {
	_setMaxClients = setMaxClients;
}

// Connection tracking
interface ClientConnection {
	id: number;
	webTransport: WebTransport;
	bidirectionalStream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } | null;
	reliableWriter: WritableStreamDefaultWriter<Uint8Array> | null;
	reliableReader: ReadableStreamDefaultReader<Uint8Array> | null;
	datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null;  // Cached datagram writer
	pendingMessages: Array<{ reliable: boolean; data: Uint8Array }>;
	connected: boolean;
	address: string;
	lastMessageTime: number;
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

// Driver level (set by net_main)
let net_driverlevel = 0;

const NET_MAXMESSAGE = 8192;

// Callback for socket allocation (injected from game_server.js)
// This allows using the shared socket pool from net_main.js
let _NET_NewQSocket: (() => QSocket | null) | null = null;
let _NET_FreeQSocket: ((sock: QSocket) => void) | null = null;

/**
 * Set the socket allocator callback
 */
export function WT_SetSocketAllocator(allocator: () => QSocket | null): void {
	_NET_NewQSocket = allocator;
}

/**
 * Set the socket freer callback
 */
export function WT_SetSocketFreer(freer: (sock: QSocket) => void): void {
	_NET_FreeQSocket = freer;
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
				// Use listener.accept() to get QuicConn directly
				const conn = await listener.accept();

				const remoteAddr = conn.remoteAddr;
				const address = remoteAddr.hostname + ':' + remoteAddr.port;
				Sys_Printf('Connection from ' + address + '\n');

				// Handle in background
				(async () => {
					try {
						// Upgrade to WebTransport
						// @ts-ignore - unstable API
						const wt: WebTransport = await Deno.upgradeWebTransport(conn);
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

/**
 * Handle an already-upgraded WebTransport session
 */
async function _handleWebTransportSession(wt: WebTransport, address: string): Promise<void> {
	try {
		await wt.ready;

		const clientConn: ClientConnection = {
			id: nextConnectionId++,
			webTransport: wt,
			bidirectionalStream: null,
			reliableWriter: null,
			reliableReader: null,
			datagramWriter: null,  // Cached datagram writer - initialized on first send
			pendingMessages: [],
			connected: true,
			address: address,
			lastMessageTime: Date.now(),
		};

		// Accept the first bidirectional stream (reliable channel)
		const streamReader = wt.incomingBidirectionalStreams.getReader();
		const { value: stream, done } = await streamReader.read();
		streamReader.releaseLock();

		if (done || !stream) {
			wt.close();
			return;
		}
		clientConn.bidirectionalStream = stream;
		clientConn.reliableWriter = stream.writable.getWriter();
		clientConn.reliableReader = stream.readable.getReader();

		// Create a socket for this game connection
		// Note: With multi-process architecture, lobby protocol is handled by lobby_server.js
		// Game servers (this code) always run in direct mode
		const sock = _newQSocket();
		if (!sock) {
			Sys_Printf('No free sockets for %s\n', address);
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
			_handleConnectionDeath(sock, clientConn);
		}).catch(() => {
			_handleConnectionDeath(sock, clientConn);
		});

	} catch (error) {
		Sys_Printf('Session error for %s: %s\n', address, (error as Error).message);
		try { wt.close(); } catch { /* ignore */ }
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
			while (conn.connected && conn.reliableReader) {
				const msg = await _readFramedMessage(conn.reliableReader);
				if (!msg) break;

				// Push just the data, not the frame type (game code expects raw message data)
				conn.pendingMessages.push({ reliable: true, data: msg.data });
				conn.lastMessageTime = Date.now();
			}
		} catch (error) {
			if (conn.connected) {
				Sys_Printf('Reliable reader error for %s: %s\n', conn.address, String(error));
				conn.connected = false;
				sock.disconnected = true;
			}
		}
	})();

	// Read datagrams (unreliable)
	(async () => {
		try {
			const reader = conn.webTransport.datagrams.readable.getReader();
			while (conn.connected) {
				const { value, done } = await reader.read();
				if (done) break;
				conn.pendingMessages.push({ reliable: false, data: value });
				conn.lastMessageTime = Date.now();
			}
			reader.releaseLock();
		} catch {
			// Datagram reader ended - normal on disconnect
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
	// Read header (3 bytes)
	const header = await _readExact(reader, 3);
	if (!header) {
		return null;
	}

	const type = header[0];
	const length = header[1] | (header[2] << 8);

	if (length === 0) {
		return { type, data: new Uint8Array(0) };
	}

	// Read message data
	const data = await _readExact(reader, length);
	if (!data) {
		return null;
	}

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
 * Handle connection death (WebTransport closed or errored)
 *
 * Per original Quake design (net_main.c):
 * - sock.disconnected is ONLY set by NET_FreeQSocket (after freeing)
 * - We should NOT set it here for sockets assigned to clients
 * - Just set conn.connected = false, which makes WT_QGetMessage return -1
 * - This triggers SV_DropClient -> NET_Close -> WT_Close + NET_FreeQSocket
 *
 * Exception: sockets still in pendingConnections were never assigned to a client,
 * so we must clean them up directly (including setting disconnected and freeing).
 */
function _handleConnectionDeath(sock: QSocket, conn: ClientConnection): void {
	conn.connected = false;

	// Check if socket is still in pending queue (never assigned to a client)
	const pendingIdx = pendingConnections.indexOf(sock);
	if (pendingIdx !== -1) {
		// Socket never made it to a client slot - clean up directly
		pendingConnections.splice(pendingIdx, 1);
		sock.disconnected = true;  // Only set for pending sockets

		// Free the socket back to the pool (only for pending sockets)
		if (_NET_FreeQSocket !== null) {
			_NET_FreeQSocket(sock);
		}
	}
	// For sockets already assigned to clients:
	// - DON'T set sock.disconnected = true (would skip NET_Close cleanup)
	// - conn.connected = false makes WT_QGetMessage return -1
	// - This triggers SV_DropClient -> NET_Close -> WT_Close + NET_FreeQSocket
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
	// Filter out any disconnected sockets first
	while (pendingConnections.length > 0) {
		const sock = pendingConnections[0];
		if (sock.disconnected) {
			// Socket died before we could process it, remove and continue
			pendingConnections.shift();
			Sys_Printf('Skipped disconnected socket in pending queue\n');
			continue;
		}
		return pendingConnections.shift()!;
	}
	return null;
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
		return -1;
	}

	// Frame the message
	const frame = new Uint8Array(3 + data.cursize);
	frame[0] = 1; // reliable type
	frame[1] = data.cursize & 0xff;
	frame[2] = (data.cursize >> 8) & 0xff;
	frame.set(data.data.subarray(0, data.cursize), 3);

	// Send asynchronously
	conn.reliableWriter.write(frame).catch((err) => {
		Sys_Printf('WT_QSendMessage: write FAILED: %s\n', (err as Error).message);
		conn.connected = false;
		sock.disconnected = true;
	});

	return 1;
}

/**
 * Send an unreliable message via datagrams
 */
export function WT_SendUnreliableMessage(
	sock: QSocket,
	data: { data: Uint8Array; cursize: number }
): number {
	const conn = sock.driverdata;
	if (!conn || !conn.connected) return -1;

	// Copy the data
	const dgram = new Uint8Array(data.cursize);
	dgram.set(data.data.subarray(0, data.cursize));

	// Get or create cached datagram writer (avoids creating new writer every frame at 72Hz)
	if (conn.datagramWriter === null) {
		conn.datagramWriter = conn.webTransport.datagrams.writable.getWriter();
	}

	// Send via datagram
	conn.datagramWriter.write(dgram).catch(() => {
		// Silently fail - datagrams are unreliable by design
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

	try {
		// Close cached writers
		if (conn.reliableWriter) {
			conn.reliableWriter.close().catch(() => {});
			conn.reliableWriter = null;
		}
		if (conn.datagramWriter) {
			conn.datagramWriter.close().catch(() => {});
			conn.datagramWriter = null;
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
