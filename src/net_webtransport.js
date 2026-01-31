// WebTransport network driver for multiplayer support
// New module for browser-based WebTransport client connections

import { Con_Printf, Con_DPrintf, SZ_Clear, SZ_Write } from './common.js';
import { NET_NewQSocket, NET_FreeQSocket } from './net_main.js';
import {
	NET_MAXMESSAGE,
	net_message,
	net_driverlevel,
	hostCacheCount, set_hostCacheCount,
	hostcache
} from './net.js';
import { M_Menu_Main_f } from './menu.js';
import { set_key_dest, key_menu } from './keys.js';

// WebTransport connection state
let wt_initialized = false;

// Timeout for lobby room join operations (in milliseconds)
// This should be long enough for slow connections but short enough to not hang indefinitely
const ROOM_JOIN_TIMEOUT_MS = 10000; // 10 seconds

// Active connections
const wt_connections = new Map(); // qsocket_t -> WebTransportConnection

// Pending incoming connections (for server mode - not used in browser client)
const wt_pendingConnections = [];

// Connection data structure
class WebTransportConnection {

	constructor( transport ) {

		this.transport = transport;
		this.reliableStream = null;
		this.reliableWriter = null;
		this.reliableReader = null;
		this.datagramWriter = null;
		this.datagramReader = null;
		this.pendingMessages = []; // { reliable: boolean, data: Uint8Array }
		this.connected = false;
		this.error = null;

	}

}

/*
=============
WT_Init

Initialize the WebTransport driver
=============
*/
export function WT_Init() {

	// Check if WebTransport is available in this browser
	if ( typeof WebTransport === 'undefined' ) {

		Con_Printf( 'WebTransport not available in this browser\n' );
		return - 1;

	}

	wt_initialized = true;
	Con_Printf( 'WebTransport driver initialized\n' );

	// Send clean disconnect when page unloads (browser only)
	if ( typeof window !== 'undefined' ) {

		window.addEventListener( 'pagehide', _onPageHide );
		window.addEventListener( 'beforeunload', _onPageHide );

	}

	return 0;

}

/**
 * Handle page unload - send clean disconnect to server
 */
function _onPageHide() {

	for ( const [ sock, conn ] of wt_connections ) {

		try {

			// Send clc_disconnect message before closing
			if ( conn.reliableWriter != null ) {

				const msg = new Uint8Array( 4 );
				msg[ 0 ] = 1; // frame type: game message
				msg[ 1 ] = 1; // length low byte
				msg[ 2 ] = 0; // length high byte
				msg[ 3 ] = 2; // clc_disconnect
				conn.reliableWriter.write( msg );

			}

			// Close the transport (sends QUIC CONNECTION_CLOSE)
			conn.transport.close();

		} catch ( e ) {

			// Ignore errors during shutdown

		}

	}

	wt_connections.clear();

}

/*
=============
WT_Shutdown

Shutdown the WebTransport driver
=============
*/
export function WT_Shutdown() {

	// Close all active connections
	for ( const [ sock, conn ] of wt_connections ) {

		try {

			conn.transport.close();

		} catch ( e ) {

			// Ignore errors during shutdown

		}

	}

	wt_connections.clear();
	wt_initialized = false;

}

/*
=============
WT_Listen

Enable/disable listening for new connections
Browser clients don't listen, only servers do
=============
*/
export function WT_Listen( state ) {

	// Browser clients don't listen for connections
	// This is a no-op on the client side

}

/*
=============
WT_SearchForHosts

Search for available servers
=============
*/
export function WT_SearchForHosts( xmit ) {

	// WebTransport doesn't have broadcast discovery
	// Use WT_QueryRooms instead for server list

}

// Lobby message types (must match server)
const LOBBY_LIST = 0x01;
const LOBBY_JOIN = 0x02;
const LOBBY_CREATE = 0x03;
const LOBBY_ROOMS = 0x81;
const LOBBY_ERROR = 0x82;

/*
=============
WT_QueryRooms

Query available rooms from a WebTransport server
Returns a Promise that resolves to an array of room objects
=============
*/
export async function WT_QueryRooms( serverUrl ) {

	if ( ! wt_initialized ) {

		throw new Error( 'WebTransport not initialized' );

	}

	// Parse the server URL
	let url = serverUrl;

	if ( ! url.includes( '://' ) ) {

		url = 'https://' + url;

	} else if ( url.startsWith( 'wt://' ) ) {

		url = 'https://' + url.substring( 5 );

	} else if ( url.startsWith( 'wts://' ) ) {

		url = 'https://' + url.substring( 6 );

	}

	Con_DPrintf( 'Querying rooms from ' + url + '\n' );

	// Clear any leftover buffer from previous connection
	_readBuffer = null;
	_readBufferOffset = 0;

	let transport = null;

	try {

		// Create the WebTransport connection
		transport = new WebTransport( url );
		await transport.ready;

		// Create bidirectional stream
		const stream = await transport.createBidirectionalStream();
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		// Send LOBBY_LIST request: [type:1][length:2][data:0]
		const request = new Uint8Array( 3 );
		request[ 0 ] = LOBBY_LIST;
		request[ 1 ] = 0; // length low byte
		request[ 2 ] = 0; // length high byte
		await writer.write( request );

		// Read response header
		const headerResult = await _readExact( reader, 3 );
		if ( ! headerResult ) {

			throw new Error( 'Connection closed' );

		}

		const msgType = headerResult[ 0 ];
		const msgLen = headerResult[ 1 ] | ( headerResult[ 2 ] << 8 );

		if ( msgType !== LOBBY_ROOMS ) {

			throw new Error( 'Unexpected response type: ' + msgType );

		}

		// Read room data
		let rooms = [];
		if ( msgLen > 0 ) {

			const data = await _readExact( reader, msgLen );
			if ( data ) {

				const json = new TextDecoder().decode( data );
				rooms = JSON.parse( json );

			}

		}

		// Clean up
		writer.close().catch( () => {} );
		transport.close();

		Con_DPrintf( 'Got ' + rooms.length + ' rooms\n' );
		return rooms;

	} catch ( e ) {

		Con_Printf( 'WT_QueryRooms error: ' + e.message + '\n' );
		if ( transport ) {

			try { transport.close(); } catch ( e2 ) { /* ignore */ }

		}

		throw e;

	}

}

/*
=============
WT_CreateRoom

Create a new room on the WebTransport server
Returns a Promise that resolves to the room object with ID
=============
*/
export async function WT_CreateRoom( serverUrl, config ) {

	if ( ! wt_initialized ) {

		throw new Error( 'WebTransport not initialized' );

	}

	// Parse the server URL
	let url = serverUrl;

	if ( ! url.includes( '://' ) ) {

		url = 'https://' + url;

	} else if ( url.startsWith( 'wt://' ) ) {

		url = 'https://' + url.substring( 5 );

	} else if ( url.startsWith( 'wts://' ) ) {

		url = 'https://' + url.substring( 6 );

	}

	Con_DPrintf( 'Creating room on ' + url + '\n' );

	// Clear any leftover buffer
	_readBuffer = null;
	_readBufferOffset = 0;

	let transport = null;

	try {

		// Create the WebTransport connection
		console.log( 'WT_CreateRoom: Creating WebTransport connection...' );
		transport = new WebTransport( url );
		await transport.ready;
		console.log( 'WT_CreateRoom: Transport ready' );

		// Create bidirectional stream
		console.log( 'WT_CreateRoom: Creating bidirectional stream...' );
		const stream = await transport.createBidirectionalStream();
		console.log( 'WT_CreateRoom: Stream created' );
		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		// Send LOBBY_CREATE request: [type:1][length:2][json config]
		const configJson = JSON.stringify( config );
		console.log( 'WT_CreateRoom: Sending config:', configJson );
		const configData = new TextEncoder().encode( configJson );
		const request = new Uint8Array( 3 + configData.length );
		request[ 0 ] = LOBBY_CREATE;
		request[ 1 ] = configData.length & 0xff;
		request[ 2 ] = ( configData.length >> 8 ) & 0xff;
		request.set( configData, 3 );
		console.log( 'WT_CreateRoom: Writing request...' );
		await writer.write( request );
		console.log( 'WT_CreateRoom: Request written, waiting for response...' );

		// Read response header
		const headerResult = await _readExact( reader, 3 );
		console.log( 'WT_CreateRoom: Got header:', headerResult );
		if ( ! headerResult ) {

			throw new Error( 'Connection closed' );

		}

		const msgType = headerResult[ 0 ];
		const msgLen = headerResult[ 1 ] | ( headerResult[ 2 ] << 8 );

		// Expect LOBBY_ROOMS response with the created room
		if ( msgType !== LOBBY_ROOMS ) {

			throw new Error( 'Unexpected response type: ' + msgType );

		}

		// Read room data
		let room = null;
		if ( msgLen > 0 ) {

			const data = await _readExact( reader, msgLen );
			if ( data ) {

				const json = new TextDecoder().decode( data );
				room = JSON.parse( json );

			}

		}

		// Clean up
		writer.close().catch( () => {} );
		transport.close();

		Con_Printf( 'Created room: ' + ( room ? room.id : 'unknown' ) + '\n' );
		return room;

	} catch ( e ) {

		Con_Printf( 'WT_CreateRoom error: ' + e.message + '\n' );
		if ( transport ) {

			try { transport.close(); } catch ( e2 ) { /* ignore */ }

		}

		throw e;

	}

}

/*
=============
_readExact

Read exactly n bytes from a stream reader
=============
*/
// Buffered reader state - stores leftover bytes between reads
let _readBuffer = null;
let _readBufferOffset = 0;

async function _readExact( reader, n ) {

	const result = new Uint8Array( n );
	let offset = 0;

	// First, use any leftover bytes from previous read
	if ( _readBuffer && _readBufferOffset < _readBuffer.length ) {

		const available = _readBuffer.length - _readBufferOffset;
		const bytesToCopy = Math.min( available, n );
		result.set( _readBuffer.subarray( _readBufferOffset, _readBufferOffset + bytesToCopy ), 0 );
		offset = bytesToCopy;
		_readBufferOffset += bytesToCopy;

		// Clear buffer if fully consumed
		if ( _readBufferOffset >= _readBuffer.length ) {

			_readBuffer = null;
			_readBufferOffset = 0;

		}

	}

	// Read more if needed
	while ( offset < n ) {

		const { value, done } = await reader.read();
		if ( done ) {

			return null;

		}

		const bytesToCopy = Math.min( value.length, n - offset );
		result.set( value.subarray( 0, bytesToCopy ), offset );
		offset += bytesToCopy;

		// Save leftover bytes for next read
		if ( bytesToCopy < value.length ) {

			_readBuffer = value;
			_readBufferOffset = bytesToCopy;

		}

	}

	return result;

}

/*
=============
WT_Connect

Connect to a remote server via WebTransport
host can be:
  - "wt://hostname:port" or "wts://hostname:port"
  - "hostname:port" (defaults to wts://)
  - Full URL like "https://hostname:port/quake"
  - URL with room parameter: "https://hostname:port?room=ROOMID"
=============
*/
export async function WT_Connect( host ) {

	if ( ! wt_initialized ) {

		Con_Printf( 'WebTransport not initialized\n' );
		return null;

	}

	// Parse the host string to build the WebTransport URL
	let url = host;

	if ( ! url.includes( '://' ) ) {

		// Default to HTTPS (required for WebTransport)
		url = 'https://' + url;

	} else if ( url.startsWith( 'wt://' ) ) {

		// Convert wt:// to https://
		url = 'https://' + url.substring( 5 );

	} else if ( url.startsWith( 'wts://' ) ) {

		// Convert wts:// to https://
		url = 'https://' + url.substring( 6 );

	}

	// Extract room ID from URL if present
	let roomId = null;
	try {

		const urlObj = new URL( url );
		roomId = urlObj.searchParams.get( 'room' );
		// Remove room param from URL for the actual connection
		// (we send it via the lobby protocol instead)
		if ( roomId ) {

			urlObj.searchParams.delete( 'room' );
			url = urlObj.toString();

		}

	} catch ( e ) {

		// URL parsing failed, continue without room extraction

	}

	Con_Printf( 'WebTransport connecting to ' + url + ( roomId ? ' (room: ' + roomId + ')' : '' ) + '\n' );

	try {

		// Create the WebTransport connection
		const transport = new WebTransport( url );

		// Wait for connection to be ready
		await transport.ready;

		Con_Printf( 'WebTransport connection established\n' );

		// Create a new socket
		const sock = NET_NewQSocket();
		if ( ! sock ) {

			Con_Printf( 'WT_Connect: no free sockets\n' );
			transport.close();
			return null;

		}

		sock.address = host;
		sock.driver = net_driverlevel;

		// Create connection data
		const conn = new WebTransportConnection( transport );
		conn.connected = true;

		// Create bidirectional stream for reliable messages
		conn.reliableStream = await transport.createBidirectionalStream();
		conn.reliableWriter = conn.reliableStream.writable.getWriter();
		conn.reliableReader = conn.reliableStream.readable.getReader();

		// If joining a room, send LOBBY_JOIN message first
		if ( roomId ) {

			Con_Printf( 'Sending LOBBY_JOIN for room: ' + roomId + '\n' );
			const roomData = new TextEncoder().encode( roomId );
			const request = new Uint8Array( 3 + roomData.length );
			request[ 0 ] = LOBBY_JOIN;
			request[ 1 ] = roomData.length & 0xff;
			request[ 2 ] = ( roomData.length >> 8 ) & 0xff;
			request.set( roomData, 3 );
			await conn.reliableWriter.write( request );
			Con_Printf( 'LOBBY_JOIN sent\n' );

			// Read first framed message - could be LOBBY_ERROR, LOBBY_ROOMS (redirect), or game data
			// Use a race with timeout in case server is slow
			const firstMsg = await Promise.race( [
				_WT_ReadFramedMessageWithType( conn.reliableReader ),
				new Promise( resolve => setTimeout( () => resolve( null ), ROOM_JOIN_TIMEOUT_MS ) )
			] );

			// Handle timeout - server didn't respond in time
			if ( firstMsg === null ) {

				Con_Printf( 'Room join timed out after %d seconds\n', ROOM_JOIN_TIMEOUT_MS / 1000 );
				transport.close();
				NET_FreeQSocket( sock );

				// Clear room from URL so refresh doesn't retry
				if ( typeof history !== 'undefined' ) {

					const cleanUrl = window.location.origin + window.location.pathname;
					history.replaceState( null, '', cleanUrl );

				}

				// Return to main menu and show error message
				M_Menu_Main_f();
				set_key_dest( key_menu );
				Con_Printf( '\nConnection timed out - server may be offline\n\n' );

				return null;

			}

			if ( firstMsg.type === LOBBY_ERROR ) {

				const errMsg = new TextDecoder().decode( firstMsg.data );
				Con_Printf( 'Join failed: ' + errMsg + '\n' );
				transport.close();
				NET_FreeQSocket( sock );

				// Clear room from URL so refresh doesn't retry
				if ( typeof history !== 'undefined' ) {

					const cleanUrl = window.location.origin + window.location.pathname;
					history.replaceState( null, '', cleanUrl );

				}

				// Return to main menu and show error message
				M_Menu_Main_f();
				set_key_dest( key_menu );
				Con_Printf( '\n%s\n\n', errMsg );

				return null;

			}

			// Check if lobby is redirecting us to a room server on a different port
			if ( firstMsg.type === LOBBY_ROOMS && firstMsg.data && firstMsg.data.length > 0 ) {

				try {

					const roomInfo = JSON.parse( new TextDecoder().decode( firstMsg.data ) );
					if ( roomInfo.port && roomInfo.port !== 4433 ) {

						// Close lobby connection and redirect to room server
						Con_Printf( 'Redirecting to room server on port ' + roomInfo.port + '\n' );
						transport.close();
						NET_FreeQSocket( sock );

						// Build new URL with room's port (no room parameter - direct connection)
						const urlObj = new URL( url );
						urlObj.port = String( roomInfo.port );
						const roomUrl = urlObj.toString();

						// Connect directly to room server
						return await _WT_ConnectDirect( roomUrl, host );

					}

				} catch ( e ) {

					Con_Printf( 'Failed to parse room redirect: ' + e.message + '\n' );

				}

			}

			// If we got game data, put it back for the game to read
			if ( firstMsg.data && firstMsg.data.length > 0 ) {

				conn.pendingMessages.push( { reliable: true, data: firstMsg.data } );

			}

		}

		// Set up datagram streams for unreliable messages
		conn.datagramWriter = transport.datagrams.writable.getWriter();
		conn.datagramReader = transport.datagrams.readable.getReader();

		// Store connection
		sock.driverdata = conn;
		wt_connections.set( sock, conn );

		// Start background readers
		_WT_StartBackgroundReaders( sock, conn );

		// Handle connection close
		transport.closed.then( () => {

			Con_Printf( 'WebTransport connection closed\n' );
			conn.connected = false;
			sock.disconnected = true;

		} ).catch( ( error ) => {

			Con_Printf( 'WebTransport connection error: ' + error.message + '\n' );
			conn.connected = false;
			conn.error = error;
			sock.disconnected = true;

		} );

		return sock;

	} catch ( error ) {

		Con_Printf( 'WebTransport connect failed: ' + error.message + '\n' );

		// Clear room from URL so refresh doesn't retry
		if ( typeof history !== 'undefined' ) {

			const cleanUrl = window.location.origin + window.location.pathname;
			history.replaceState( null, '', cleanUrl );

		}

		// Return to main menu
		M_Menu_Main_f();
		set_key_dest( key_menu );

		return null;

	}

}

/*
=============
_WT_ConnectDirect

Connect directly to a room server (no lobby protocol)
Used when redirected from lobby to a room server on a different port
=============
*/
async function _WT_ConnectDirect( url, originalHost ) {

	Con_Printf( 'WebTransport connecting directly to ' + url + '\n' );

	try {

		// Create the WebTransport connection
		const transport = new WebTransport( url );

		// Wait for connection to be ready
		await transport.ready;

		Con_Printf( 'WebTransport direct connection established\n' );

		// Create a new socket
		const sock = NET_NewQSocket();
		if ( ! sock ) {

			Con_Printf( '_WT_ConnectDirect: no free sockets\n' );
			transport.close();
			return null;

		}

		sock.address = originalHost;
		sock.driver = net_driverlevel;

		// Create connection data
		const conn = new WebTransportConnection( transport );
		conn.connected = true;

		// Create bidirectional stream for reliable messages
		conn.reliableStream = await transport.createBidirectionalStream();
		conn.reliableWriter = conn.reliableStream.writable.getWriter();
		conn.reliableReader = conn.reliableStream.readable.getReader();

		// Room servers in direct mode don't need lobby protocol
		// Just set up the connection and let the game proceed

		// Set up datagram streams for unreliable messages
		conn.datagramWriter = transport.datagrams.writable.getWriter();
		conn.datagramReader = transport.datagrams.readable.getReader();

		// Store connection
		sock.driverdata = conn;
		wt_connections.set( sock, conn );

		// Start background readers
		_WT_StartBackgroundReaders( sock, conn );

		// Handle connection close
		transport.closed.then( () => {

			Con_Printf( 'WebTransport connection closed\n' );
			conn.connected = false;
			sock.disconnected = true;

		} ).catch( ( error ) => {

			Con_Printf( 'WebTransport connection error: ' + error.message + '\n' );
			conn.connected = false;
			conn.error = error;
			sock.disconnected = true;

		} );

		return sock;

	} catch ( error ) {

		Con_Printf( 'WebTransport direct connect failed: ' + error.message + '\n' );

		// Clear room from URL so refresh doesn't retry
		if ( typeof history !== 'undefined' ) {

			const cleanUrl = window.location.origin + window.location.pathname;
			history.replaceState( null, '', cleanUrl );

		}

		// Return to main menu
		M_Menu_Main_f();
		set_key_dest( key_menu );

		return null;

	}

}

/*
=============
_WT_StartBackgroundReaders

Start background tasks to read from reliable stream and datagrams
=============
*/
function _WT_StartBackgroundReaders( sock, conn ) {

	// Read reliable messages in background
	( async () => {

		try {

			while ( conn.connected ) {

				const msg = await _WT_ReadFramedMessage( conn.reliableReader );
				if ( ! msg ) break;

				conn.pendingMessages.push( { reliable: true, data: msg } );

			}

		} catch ( error ) {

			if ( conn.connected ) {

				Con_DPrintf( 'Reliable reader error: ' + error.message + '\n' );
				conn.error = error;

			}

		}

	} )();

	// Read datagrams in background
	( async () => {

		Con_DPrintf( 'Client datagram reader started\n' );

		try {

			while ( conn.connected ) {

				const { value, done } = await conn.datagramReader.read();
				if ( done ) break;

				conn.pendingMessages.push( { reliable: false, data: value } );

			}

		} catch ( error ) {

			if ( conn.connected ) {

				Con_DPrintf( 'Datagram reader error: ' + error.message + '\n' );

			}

		}

	} )();

}

/*
=============
_WT_ReadFramedMessage

Read a framed message from the reliable stream
Frame format: [type:1][length:2][data:N]
=============
*/
async function _WT_ReadFramedMessage( reader ) {

	// Read header (3 bytes: type + length)
	const header = await _WT_ReadExact( reader, 3 );
	if ( ! header ) return null;

	const type = header[ 0 ];
	const length = header[ 1 ] | ( header[ 2 ] << 8 );

	if ( length === 0 ) return new Uint8Array( 0 );

	// Read message data
	const data = await _WT_ReadExact( reader, length );
	return data;

}

/*
=============
_WT_ReadFramedMessageWithType

Read a framed message and return both type and data
=============
*/
async function _WT_ReadFramedMessageWithType( reader ) {

	// Read header (3 bytes: type + length)
	const header = await _WT_ReadExact( reader, 3 );
	if ( ! header ) return null;

	const type = header[ 0 ];
	const length = header[ 1 ] | ( header[ 2 ] << 8 );

	if ( length === 0 ) return { type, data: new Uint8Array( 0 ) };

	// Read message data
	const data = await _WT_ReadExact( reader, length );
	if ( ! data ) return null;

	return { type, data };

}

/*
=============
_WT_ReadExact

Read exactly n bytes from a reader, with buffering for leftover bytes
=============
*/
// Per-reader buffer storage (WeakMap to avoid memory leaks)
const _wtReaderBuffers = new WeakMap();

function _getWTReaderBuffer( reader ) {

	let buf = _wtReaderBuffers.get( reader );
	if ( ! buf ) {

		buf = { data: null, offset: 0 };
		_wtReaderBuffers.set( reader, buf );

	}
	return buf;

}

async function _WT_ReadExact( reader, n ) {

	const result = new Uint8Array( n );
	let offset = 0;
	const buf = _getWTReaderBuffer( reader );

	// First, use any leftover bytes from previous read
	if ( buf.data && buf.offset < buf.data.length ) {

		const available = buf.data.length - buf.offset;
		const bytesToCopy = Math.min( available, n );
		result.set( buf.data.subarray( buf.offset, buf.offset + bytesToCopy ), 0 );
		offset = bytesToCopy;
		buf.offset += bytesToCopy;

		// Clear buffer if fully consumed
		if ( buf.offset >= buf.data.length ) {

			buf.data = null;
			buf.offset = 0;

		}

	}

	// Read more if needed
	while ( offset < n ) {

		const { value, done } = await reader.read();
		if ( done ) return null;

		const bytesToCopy = Math.min( value.length, n - offset );
		result.set( value.subarray( 0, bytesToCopy ), offset );
		offset += bytesToCopy;

		// Save leftover bytes for next read
		if ( bytesToCopy < value.length ) {

			buf.data = value;
			buf.offset = bytesToCopy;

		}

	}

	return result;

}

/*
=============
WT_CheckNewConnections

Check for new incoming connections (server-side only)
=============
*/
export function WT_CheckNewConnections() {

	// Browser clients don't accept connections
	return null;

}

/*
=============
WT_QGetMessage

Get a message from the connection
Returns:
  0 = no message
  1 = reliable message
  2 = unreliable message
  -1 = error
=============
*/
export function WT_QGetMessage( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) return - 1;

	if ( ! conn.connected && conn.pendingMessages.length === 0 ) {

		return - 1;

	}

	if ( conn.pendingMessages.length === 0 ) {

		return 0;

	}

	// Get next message
	const msg = conn.pendingMessages.shift();

	// Copy to net_message
	SZ_Clear( net_message );
	SZ_Write( net_message, msg.data, msg.data.length );

	sock.lastMessageTime = performance.now() / 1000;

	return msg.reliable ? 1 : 2;

}

/*
=============
WT_QSendMessage

Send a reliable message
=============
*/
export function WT_QSendMessage( sock, data ) {

	const conn = sock.driverdata;
	if ( ! conn || ! conn.connected ) return - 1;

	// Check for previous async error (detected on last call)
	if ( conn.error ) {

		Con_DPrintf( 'WT_QSendMessage: previous error detected, connection dead\n' );
		conn.connected = false;
		return - 1;

	}

	// Frame the message: [type:1][length:2][data:N]
	const frame = new Uint8Array( 3 + data.cursize );
	frame[ 0 ] = 1; // reliable type
	frame[ 1 ] = data.cursize & 0xff;
	frame[ 2 ] = ( data.cursize >> 8 ) & 0xff;
	frame.set( data.data.subarray( 0, data.cursize ), 3 );

	// Track pending sends for debugging
	conn.pendingSends = ( conn.pendingSends || 0 ) + 1;

	// Send asynchronously - error will be detected on next send attempt
	conn.reliableWriter.write( frame ).then( () => {

		conn.pendingSends --;

	} ).catch( ( error ) => {

		Con_Printf( 'WT_QSendMessage error: ' + error.message + '\n' );
		conn.connected = false;
		conn.error = error;
		conn.pendingSends --;

	} );

	return 1;

}

/*
=============
WT_SendUnreliableMessage

Send an unreliable message via datagrams
=============
*/
export function WT_SendUnreliableMessage( sock, data ) {

	const conn = sock.driverdata;
	if ( ! conn || ! conn.connected ) {

		Con_DPrintf( 'WT_SendUnreliableMessage: no connection\n' );
		return - 1;

	}

	// Check for previous async error
	if ( conn.error ) {

		Con_DPrintf( 'WT_SendUnreliableMessage: previous error detected\n' );
		return - 1;

	}

	if ( ! conn.datagramWriter ) {

		Con_DPrintf( 'WT_SendUnreliableMessage: no datagramWriter\n' );
		return - 1;

	}

	// Copy the data (datagrams don't need framing, they're already atomic)
	const dgram = new Uint8Array( data.cursize );
	dgram.set( data.data.subarray( 0, data.cursize ) );

	// Debug: log first byte (should be clc_move = 3)
	// Con_DPrintf( 'WT_SendUnreliableMessage: sending %d bytes, cmd=%d\n', data.cursize, dgram[ 0 ] );

	// Send asynchronously - for datagrams, individual failures are expected
	// so we only mark the connection dead for persistent errors
	conn.datagramWriter.write( dgram ).catch( ( error ) => {

		// Datagram write failures happen when connection is dead
		Con_Printf( 'WT_SendUnreliableMessage: write failed: ' + error.message + '\n' );
		conn.error = error;
		conn.connected = false;

	} );

	return 1;

}

/*
=============
WT_CanSendMessage

Check if we can send a reliable message
=============
*/
export function WT_CanSendMessage( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) return false;

	return conn.connected;

}

/*
=============
WT_CanSendUnreliableMessage

Check if we can send an unreliable message
=============
*/
export function WT_CanSendUnreliableMessage( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) return false;

	return conn.connected;

}

/*
=============
WT_Close

Close a connection
=============
*/
export function WT_Close( sock ) {

	const conn = sock.driverdata;
	if ( ! conn ) return;

	conn.connected = false;

	try {

		// Close writers
		if ( conn.reliableWriter ) {

			conn.reliableWriter.close().catch( () => {} );

		}

		if ( conn.datagramWriter ) {

			conn.datagramWriter.close().catch( () => {} );

		}

		// Close the transport
		conn.transport.close();

	} catch ( error ) {

		// Ignore errors during close

	}

	wt_connections.delete( sock );
	sock.driverdata = null;

}

/*
=============
WT_GetAnyMessage

Used for control messages during connection
=============
*/
export function WT_GetAnyMessage() {

	// Not used for WebTransport
	return 0;

}
