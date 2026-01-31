// Three-Quake Lobby Server for Deno
// Lightweight server that only handles room management
// Spawns separate game server processes for each room
//
// Usage: deno run --allow-net --allow-read --allow-run --unstable-net lobby_server.js

import { Sys_Printf } from './sys_server.ts';
import {
	RoomManager_SetConfig,
	RoomManager_CreateRoom,
	RoomManager_GetRoom,
	RoomManager_ListRooms,
	RoomManager_CleanupIdleRooms,
	RoomManager_ShutdownAll,
} from './room_process_manager.ts';

// Server configuration
const CONFIG = {
	port: 4433,
	certFile: '/etc/letsencrypt/live/wts.mrdoob.com/fullchain.pem',
	keyFile: '/etc/letsencrypt/live/wts.mrdoob.com/privkey.pem',
	pakPath: '/opt/three-quake/pak0.pak',
};

// Parse command line arguments
function parseArgs() {
	const args = Deno.args;
	for ( let i = 0; i < args.length; i++ ) {
		const arg = args[ i ];
		if ( arg === '-port' && args[ i + 1 ] ) {
			CONFIG.port = parseInt( args[ ++i ], 10 );
		} else if ( arg === '-cert' && args[ i + 1 ] ) {
			CONFIG.certFile = args[ ++i ];
		} else if ( arg === '-key' && args[ i + 1 ] ) {
			CONFIG.keyFile = args[ ++i ];
		} else if ( arg === '-pak' && args[ i + 1 ] ) {
			CONFIG.pakPath = args[ ++i ];
		}
	}
}

// Lobby message types
const LOBBY_LIST = 0x01;
const LOBBY_JOIN = 0x02;
const LOBBY_CREATE = 0x03;
const LOBBY_ROOMS = 0x81;
const LOBBY_ERROR = 0x82;

// QUIC endpoint
let quicEndpoint = null;

/**
 * Read exactly n bytes from a reader
 */
async function readExact( reader, n ) {
	const result = new Uint8Array( n );
	let offset = 0;

	while ( offset < n ) {
		const { value, done } = await reader.read();
		if ( done ) return null;

		const bytesToCopy = Math.min( value.length, n - offset );
		result.set( value.subarray( 0, bytesToCopy ), offset );
		offset += bytesToCopy;

		// TODO: buffer leftover bytes for next read
		// For lobby protocol this is fine since messages are small
	}

	return result;
}

/**
 * Read a framed message: [type:1][length:2][data:N]
 */
async function readFramedMessage( reader ) {
	const header = await readExact( reader, 3 );
	if ( header === null ) return null;

	const type = header[ 0 ];
	const length = header[ 1 ] | ( header[ 2 ] << 8 );

	if ( length === 0 ) {
		return { type, data: new Uint8Array( 0 ) };
	}

	const data = await readExact( reader, length );
	if ( data === null ) return null;

	return { type, data };
}

/**
 * Send a framed message
 */
async function sendFramedMessage( writer, type, data ) {
	const frame = new Uint8Array( 3 + data.length );
	frame[ 0 ] = type;
	frame[ 1 ] = data.length & 0xff;
	frame[ 2 ] = ( data.length >> 8 ) & 0xff;
	frame.set( data, 3 );
	await writer.write( frame );
}

/**
 * Handle a WebTransport session
 */
async function handleSession( wt, address ) {
	Sys_Printf( 'Lobby connection from %s\n', address );

	try {
		await wt.ready;

		// Accept bidirectional stream
		const streamReader = wt.incomingBidirectionalStreams.getReader();
		const { value: stream, done } = await streamReader.read();
		streamReader.releaseLock();

		if ( done || stream == null ) {
			wt.close();
			return;
		}

		const writer = stream.writable.getWriter();
		const reader = stream.readable.getReader();

		// Read lobby message
		const msg = await readFramedMessage( reader );
		if ( msg === null ) {
			wt.close();
			return;
		}

		switch ( msg.type ) {
			case LOBBY_LIST: {
				// Send room list
				const rooms = RoomManager_ListRooms();
				const json = JSON.stringify( rooms );
				const data = new TextEncoder().encode( json );
				await sendFramedMessage( writer, LOBBY_ROOMS, data );
				Sys_Printf( 'Sent room list to %s (%d rooms)\n', address, rooms.length );
				break;
			}

			case LOBBY_CREATE: {
				// Create new room
				const configJson = new TextDecoder().decode( msg.data );
				try {
					const config = JSON.parse( configJson );
					const result = await RoomManager_CreateRoom( {
						map: config.map || 'start',
						maxPlayers: config.maxPlayers || 8,
						hostName: config.hostName || 'Player',
					} );

					if ( result === null ) {
						const errorMsg = 'Server room limit reached. Try again later.';
						const errorData = new TextEncoder().encode( errorMsg );
						await sendFramedMessage( writer, LOBBY_ERROR, errorData );
						Sys_Printf( 'Room creation failed for %s (limit reached)\n', address );
					} else {
						// Send room info with port
						const roomInfo = {
							id: result.id,
							port: result.port,
							map: config.map || 'start',
							maxPlayers: config.maxPlayers || 8,
							hostName: config.hostName || 'Player',
						};
						const json = JSON.stringify( roomInfo );
						const data = new TextEncoder().encode( json );
						await sendFramedMessage( writer, LOBBY_ROOMS, data );
						Sys_Printf( 'Room %s created on port %d for %s\n', result.id, result.port, address );
					}
				} catch ( e ) {
					const errorData = new TextEncoder().encode( 'Invalid room config' );
					await sendFramedMessage( writer, LOBBY_ERROR, errorData );
					Sys_Printf( 'Invalid room config from %s: %s\n', address, e.message );
				}
				break;
			}

			case LOBBY_JOIN: {
				// Get room info so client knows which port to connect to
				const roomId = new TextDecoder().decode( msg.data ).trim();
				const room = RoomManager_GetRoom( roomId );

				if ( room === null ) {
					const errorMsg = 'Room not found. The game may have ended.';
					const errorData = new TextEncoder().encode( errorMsg );
					await sendFramedMessage( writer, LOBBY_ERROR, errorData );
					Sys_Printf( 'Room %s not found for %s\n', roomId, address );
				} else {
					// Send room info with port
					const roomInfo = {
						id: room.id,
						port: room.port,
						map: room.map,
						maxPlayers: room.maxPlayers,
						hostName: room.hostName,
					};
					const json = JSON.stringify( roomInfo );
					const data = new TextEncoder().encode( json );
					await sendFramedMessage( writer, LOBBY_ROOMS, data );
					Sys_Printf( 'Sent room %s info (port %d) to %s\n', room.id, room.port, address );
				}
				break;
			}

			default:
				Sys_Printf( 'Unknown lobby message type %d from %s\n', msg.type, address );
		}

		// Close connection after handling lobby request
		try {
			await writer.close();
		} catch { /* ignore */ }
		await new Promise( resolve => setTimeout( resolve, 100 ) );
		wt.close();

	} catch ( error ) {
		Sys_Printf( 'Session error from %s: %s\n', address, error.message );
		try { wt.close(); } catch { /* ignore */ }
	}
}

/**
 * Accept connections
 */
async function acceptConnections( listener ) {
	while ( quicEndpoint !== null ) {
		try {
			const conn = await listener.accept();
			const remoteAddr = conn.remoteAddr;
			const address = remoteAddr.hostname + ':' + remoteAddr.port;

			// Handle in background
			( async () => {
				try {
					const wt = await Deno.upgradeWebTransport( conn );
					await handleSession( wt, address );
				} catch ( error ) {
					Sys_Printf( 'Connection error from %s: %s\n', address, error.message );
					try { conn.close(); } catch { /* ignore */ }
				}
			} )();

		} catch ( error ) {
			if ( quicEndpoint !== null ) {
				Sys_Printf( 'Accept error: %s\n', error.message );
			}
		}
	}
}

/**
 * Start the lobby server
 */
async function startServer() {
	Sys_Printf( '========================================\n' );
	Sys_Printf( 'Three-Quake Lobby Server v1.0\n' );
	Sys_Printf( '========================================\n\n' );

	// Configure room manager
	RoomManager_SetConfig( {
		certFile: CONFIG.certFile,
		keyFile: CONFIG.keyFile,
		pakPath: CONFIG.pakPath,
	} );

	// Read TLS certificates
	const cert = await Deno.readTextFile( CONFIG.certFile );
	const key = await Deno.readTextFile( CONFIG.keyFile );

	// Create QUIC endpoint
	quicEndpoint = new Deno.QuicEndpoint( {
		hostname: '0.0.0.0',
		port: CONFIG.port,
	} );

	const listener = quicEndpoint.listen( {
		cert,
		key,
		alpnProtocols: [ 'h3' ],
	} );

	Sys_Printf( 'Lobby server listening on port %d\n', CONFIG.port );
	Sys_Printf( 'Rooms will spawn on ports 4434-4443\n\n' );

	// Start cleanup timer (every 5 minutes)
	setInterval( () => {
		const cleaned = RoomManager_CleanupIdleRooms();
		if ( cleaned > 0 ) {
			Sys_Printf( 'Cleaned up %d idle rooms\n', cleaned );
		}
	}, 5 * 60 * 1000 );

	// Accept connections
	await acceptConnections( listener );
}

/**
 * Main entry point
 */
async function main() {
	parseArgs();

	// Handle shutdown
	Deno.addSignalListener( 'SIGTERM', () => {
		Sys_Printf( 'Received SIGTERM, shutting down...\n' );
		RoomManager_ShutdownAll();
		if ( quicEndpoint !== null ) {
			quicEndpoint.close();
			quicEndpoint = null;
		}
		Deno.exit( 0 );
	} );

	try {
		await startServer();
	} catch ( error ) {
		console.error( 'Fatal error:', error );
		Deno.exit( 1 );
	}
}

main();
