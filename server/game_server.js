// Three-Quake Game Server for Deno
// Uses the existing JavaScript game modules from src/
//
// Local dev:  deno run --allow-net --allow-read --unstable-net --config ../deno.json game_server.js
// Production: deno run --allow-net --allow-read --unstable-net --config /opt/three-quake/deno.json /opt/three-quake/server/game_server.js

import { Sys_Printf, Sys_FloatTime } from '../src/sys.js';
import { COM_InitArgv } from '../src/common.js';
import { COM_FetchPak, COM_AddPack } from '../src/pak.js';
import { Cbuf_Init, Cbuf_Execute, Cbuf_AddText, Cmd_Init } from '../src/cmd.js';
import { Host_InitCommands } from '../src/host.js';
import { deathmatch } from '../src/host.js';
import { cls, ca_dedicated } from '../src/client.js';
import { Memory_Init } from '../src/zone.js';
import { PR_Init } from '../src/pr_edict.js';
import { SV_Init, SV_SpawnServer, SV_CheckForNewClients, SV_SendClientMessages, SV_ClearDatagram } from '../src/sv_main.js';
import { SV_Physics, SV_SetFrametime } from '../src/sv_phys.js';
import { SV_RunClients } from '../src/sv_user.js';
import { svs, sv, client_t } from '../src/server.js';
import { Mod_Init } from '../src/gl_model.js';
import { NET_Init, set_listening } from '../src/net_main.js';
import { net_drivers, set_net_numdrivers, set_net_driverlevel } from '../src/net.js';

// Import WebTransport server driver
import {
	WT_Init as WT_Server_Init,
	WT_Listen,
	WT_CheckNewConnections,
	WT_QGetMessage,
	WT_QSendMessage,
	WT_SendUnreliableMessage,
	WT_CanSendMessage,
	WT_CanSendUnreliableMessage,
	WT_Close,
	WT_Shutdown,
	WT_SetConfig,
	WT_SearchForHosts,
	WT_SetDriverLevel,
	WT_SetSocketAllocator,
	WT_SetMapCallbacks,
	WT_SetDirectMode,
} from './net_webtransport_server.ts';
import { NET_NewQSocket } from '../src/net_main.js';

// Global unhandled rejection handler - prevent server crashes from async errors
globalThis.addEventListener('unhandledrejection', (event) => {
	Sys_Printf('Unhandled promise rejection: %s\n', String(event.reason));
	event.preventDefault(); // Prevent default crash behavior
});

// Server configuration
const CONFIG = {
	pakPath: '../pak0.pak',
	port: 4433,
	certFile: '/etc/letsencrypt/live/wts.mrdoob.com/fullchain.pem',
	keyFile: '/etc/letsencrypt/live/wts.mrdoob.com/privkey.pem',
	tickRate: 72,
	maxClients: 16,
	defaultMap: 'start',
	roomId: null,        // Room ID if spawned by lobby server
	directMode: false,   // Skip lobby protocol, accept connections directly
	idleTimeout: 300,    // Seconds to wait before exiting when empty (room mode)
};

// Parse command line arguments
function parseArgs() {
	const args = Deno.args;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === '-port' && args[i + 1]) {
			CONFIG.port = parseInt(args[++i], 10);
		} else if (arg === '-maxclients' && args[i + 1]) {
			CONFIG.maxClients = parseInt(args[++i], 10);
		} else if (arg === '-map' && args[i + 1]) {
			CONFIG.defaultMap = args[++i];
		} else if (arg === '-pak' && args[i + 1]) {
			CONFIG.pakPath = args[++i];
		} else if (arg === '-cert' && args[i + 1]) {
			CONFIG.certFile = args[++i];
		} else if (arg === '-key' && args[i + 1]) {
			CONFIG.keyFile = args[++i];
		} else if (arg === '-room' && args[i + 1]) {
			CONFIG.roomId = args[++i];
			CONFIG.directMode = true; // Room servers use direct mode
		} else if (arg === '-direct') {
			CONFIG.directMode = true;
		} else if (arg === '-idletimeout' && args[i + 1]) {
			CONFIG.idleTimeout = parseInt(args[++i], 10);
		}
	}
}

// Globals for game loop
let host_frametime = 0;
let realtime = 0;
let oldrealtime = 0;

// Idle tracking for room servers
let lastActiveTime = 0;
let hadPlayersEver = false;

/**
 * Initialize the game server
 */
async function Host_Init_Server() {
	Sys_Printf('========================================\n');
	if (CONFIG.roomId !== null) {
		Sys_Printf('Three-Quake Room Server [%s]\n', CONFIG.roomId);
	} else {
		Sys_Printf('Three-Quake Game Server v1.0\n');
	}
	Sys_Printf('========================================\n\n');

	// Initialize subsystems in order (from host.js)
	Memory_Init();
	Cbuf_Init();
	Cmd_Init();
	Host_InitCommands(); // Register prespawn, spawn, begin commands

	// Set dedicated server mode - this prevents Host_Map_f from connecting a local client
	cls.state = ca_dedicated;

	// Set max clients BEFORE NET_Init so socket pool is properly sized
	svs.maxclients = CONFIG.maxClients;
	svs.maxclientslimit = CONFIG.maxClients;
	svs.clients = [];
	for (let i = 0; i < svs.maxclientslimit; i++) {
		svs.clients[i] = new client_t();
	}

	// Initialize network
	Sys_Printf('Configuring network...\n');
	WT_SetConfig({
		port: CONFIG.port,
		certFile: CONFIG.certFile,
		keyFile: CONFIG.keyFile,
	});

	// If running as a room server, use direct mode (skip lobby protocol)
	if (CONFIG.directMode) {
		WT_SetDirectMode(true);
		Sys_Printf('Direct mode enabled (room server)\n');
	}

	// Initialize base networking (sets up loopback driver 0)
	NET_Init();

	// Enable listening mode (dedicated server accepts connections)
	set_listening(true);

	// Register server WebTransport driver (driver 1)
	set_net_numdrivers(2);
	net_drivers[1] = {
		name: 'WebTransport Server',
		initialized: false,
		controlSock: null,
		Init: WT_Server_Init,
		Listen: WT_Listen,
		SearchForHosts: WT_SearchForHosts,
		Connect: () => null, // Server doesn't connect out
		CheckNewConnections: WT_CheckNewConnections,
		QGetMessage: WT_QGetMessage,
		QSendMessage: WT_QSendMessage,
		SendUnreliableMessage: WT_SendUnreliableMessage,
		CanSendMessage: WT_CanSendMessage,
		CanSendUnreliableMessage: WT_CanSendUnreliableMessage,
		Close: WT_Close,
		Shutdown: WT_Shutdown,
	};

	// Initialize the server driver
	const controlSocket = net_drivers[1].Init();
	if (controlSocket !== -1) {
		net_drivers[1].initialized = true;
		net_drivers[1].controlSock = controlSocket;
	}

	// Set driver level to 1 (WebTransport) for server operations
	set_net_driverlevel(1);
	WT_SetDriverLevel(1);

	// Pass the socket allocator to the WebTransport driver so it uses the shared pool
	WT_SetSocketAllocator(NET_NewQSocket);

	// Initialize server systems
	PR_Init();
	Mod_Init();
	SV_Init();

	// Set deathmatch mode - this ensures respawn() doesn't restart the entire server
	// We set the value directly on the imported cvar object (same object that sv_main.js uses)
	deathmatch.value = 1;
	deathmatch.string = '1';
	Sys_Printf('Deathmatch mode enabled (deathmatch=%d)\n', deathmatch.value);

	// Load PAK file
	Sys_Printf('Loading game data...\n');
	const pak = await COM_FetchPak(CONFIG.pakPath, 'pak0.pak');
	if (!pak) {
		throw new Error('Failed to load ' + CONFIG.pakPath);
	}
	COM_AddPack(pak);

	// Start listening for connections
	await net_drivers[1].Listen(true);

	// Set up map change callbacks so rooms can trigger level changes
	WT_SetMapCallbacks(
		async (mapName) => {
			Sys_Printf('Changing map to: ' + mapName + '\n');
			await SV_SpawnServer(mapName);
		},
		() => sv.name || ''
	);

	// Spawn the default map
	Sys_Printf('Spawning server for map: ' + CONFIG.defaultMap + '\n');
	await SV_SpawnServer(CONFIG.defaultMap);

	Sys_Printf('\nServer initialized!\n');
	Sys_Printf('  Port: ' + CONFIG.port + '\n');
	Sys_Printf('  Max clients: ' + CONFIG.maxClients + '\n');
	Sys_Printf('  Map: ' + CONFIG.defaultMap + '\n\n');
}

/**
 * Count active players
 */
function countActivePlayers() {
	let count = 0;
	for (let i = 0; i < svs.maxclients; i++) {
		if (svs.clients[i].active) {
			count++;
		}
	}
	return count;
}

/**
 * Run a single server frame
 */
function Host_ServerFrame() {
	// Update time
	const newtime = Sys_FloatTime();
	host_frametime = newtime - oldrealtime;
	oldrealtime = newtime;

	// Clamp frametime
	if (host_frametime > 0.1) host_frametime = 0.1;
	if (host_frametime < 0.001) host_frametime = 0.001;

	realtime += host_frametime;

	// Set frametime for physics modules
	SV_SetFrametime(host_frametime);

	if (!sv.active) return;

	// Set the time and clear the general datagram
	SV_ClearDatagram();

	// Run command buffer
	Cbuf_Execute();

	// Check for new connections
	SV_CheckForNewClients();

	// Read client messages and run client commands
	SV_RunClients();

	// Run physics
	SV_Physics();

	// Send messages to all clients
	SV_SendClientMessages();

	// Track activity for room servers (idle timeout)
	if (CONFIG.roomId !== null) {
		const playerCount = countActivePlayers();
		if (playerCount > 0) {
			lastActiveTime = realtime;
			hadPlayersEver = true;
		} else if (hadPlayersEver && CONFIG.idleTimeout > 0) {
			// Check idle timeout only after we've had players
			const idleTime = realtime - lastActiveTime;
			if (idleTime > CONFIG.idleTimeout) {
				Sys_Printf('Room %s idle for %d seconds, shutting down\n', CONFIG.roomId, Math.floor(idleTime));
				Deno.exit(0);
			}
		}
	}
}

/**
 * Main server loop
 */
async function runServerLoop() {
	const tickInterval = 1000 / CONFIG.tickRate;
	oldrealtime = Sys_FloatTime();

	Sys_Printf('Starting server loop at ' + CONFIG.tickRate + ' Hz...\n');

	setInterval(() => {
		try {
			Host_ServerFrame();
		} catch (error) {
			Sys_Printf('Host_ServerFrame error: %s\n', String(error));
		}
	}, tickInterval);

	// Keep process running
	await new Promise(() => {});
}

/**
 * Entry point
 */
async function main() {
	parseArgs();

	try {
		await Host_Init_Server();
		await runServerLoop();
	} catch (error) {
		console.error('Fatal error:', error);
		Deno.exit(1);
	}
}

main();
