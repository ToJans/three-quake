// Ported from: QuakeWorld/client/cl_pred.c
// Client-side prediction for smooth movement with low server tick rates

import { VectorCopy, VectorSubtract } from './mathlib.js';
import { cvar_t, Cvar_RegisterVariable } from './cvar.js';
import { pmove, movevars, PlayerMove, PM_HullPointContents, Pmove_Init } from './pmove.js';
import { CONTENTS_EMPTY } from './bspfile.js';
import { cl, cls, ca_connected } from './client.js';
import { STAT_HEALTH } from './quakedef.js';
import { realtime, sv } from './host.js';

// CVars
export const cl_nopred = new cvar_t( 'cl_nopred', '0' );
export const cl_pushlatency = new cvar_t( 'pushlatency', '-999' );

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

// Predicted position (used for rendering)
export const cl_simorg = new Float32Array( 3 ); // Simulated/predicted origin
export const cl_simvel = new Float32Array( 3 ); // Simulated/predicted velocity
export const cl_simangles = new Float32Array( 3 ); // Simulated angles

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

	// TODO: Add other players as physics entities for collision
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
	to.onground = pmove.numtouch > 0; // Simplified onground check

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
	cls_latency = 0;

	cl_simorg.fill( 0 );
	cl_simvel.fill( 0 );
	cl_simangles.fill( 0 );

	for ( let i = 0; i < UPDATE_BACKUP; i++ ) {
		frames[ i ].senttime = 0;
		frames[ i ].playerstate.origin.fill( 0 );
		frames[ i ].playerstate.velocity.fill( 0 );
	}
}
