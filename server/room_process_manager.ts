// Room Process Manager for Three-Quake
// Spawns and manages isolated Deno processes for each game room
// This matches how original Quake handled multiple games: separate server processes

import { Sys_Printf } from './sys_server.ts';

// Port range for room servers (main lobby is on 4433)
const BASE_PORT = 4434;
const MAX_ROOMS = 10;

interface RoomProcess {
	id: string;
	map: string;
	port: number;
	maxPlayers: number;
	hostName: string;
	process: Deno.ChildProcess;
	createdAt: number;
	playerCount: number;
}

// Active room processes
const roomProcesses = new Map<string, RoomProcess>();

// Track which ports are in use
const usedPorts = new Set<number>();

// Configuration (set by main server)
let certFile = '/etc/letsencrypt/live/wts.mrdoob.com/fullchain.pem';
let keyFile = '/etc/letsencrypt/live/wts.mrdoob.com/privkey.pem';
let pakPath = '/opt/three-quake/pak0.pak';

/**
 * Configure paths for room servers
 */
export function RoomManager_SetConfig( config: {
	certFile?: string;
	keyFile?: string;
	pakPath?: string;
} ): void {
	if ( config.certFile != null ) certFile = config.certFile;
	if ( config.keyFile != null ) keyFile = config.keyFile;
	if ( config.pakPath != null ) pakPath = config.pakPath;
}

/**
 * Generate a short room ID
 */
function generateRoomId(): string {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let id = '';
	for ( let i = 0; i < 6; i++ ) {
		id += chars[ Math.floor( Math.random() * chars.length ) ];
	}
	return id;
}

/**
 * Find an available port
 */
function findAvailablePort(): number | null {
	for ( let i = 0; i < MAX_ROOMS; i++ ) {
		const port = BASE_PORT + i;
		if ( ! usedPorts.has( port ) ) {
			return port;
		}
	}
	return null;
}

/**
 * Create a new room by spawning a dedicated server process
 */
export async function RoomManager_CreateRoom( config: {
	map: string;
	maxPlayers: number;
	hostName: string;
} ): Promise<{ id: string; port: number } | null> {
	// Check room limit
	if ( roomProcesses.size >= MAX_ROOMS ) {
		Sys_Printf( 'Room limit reached (%d), rejecting room creation\n', MAX_ROOMS );
		return null;
	}

	// Find available port
	const port = findAvailablePort();
	if ( port === null ) {
		Sys_Printf( 'No available ports for new room\n' );
		return null;
	}

	// Generate unique room ID
	let id = generateRoomId();
	while ( roomProcesses.has( id ) ) {
		id = generateRoomId();
	}

	Sys_Printf( 'Creating room %s on port %d (map: %s)\n', id, port, config.map );

	try {
		// Find the path to the game server script
		const serverDir = new URL( '.', import.meta.url ).pathname;
		const gameServerPath = serverDir + 'game_server.js';
		const denoJsonPath = serverDir.replace( /server\/$/, 'deno.json' );

		// Spawn dedicated server process for this room
		const command = new Deno.Command( 'deno', {
			args: [
				'run',
				'--allow-net',
				'--allow-read',
				'--unstable-net',
				'--config', denoJsonPath,
				gameServerPath,
				'-port', String( port ),
				'-maxclients', String( config.maxPlayers ),
				'-map', config.map,
				'-pak', pakPath,
				'-cert', certFile,
				'-key', keyFile,
				'-room', id,  // Pass room ID so process can identify itself
			],
			stdout: 'piped',
			stderr: 'piped',
		} );

		const process = command.spawn();

		// Mark port as used
		usedPorts.add( port );

		// Store room info
		const roomInfo: RoomProcess = {
			id,
			map: config.map,
			port,
			maxPlayers: config.maxPlayers,
			hostName: config.hostName,
			process,
			createdAt: Date.now(),
			playerCount: 0,
		};
		roomProcesses.set( id, roomInfo );

		// Pipe stdout/stderr to main server console with prefix
		( async () => {
			const reader = process.stdout.getReader();
			const decoder = new TextDecoder();
			try {
				while ( true ) {
					const { value, done } = await reader.read();
					if ( done ) break;
					const text = decoder.decode( value );
					for ( const line of text.split( '\n' ) ) {
						if ( line.trim() !== '' ) {
							Sys_Printf( '[Room %s] %s\n', id, line );
						}
					}
				}
			} catch { /* ignore */ }
		} )();

		( async () => {
			const reader = process.stderr.getReader();
			const decoder = new TextDecoder();
			try {
				while ( true ) {
					const { value, done } = await reader.read();
					if ( done ) break;
					const text = decoder.decode( value );
					for ( const line of text.split( '\n' ) ) {
						if ( line.trim() !== '' ) {
							Sys_Printf( '[Room %s ERR] %s\n', id, line );
						}
					}
				}
			} catch { /* ignore */ }
		} )();

		// Monitor process exit
		process.status.then( ( status ) => {
			Sys_Printf( 'Room %s process exited with code %d\n', id, status.code );
			usedPorts.delete( port );
			roomProcesses.delete( id );
		} );

		// Wait a moment for the server to start
		await new Promise( resolve => setTimeout( resolve, 500 ) );

		Sys_Printf( 'Room %s created successfully on port %d\n', id, port );

		return { id, port };

	} catch ( error ) {
		Sys_Printf( 'Failed to create room: %s\n', ( error as Error ).message );
		return null;
	}
}

/**
 * Get info about a room
 */
export function RoomManager_GetRoom( id: string ): {
	id: string;
	map: string;
	port: number;
	maxPlayers: number;
	hostName: string;
	playerCount: number;
	createdAt: number;
} | null {
	const room = roomProcesses.get( id.toUpperCase() );
	if ( room == null ) return null;

	return {
		id: room.id,
		map: room.map,
		port: room.port,
		maxPlayers: room.maxPlayers,
		hostName: room.hostName,
		playerCount: room.playerCount,
		createdAt: room.createdAt,
	};
}

/**
 * List all active rooms
 */
export function RoomManager_ListRooms(): Array<{
	id: string;
	name: string;
	map: string;
	port: number;
	maxPlayers: number;
	playerCount: number;
}> {
	const rooms: Array<{
		id: string;
		name: string;
		map: string;
		port: number;
		maxPlayers: number;
		playerCount: number;
	}> = [];

	for ( const room of roomProcesses.values() ) {
		rooms.push( {
			id: room.id,
			name: room.hostName + "'s Game",
			map: room.map,
			port: room.port,
			maxPlayers: room.maxPlayers,
			playerCount: room.playerCount,
		} );
	}

	return rooms;
}

/**
 * Update player count for a room (called via IPC or health check)
 */
export function RoomManager_UpdatePlayerCount( id: string, count: number ): void {
	const room = roomProcesses.get( id );
	if ( room != null ) {
		room.playerCount = count;
	}
}

/**
 * Terminate a room
 */
export function RoomManager_TerminateRoom( id: string ): boolean {
	const room = roomProcesses.get( id );
	if ( room == null ) return false;

	Sys_Printf( 'Terminating room %s\n', id );

	try {
		room.process.kill( 'SIGTERM' );
	} catch {
		// Process may have already exited
	}

	usedPorts.delete( room.port );
	roomProcesses.delete( id );

	return true;
}

/**
 * Clean up idle rooms (rooms with 0 players for too long)
 */
export function RoomManager_CleanupIdleRooms( maxIdleMs: number = 5 * 60 * 1000 ): number {
	const now = Date.now();
	let cleaned = 0;

	for ( const [ id, room ] of roomProcesses ) {
		// Check if room has been idle (0 players) for too long
		// For now, we rely on the room process to self-terminate
		// In the future, we could add health checks
		if ( room.playerCount === 0 && ( now - room.createdAt ) > maxIdleMs ) {
			Sys_Printf( 'Room %s idle for too long, terminating\n', id );
			RoomManager_TerminateRoom( id );
			cleaned++;
		}
	}

	return cleaned;
}

/**
 * Get room count
 */
export function RoomManager_GetRoomCount(): number {
	return roomProcesses.size;
}

/**
 * Shutdown all rooms
 */
export function RoomManager_ShutdownAll(): void {
	Sys_Printf( 'Shutting down all room processes...\n' );

	for ( const id of roomProcesses.keys() ) {
		RoomManager_TerminateRoom( id );
	}
}
