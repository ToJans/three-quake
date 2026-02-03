// Ported from: QuakeWorld/client/cl_pred.c
// Client-side prediction for smooth movement with low server tick rates

import { VectorCopy, VectorSubtract, VectorMA } from './mathlib.js';
import { cvar_t, Cvar_RegisterVariable } from './cvar.js';
import { pmove, movevars, PlayerMove, PM_HullPointContents, PM_GetOnGround, Pmove_Init,
	player_mins, player_maxs } from './pmove.js';
import { CONTENTS_EMPTY } from './bspfile.js';
import { cl, cls, ca_connected, cl_entities } from './client.js';
import { STAT_HEALTH } from './quakedef.js';
import { realtime, sv } from './host.js';

// CVars
export const cl_nopred = new cvar_t( 'cl_nopred', '0' );
export const cl_pushlatency = new cvar_t( 'pushlatency', '-999' );
export const cl_solid_players = new cvar_t( 'cl_solid_players', '1' );
export const cl_predict_players = new cvar_t( 'cl_predict_players', '1' );

// Player flags from QuakeWorld protocol
export const PF_DEAD = ( 1 << 9 ); // Don't block movement any more
export const PF_GIB = ( 1 << 10 ); // Offset the view height differently

// Predicted player structure (for other players)
class predicted_player_t {
	constructor() {
		this.active = false;
		this.origin = new Float32Array( 3 ); // Predicted origin
		this.velocity = new Float32Array( 3 ); // Last known velocity
		this.angles = new Float32Array( 3 );
		this.modelindex = 0;
		this.msgtime = 0; // Last update time
		this.frame = 0;
		this.flags = 0; // PF_DEAD, PF_GIB, etc.
		this.skin = 0;
		this.effects = 0;
		this.weaponframe = 0;
		this.msec = 0; // Time since last server frame
		// Movement command for physics prediction
		this.cmd = {
			msec: 0,
			angles: new Float32Array( 3 ),
			forwardmove: 0,
			sidemove: 0,
			upmove: 0,
			buttons: 0,
			impulse: 0
		};
	}
}

// Array of predicted players (indices 1-maxclients are players)
const MAX_CLIENTS = 16;
const predicted_players = [];
for ( let i = 0; i < MAX_CLIENTS; i++ ) {
	predicted_players.push( new predicted_player_t() );
}

// Command buffer for prediction
const UPDATE_BACKUP = 64; // Must be power of 2
const UPDATE_MASK = UPDATE_BACKUP - 1;

// Player state for prediction
export class player_state_t {
	constructor() {
		this.origin = new Float32Array( 3 );
		this.velocity = new Float32Array( 3 );
		this.viewangles = new Float32Array( 3 );
		this.onground = false;
		this.oldbuttons = 0;
		this.waterjumptime = 0;
		this.weaponframe = 0;
	}

	copyFrom( other ) {
		VectorCopy( other.origin, this.origin );
		VectorCopy( other.velocity, this.velocity );
		VectorCopy( other.viewangles, this.viewangles );
		this.onground = other.onground;
		this.oldbuttons = other.oldbuttons;
		this.waterjumptime = other.waterjumptime;
		this.weaponframe = other.weaponframe;
	}
}

// Frame structure - stores command and resulting state
export class frame_t {
	constructor() {
		this.cmd = {
			msec: 0,
			angles: new Float32Array( 3 ),
			forwardmove: 0,
			sidemove: 0,
			upmove: 0,
			buttons: 0
		};
		this.senttime = 0; // Time command was sent
		this.playerstate = new player_state_t();
	}
}

// Frame buffer
const frames = [];
for ( let i = 0; i < UPDATE_BACKUP; i++ ) {
	frames.push( new frame_t() );
}

// Sequence tracking
let outgoing_sequence = 0; // Next command to send
let incoming_sequence = 0; // Last acknowledged command from server
let validsequence = 0; // Last valid server frame sequence (0 = no valid data yet)

// Predicted position (used for rendering)
export const cl_simorg = new Float32Array( 3 ); // Simulated/predicted origin
export const cl_simvel = new Float32Array( 3 ); // Simulated/predicted velocity
export const cl_simangles = new Float32Array( 3 ); // Simulated angles
export let cl_simonground = -1; // Predicted onground state: -1 = in air, >= 0 = on ground

// Estimated latency for timing
let cls_latency = 0;

/*
=================
CL_SetLatency

Called when we receive server updates to estimate latency
=================
*/
export function CL_SetLatency( latency ) {
	cls_latency = latency;
}

/*
=================
CL_GetOutgoingSequence / CL_GetIncomingSequence
=================
*/
export function CL_GetOutgoingSequence() { return outgoing_sequence; }
export function CL_GetIncomingSequence() { return incoming_sequence; }

/*
=================
CL_SetValidSequence

Called when we receive valid entity/player data from server.
Set to 0 to invalidate (e.g., on error or disconnect).
=================
*/
export function CL_SetValidSequence( seq ) {
	validsequence = seq;
}

/*
=================
CL_AcknowledgeCommand

Called when server acknowledges a command
=================
*/
export function CL_AcknowledgeCommand( sequence ) {
	if ( sequence > incoming_sequence )
		incoming_sequence = sequence;
}

/*
=================
CL_FindAcknowledgedSequence

Find which command sequence corresponds to the server update.
When we receive a server update at `currentTime`, we acknowledge commands
that were sent more than RTT ago.
Returns the sequence number, or -1 if not found.
=================
*/
export function CL_FindAcknowledgedSequence( currentTime ) {
	// Estimate RTT: start with a reasonable default and adjust
	// based on observed command roundtrip
	// For local play, RTT is ~0. For internet, typically 50-200ms.
	const estimatedRTT = cls_latency > 0 ? cls_latency : 0.1; // Default 100ms

	// Commands sent before this time should be acknowledged
	const ackTime = currentTime - estimatedRTT;

	let bestSeq = -1;
	const searchStart = outgoing_sequence - 1;
	const searchEnd = Math.max( 0, outgoing_sequence - UPDATE_BACKUP + 1 );

	// Find the most recent command that was sent before ackTime
	for ( let seq = searchStart; seq >= searchEnd; seq-- ) {
		const frame = frames[ seq & UPDATE_MASK ];
		if ( frame.senttime > 0 && frame.senttime <= ackTime ) {
			bestSeq = seq;
			break;
		}
	}

	// If we didn't find anything but have commands in flight,
	// acknowledge at least some to prevent buffer overflow
	if ( bestSeq < 0 && outgoing_sequence > UPDATE_BACKUP / 2 ) {
		bestSeq = outgoing_sequence - UPDATE_BACKUP / 2;
	}

	// Update latency estimate based on oldest unacknowledged command
	if ( bestSeq >= 0 ) {
		const ackFrame = frames[ bestSeq & UPDATE_MASK ];
		if ( ackFrame.senttime > 0 ) {
			const observedRTT = currentTime - ackFrame.senttime;
			if ( observedRTT > 0 && observedRTT < 1.0 ) {
				// Smoothly adjust latency estimate
				if ( observedRTT < cls_latency ) {
					cls_latency = observedRTT;
				} else {
					cls_latency += 0.001; // Drift up slowly
				}
			}
		}
	}

	return bestSeq;
}

/*
=================
CL_StoreCommand

Store a command for prediction replay
=================
*/
export function CL_StoreCommand( cmd, senttime ) {
	const framenum = outgoing_sequence & UPDATE_MASK;
	const frame = frames[ framenum ];

	// Copy command
	frame.cmd.msec = cmd.msec;
	VectorCopy( cmd.angles, frame.cmd.angles );
	frame.cmd.forwardmove = cmd.forwardmove;
	frame.cmd.sidemove = cmd.sidemove;
	frame.cmd.upmove = cmd.upmove;
	frame.cmd.buttons = cmd.buttons;
	frame.senttime = senttime;

	outgoing_sequence++;

	return framenum;
}

/*
=================
CL_SetUpPlayerPrediction

Calculate predicted positions for all other players.
This extrapolates their position forward based on their last known velocity.
Ported from QuakeWorld cl_ents.c
=================
*/
export function CL_SetUpPlayerPrediction( dopred ) {
	// Calculate player time - slightly ahead to compensate for latency
	let playertime = realtime - cls_latency + 0.02;
	if ( playertime > realtime )
		playertime = realtime;

	// Process all potential player slots
	for ( let j = 1; j <= cl.maxclients && j < MAX_CLIENTS; j++ ) {
		const pplayer = predicted_players[ j ];
		pplayer.active = false;

		const ent = cl_entities[ j ];

		// Skip if entity wasn't updated recently
		if ( ent.msgtime <= 0 )
			continue;

		// Skip if no model (dead or not spawned)
		if ( ent.model == null )
			continue;

		pplayer.active = true;
		pplayer.modelindex = ent.model != null ? 1 : 0;
		pplayer.msgtime = ent.msgtime;
		VectorCopy( ent.angles, pplayer.angles );

		// For the local player, use our predicted position
		if ( j === cl.viewentity ) {
			VectorCopy( cl_simorg, pplayer.origin );
			VectorCopy( cl_simvel, pplayer.velocity );
		} else {
			// For other players, extrapolate based on velocity
			// Calculate time since last update
			const dt = playertime - ent.msgtime;

			if ( dt <= 0 || cl_predict_players.value === 0 || ! dopred ) {
				// No prediction - use last known position
				VectorCopy( ent.origin, pplayer.origin );
				// Estimate velocity from position delta
				VectorSubtract( ent.msg_origins[ 0 ], ent.msg_origins[ 1 ], pplayer.velocity );
				const msgdt = cl.mtime[ 0 ] - cl.mtime[ 1 ];
				if ( msgdt > 0 ) {
					pplayer.velocity[ 0 ] /= msgdt;
					pplayer.velocity[ 1 ] /= msgdt;
					pplayer.velocity[ 2 ] /= msgdt;
				}
			} else {
				// Estimate velocity from position delta between last two updates
				VectorSubtract( ent.msg_origins[ 0 ], ent.msg_origins[ 1 ], pplayer.velocity );
				const msgdt = cl.mtime[ 0 ] - cl.mtime[ 1 ];
				if ( msgdt > 0 ) {
					pplayer.velocity[ 0 ] /= msgdt;
					pplayer.velocity[ 1 ] /= msgdt;
					pplayer.velocity[ 2 ] /= msgdt;
				}

				// Extrapolate position forward
				// Only predict half the move to minimize overruns (like QuakeWorld)
				const predictTime = Math.min( dt * 0.5, 0.1 ); // Cap at 100ms
				VectorMA( ent.origin, predictTime, pplayer.velocity, pplayer.origin );
			}
		}
	}
}

/*
=================
CL_SetSolidEntities

Add brush entities (doors, platforms, lifts) as collision objects for prediction.
Ported from QuakeWorld cl_ents.c
=================
*/
function CL_SetSolidEntities() {
	// Start after world model (physent 0)
	// Iterate through all entities and add brush models with collision hulls
	for ( let i = 1; i < cl.num_entities; i++ ) {
		const ent = cl_entities[ i ];

		// Skip entities without models
		if ( ent.model == null )
			continue;

		// Skip if not a brush model (type 0 = mod_brush)
		if ( ent.model.type !== 0 )
			continue;

		// Check if model has collision hull data (hulls[1] for player-sized collision)
		// Brush models with collision have firstclipnode set to a valid node index
		const hull = ent.model.hulls[ 1 ];
		if ( hull == null )
			continue;

		// QuakeWorld checks: hulls[1].firstclipnode || clipbox
		// For brush submodels, firstclipnode will be set to the headnode
		// A value of 0 with lastclipnode also 0 means no collision data
		if ( hull.firstclipnode === 0 && hull.lastclipnode === 0 && hull.clipnodes == null )
			continue;

		// Add this brush entity as a physics collision object
		if ( pmove.numphysent >= pmove.physents.length )
			break;

		const pent = pmove.physents[ pmove.numphysent ];
		pent.model = ent.model;
		pent.origin[ 0 ] = ent.origin[ 0 ];
		pent.origin[ 1 ] = ent.origin[ 1 ];
		pent.origin[ 2 ] = ent.origin[ 2 ];
		pent.info = i;

		pmove.numphysent++;
	}
}

/*
=================
CL_SetupPMove

Set up pmove state for prediction
=================
*/
function CL_SetupPMove() {
	// Set up physics entities (world model for collision)
	pmove.numphysent = 0;

	if ( cl.worldmodel != null ) {
		pmove.physents[ 0 ].model = cl.worldmodel;
		pmove.physents[ 0 ].origin.fill( 0 );
		pmove.numphysent = 1;
	}

	// Add brush entities (doors, platforms) as collision objects
	CL_SetSolidEntities();

	// Calculate predicted positions for other players first
	CL_SetUpPlayerPrediction( true );

	// Add other players as physics entities for collision
	CL_SetSolidPlayers( cl.viewentity );
}

/*
=================
CL_SetSolidPlayers

Add other players as collision entities for prediction.
Uses predicted positions from CL_SetUpPlayerPrediction().
Ported from QuakeWorld cl_ents.c
=================
*/
function CL_SetSolidPlayers( playernum ) {
	if ( cl_solid_players.value === 0 )
		return;

	// Use predicted player positions
	for ( let j = 1; j < MAX_CLIENTS; j++ ) {
		const pplayer = predicted_players[ j ];

		// Skip inactive players
		if ( ! pplayer.active )
			continue;

		// Don't add ourselves
		if ( j === playernum )
			continue;

		// Skip dead players - they don't block movement (PF_DEAD flag)
		if ( ( pplayer.flags & PF_DEAD ) !== 0 )
			continue;

		// Add as a solid physics entity using predicted position
		const pent = pmove.physents[ pmove.numphysent ];
		pent.model = null; // Use box collision, not BSP
		VectorCopy( pplayer.origin, pent.origin );
		VectorCopy( player_mins, pent.mins );
		VectorCopy( player_maxs, pent.maxs );
		pent.info = j; // Store player number

		pmove.numphysent++;

		// Don't overflow the physents array
		if ( pmove.numphysent >= pmove.physents.length )
			break;
	}
}

/*
=================
CL_GetPredictedPlayer

Get the predicted position for a player (for rendering).
Returns null if player is not active.
=================
*/
export function CL_GetPredictedPlayer( playernum ) {
	if ( playernum < 0 || playernum >= MAX_CLIENTS )
		return null;

	const pplayer = predicted_players[ playernum ];
	if ( ! pplayer.active )
		return null;

	return pplayer;
}

/*
=================
CL_SetPlayerInfo

Called from CL_ParsePlayerInfo to set player state from server.
This stores the QuakeWorld-style player info for prediction.
=================
*/
export function CL_SetPlayerInfo( playernum, origin, velocity, frame, flags, skin, effects, weaponframe, msec, cmd ) {
	if ( playernum < 0 || playernum >= MAX_CLIENTS )
		return;

	const pplayer = predicted_players[ playernum ];
	pplayer.active = true;
	pplayer.msgtime = realtime;

	VectorCopy( origin, pplayer.origin );
	VectorCopy( velocity, pplayer.velocity );
	pplayer.frame = frame;
	pplayer.flags = flags;
	pplayer.skin = skin;
	pplayer.effects = effects;
	pplayer.weaponframe = weaponframe;
	pplayer.msec = msec;

	// Copy movement command if provided
	if ( cmd != null ) {
		pplayer.cmd.msec = cmd.msec;
		VectorCopy( cmd.angles, pplayer.cmd.angles );
		pplayer.cmd.forwardmove = cmd.forwardmove;
		pplayer.cmd.sidemove = cmd.sidemove;
		pplayer.cmd.upmove = cmd.upmove;
		pplayer.cmd.buttons = cmd.buttons;
		pplayer.cmd.impulse = cmd.impulse;
	}
}

/*
=================
CL_NudgePosition

If pmove.origin is in a solid position,
try nudging slightly on all axis to
allow for the cut precision of the net coordinates
=================
*/
function CL_NudgePosition() {
	if ( cl.worldmodel == null )
		return;

	const hull = cl.worldmodel.hulls[ 1 ];
	if ( PM_HullPointContents( hull, 0, pmove.origin ) === CONTENTS_EMPTY )
		return;

	const base = new Float32Array( 3 );
	VectorCopy( pmove.origin, base );

	for ( let x = -1; x <= 1; x++ ) {
		for ( let y = -1; y <= 1; y++ ) {
			pmove.origin[ 0 ] = base[ 0 ] + x * 1.0 / 8;
			pmove.origin[ 1 ] = base[ 1 ] + y * 1.0 / 8;
			if ( PM_HullPointContents( hull, 0, pmove.origin ) === CONTENTS_EMPTY )
				return;
		}
	}
}

/*
==============
CL_PredictUsercmd

Predict the result of a single user command
==============
*/
export function CL_PredictUsercmd( from, to, cmd, spectator ) {
	// Split up very long moves
	if ( cmd.msec > 50 ) {
		const temp = new player_state_t();
		const split = {
			msec: Math.floor( cmd.msec / 2 ),
			angles: cmd.angles,
			forwardmove: cmd.forwardmove,
			sidemove: cmd.sidemove,
			upmove: cmd.upmove,
			buttons: cmd.buttons
		};

		CL_PredictUsercmd( from, temp, split, spectator );
		CL_PredictUsercmd( temp, to, split, spectator );
		return;
	}

	VectorCopy( from.origin, pmove.origin );
	VectorCopy( cmd.angles, pmove.angles );
	VectorCopy( from.velocity, pmove.velocity );

	pmove.oldbuttons = from.oldbuttons;
	pmove.waterjumptime = from.waterjumptime;
	pmove.dead = cl.stats[ STAT_HEALTH ] <= 0;
	pmove.spectator = spectator;

	pmove.cmd.msec = cmd.msec;
	VectorCopy( cmd.angles, pmove.cmd.angles );
	pmove.cmd.forwardmove = cmd.forwardmove;
	pmove.cmd.sidemove = cmd.sidemove;
	pmove.cmd.upmove = cmd.upmove;
	pmove.cmd.buttons = cmd.buttons;

	PlayerMove();

	to.waterjumptime = pmove.waterjumptime;
	to.oldbuttons = pmove.cmd.buttons;
	VectorCopy( pmove.origin, to.origin );
	VectorCopy( pmove.angles, to.viewangles );
	VectorCopy( pmove.velocity, to.velocity );
	to.onground = PM_GetOnGround() !== -1; // Use proper onground from pmove

	to.weaponframe = from.weaponframe;
}

/*
==============
CL_PredictMove

Main prediction function - called each frame to predict local player position
==============
*/
export function CL_PredictMove() {
	if ( cl_pushlatency.value > 0 )
		cl_pushlatency.value = 0;

	if ( cl.paused )
		return;

	// Calculate the time we want to be at
	cl.time = realtime - cls_latency - cl_pushlatency.value * 0.001;
	if ( cl.time > realtime )
		cl.time = realtime;

	if ( cl.intermission !== 0 )
		return;

	// Check if we have valid server data to predict from
	if ( validsequence === 0 )
		return;

	// Check if we have valid frames to predict from
	if ( outgoing_sequence - incoming_sequence >= UPDATE_BACKUP - 1 )
		return;

	VectorCopy( cl.viewangles, cl_simangles );

	// Get the last acknowledged frame from server
	const from = frames[ incoming_sequence & UPDATE_MASK ];

	// If prediction is disabled, just use server position
	if ( cl_nopred.value !== 0 || sv.active ) {
		VectorCopy( from.playerstate.velocity, cl_simvel );
		VectorCopy( from.playerstate.origin, cl_simorg );
		cl_simonground = from.playerstate.onground ? 0 : -1;
		return;
	}

	// Set up pmove for collision
	CL_SetupPMove();

	// Predict forward from acknowledged state
	let to = null;
	let lastFrom = from;

	for ( let i = 1; i < UPDATE_BACKUP - 1 && incoming_sequence + i < outgoing_sequence; i++ ) {
		to = frames[ ( incoming_sequence + i ) & UPDATE_MASK ];
		CL_PredictUsercmd( lastFrom.playerstate, to.playerstate, to.cmd, false );

		if ( to.senttime >= cl.time )
			break;

		lastFrom = to;
	}

	if ( to == null )
		return;

	// Interpolate some fraction of the final frame
	let f;
	if ( to.senttime === lastFrom.senttime ) {
		f = 0;
	} else {
		f = ( cl.time - lastFrom.senttime ) / ( to.senttime - lastFrom.senttime );
		if ( f < 0 ) f = 0;
		if ( f > 1 ) f = 1;
	}

	// Check for teleport (large position change)
	for ( let i = 0; i < 3; i++ ) {
		if ( Math.abs( lastFrom.playerstate.origin[ i ] - to.playerstate.origin[ i ] ) > 128 ) {
			// Teleported, so don't lerp
			VectorCopy( to.playerstate.velocity, cl_simvel );
			VectorCopy( to.playerstate.origin, cl_simorg );
			cl_simonground = to.playerstate.onground ? 0 : -1;
			return;
		}
	}

	// Interpolate position and velocity
	for ( let i = 0; i < 3; i++ ) {
		cl_simorg[ i ] = lastFrom.playerstate.origin[ i ]
			+ f * ( to.playerstate.origin[ i ] - lastFrom.playerstate.origin[ i ] );
		cl_simvel[ i ] = lastFrom.playerstate.velocity[ i ]
			+ f * ( to.playerstate.velocity[ i ] - lastFrom.playerstate.velocity[ i ] );
	}

	// Set predicted onground state (use the latest predicted frame)
	cl_simonground = to.playerstate.onground ? 0 : -1;
}

/*
==============
CL_SetServerState

Called when we receive authoritative state from server
Updates the acknowledged frame's player state
==============
*/
export function CL_SetServerState( origin, velocity, onground ) {
	const frame = frames[ incoming_sequence & UPDATE_MASK ];
	VectorCopy( origin, frame.playerstate.origin );
	VectorCopy( velocity, frame.playerstate.velocity );
	frame.playerstate.onground = onground;
}

/*
==============
CL_InitPrediction
==============
*/
export function CL_InitPrediction() {
	Cvar_RegisterVariable( cl_pushlatency );
	Cvar_RegisterVariable( cl_nopred );
	Cvar_RegisterVariable( cl_solid_players );
	Cvar_RegisterVariable( cl_predict_players );
	Pmove_Init();
}

/*
==============
CL_ResetPrediction

Called on level change or disconnect
==============
*/
export function CL_ResetPrediction() {
	outgoing_sequence = 0;
	incoming_sequence = 0;
	validsequence = 0;
	cls_latency = 0;

	cl_simorg.fill( 0 );
	cl_simvel.fill( 0 );
	cl_simangles.fill( 0 );
	cl_simonground = -1;

	for ( let i = 0; i < UPDATE_BACKUP; i++ ) {
		frames[ i ].senttime = 0;
		frames[ i ].playerstate.origin.fill( 0 );
		frames[ i ].playerstate.velocity.fill( 0 );
	}
}
