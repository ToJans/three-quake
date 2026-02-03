// Ported from: WinQuake/cl_main.c -- client main loop

import { MAX_MODELS, MAX_SOUNDS, MAX_EDICTS, MAX_LIGHTSTYLES,
	STAT_HEALTH, STAT_FRAGS, STAT_WEAPON, STAT_AMMO, STAT_ARMOR,
	STAT_WEAPONFRAME, STAT_SHELLS, STAT_ACTIVEWEAPON, STAT_MONSTERS,
	STAT_SECRETS } from './quakedef.js';
import { PITCH, YAW, ROLL } from './quakedef.js';
import { Con_Printf, Con_DPrintf, SZ_Alloc, SZ_Clear,
	MSG_WriteByte, MSG_WriteString } from './common.js';
import { Sys_Error } from './sys.js';
import { NET_Connect, NET_SendMessage, NET_CanSendMessage, NET_Close } from './net_main.js';
import { cvar_t, Cvar_RegisterVariable } from './cvar.js';
import { Cmd_AddCommand } from './cmd.js';
import { Cbuf_InsertText } from './cmd.js';
import { clc_disconnect, clc_stringcmd } from './protocol.js';
import { CL_GetMessage, CL_PlayDemo_f } from './cl_demo.js';
import { CL_ParseServerMessage } from './cl_parse.js';
import { SIGNONS, MAX_DLIGHTS, MAX_EFRAGS, MAX_BEAMS, MAX_TEMP_ENTITIES,
	MAX_STATIC_ENTITIES, MAX_DEMOS, MAX_VISEDICTS,
	ca_dedicated, ca_disconnected, ca_connected,
	cl, cls, cl_efrags, cl_entities, cl_static_entities,
	cl_lightstyle, cl_dlights, cl_temp_entities, cl_beams,
	cl_numvisedicts, cl_visedicts, set_cl_numvisedicts,
	dlight_t, entity_t, efrag_t, lightstyle_t, beam_t,
	client_state_t, usercmd_t, cshift_t,
	NUM_CSHIFTS } from './client.js';
import { anglemod, VectorCopy, VectorSubtract, VectorMA, AngleVectors, DotProduct } from './mathlib.js';
import { R_RocketTrail, R_RemoveEfrags } from './render.js';
import { CL_InitTEnts, CL_UpdateTEnts } from './cl_tent.js';
import { host_frametime, realtime, host_framecount, Host_Error, Host_EndGame, sv } from './host.js';
import { SCR_EndLoadingPlaque, SCR_BeginLoadingPlaque } from './gl_screen.js';
import { S_StopAllSounds } from './snd_dma.js';
import { M_ConnectionError, M_ShouldReturnOnError } from './menu.js';
import { key_menu, set_key_dest } from './keys.js';
import { CL_InitPrediction, CL_ResetPrediction, CL_PredictMove,
	cl_simorg, cl_simvel, cl_simangles, cl_nopred } from './cl_pred.js';

// Re-export prediction state for view.js to use
export { cl_simorg, cl_simvel, cl_simangles, cl_nopred };

// we need to declare some mouse variables here, because the menu system
// references them even when on a unix system.

// these two are not intended to be set directly
export const cl_name = new cvar_t( '_cl_name', 'player', true );
export const cl_color = new cvar_t( '_cl_color', '0', true );

export const cl_shownet = new cvar_t( 'cl_shownet', '0' ); // can be 0, 1, or 2
export const cl_nolerp = new cvar_t( 'cl_nolerp', '0' );

export const lookspring = new cvar_t( 'lookspring', '0', true );
export const lookstrafe = new cvar_t( 'lookstrafe', '0', true );
export const sensitivity = new cvar_t( 'sensitivity', '3', true );

export const m_pitch = new cvar_t( 'm_pitch', '0.022', true );
export const m_yaw = new cvar_t( 'm_yaw', '0.022', true );
export const m_forward = new cvar_t( 'm_forward', '1', true );
export const m_side = new cvar_t( 'm_side', '0.8', true );

/*
=====================
CL_ClearState

=====================
*/
export function CL_ClearState() {

	// if (!sv.active)
	//     Host_ClearMemory();

	// Reset client-side prediction state
	CL_ResetPrediction();

	// wipe the entire cl structure
	// In JS we reset the fields instead of memset
	cl.movemessages = 0;
	cl.cmd = new usercmd_t();
	cl.stats.fill( 0 );
	cl.items = 0;
	cl.item_gettime.fill( 0 );
	cl.faceanimtime = 0;

	for ( let i = 0; i < NUM_CSHIFTS; i ++ ) {

		cl.cshifts[ i ].destcolor[ 0 ] = 0;
		cl.cshifts[ i ].destcolor[ 1 ] = 0;
		cl.cshifts[ i ].destcolor[ 2 ] = 0;
		cl.cshifts[ i ].percent = 0;
		cl.prev_cshifts[ i ].destcolor[ 0 ] = 0;
		cl.prev_cshifts[ i ].destcolor[ 1 ] = 0;
		cl.prev_cshifts[ i ].destcolor[ 2 ] = 0;
		cl.prev_cshifts[ i ].percent = 0;

	}

	cl.mviewangles[ 0 ].fill( 0 );
	cl.mviewangles[ 1 ].fill( 0 );
	cl.viewangles.fill( 0 );
	cl.mvelocity[ 0 ].fill( 0 );
	cl.mvelocity[ 1 ].fill( 0 );
	cl.velocity.fill( 0 );
	cl.punchangle.fill( 0 );
	cl.idealpitch = 0;
	cl.pitchvel = 0;
	cl.nodrift = false;
	cl.driftmove = 0;
	cl.laststop = 0;
	cl.viewheight = 0;
	cl.crouch = 0;
	cl.paused = false;
	cl.onground = false;
	cl.inwater = false;
	cl.intermission = 0;
	cl.completed_time = 0;
	cl.mtime[ 0 ] = 0;
	cl.mtime[ 1 ] = 0;
	cl.time = 0;
	cl.oldtime = 0;
	cl.last_received_message = 0;
	cl.model_precache.fill( null );
	cl.sound_precache.fill( null );
	cl.levelname = '';
	cl.viewentity = 0;
	cl.maxclients = 0;
	cl.gametype = 0;
	cl.worldmodel = null;
	cl.free_efrags = null;
	cl.num_entities = 0;
	cl.num_statics = 0;
	cl.viewent = new entity_t();
	cl.cdtrack = 0;
	cl.looptrack = 0;
	cl.scores = null;

	SZ_Clear( cls.message );

	// clear other arrays
	for ( let i = 0; i < MAX_EFRAGS; i ++ ) {

		cl_efrags[ i ].leaf = null;
		cl_efrags[ i ].leafnext = null;
		cl_efrags[ i ].entity = null;
		cl_efrags[ i ].entnext = null;

	}

	for ( let i = 0; i < MAX_EDICTS; i ++ )
		cl_entities[ i ] = new entity_t();

	for ( let i = 0; i < MAX_DLIGHTS; i ++ )
		cl_dlights[ i ] = new dlight_t();

	for ( let i = 0; i < MAX_LIGHTSTYLES; i ++ )
		cl_lightstyle[ i ] = new lightstyle_t();

	for ( let i = 0; i < MAX_TEMP_ENTITIES; i ++ )
		cl_temp_entities[ i ] = new entity_t();

	for ( let i = 0; i < MAX_BEAMS; i ++ )
		cl_beams[ i ] = new beam_t();

	//
	// allocate the efrags and chain together into a free list
	//
	cl.free_efrags = cl_efrags[ 0 ];
	for ( let i = 0; i < MAX_EFRAGS - 1; i ++ )
		cl_efrags[ i ].entnext = cl_efrags[ i + 1 ];
	cl_efrags[ MAX_EFRAGS - 1 ].entnext = null;

}

/*
=====================
CL_Disconnect

Sends a disconnect message to the server
This is also called on Host_Error, so it shouldn't cause any errors
=====================
*/
export function CL_Disconnect() {

	// stop sounds (especially looping!)
	S_StopAllSounds( true );

	// bring the console down and fade the colors back to normal
	// SCR_BringDownConsole();

	// if running a local server, shut it down
	if ( cls.demoplayback ) {

		CL_StopPlayback();

	} else if ( cls.state === ca_connected ) {

		if ( cls.demorecording )
			CL_Stop_f();

		Con_DPrintf( 'Sending clc_disconnect\n' );
		SZ_Clear( cls.message );
		MSG_WriteByte( cls.message, clc_disconnect );
		// NET_SendUnreliableMessage( cls.netcon, cls.message );
		SZ_Clear( cls.message );

		if ( cls.netcon != null ) {

			NET_Close( cls.netcon );
			cls.netcon = null;

		}

		cls.state = ca_disconnected;
		// if ( sv.active )
		//     Host_ShutdownServer( false );

	}

	cls.demoplayback = cls.timedemo = false;
	cls.signon = 0;

	// Clear room from browser URL on disconnect
	if ( typeof window !== 'undefined' && window.location.search.includes( 'room=' ) ) {

		history.replaceState( null, '', window.location.pathname );

	}

}

export function CL_Disconnect_f() {

	CL_Disconnect();
	// if ( sv.active )
	//     Host_ShutdownServer( false );

}

/*
=====================
CL_EstablishConnection

Host should be either "local" or a net address to be passed on
For remote connections, this handles async WebTransport connections.
=====================
*/
export async function CL_EstablishConnection( host ) {

	if ( cls.state === ca_dedicated )
		return;

	if ( cls.demoplayback )
		return;

	CL_Disconnect();

	try {

		// NET_Connect may return a Promise for async connections (WebTransport)
		const result = NET_Connect( host );
		if ( result instanceof Promise ) {

			// Async connection (WebTransport) with timeout
			Con_Printf( 'Connecting to %s...\n', host );

			// 30-second timeout for connection attempts
			const CONNECTION_TIMEOUT_MS = 30000;
			const timeoutPromise = new Promise( ( _, reject ) => {

				setTimeout( () => reject( new Error( 'Connection timed out after 30 seconds' ) ), CONNECTION_TIMEOUT_MS );

			} );

			cls.netcon = await Promise.race( [ result, timeoutPromise ] );

		} else {

			// Sync connection (loopback)
			cls.netcon = result;

		}

	} catch ( error ) {

		// Connection failed with error
		Con_Printf( 'CL_Connect: %s\n', error.message || 'connection failed' );

		// Return to menu if we should
		if ( M_ShouldReturnOnError() ) {

			M_ConnectionError( error.message || 'Connection failed' );
			set_key_dest( key_menu );

		}

		return;

	}

	if ( ! cls.netcon ) {

		Con_Printf( 'CL_Connect: connect failed\n' );

		// Return to menu if we should
		if ( M_ShouldReturnOnError() ) {

			M_ConnectionError( 'Connection refused' );
			set_key_dest( key_menu );

		}

		return;

	}

	Con_DPrintf( 'CL_EstablishConnection: connected to %s\n', host );

	// Update browser URL with room ID for sharing
	if ( typeof window !== 'undefined' && host.includes( '?room=' ) ) {

		try {

			const url = new URL( host );
			const roomId = url.searchParams.get( 'room' );
			if ( roomId ) {

				const shareUrl = window.location.origin + window.location.pathname + '?room=' + roomId;
				history.replaceState( null, '', shareUrl );

			}

		} catch ( e ) {

			// Ignore URL parsing errors

		}

	}

	cls.demonum = - 1; // not in the demo loop now
	cls.state = ca_connected;
	cls.signon = 0; // need all the signon messages before playing

}

/*
=====================
CL_SignonReply

An svc_signonnum has been received, perform a client side setup
=====================
*/
export function CL_SignonReply() {

	Con_DPrintf( 'CL_SignonReply: %i\n', cls.signon );

	switch ( cls.signon ) {

		case 1:
			MSG_WriteByte( cls.message, clc_stringcmd );
			MSG_WriteString( cls.message, 'prespawn' );
			break;

		case 2:
			MSG_WriteByte( cls.message, clc_stringcmd );
			MSG_WriteString( cls.message, 'name "' + cl_name.string + '"\n' );

			MSG_WriteByte( cls.message, clc_stringcmd );
			MSG_WriteString( cls.message, 'color ' + ( ( cl_color.value | 0 ) >> 4 ) + ' ' + ( ( cl_color.value | 0 ) & 15 ) + '\n' );

			MSG_WriteByte( cls.message, clc_stringcmd );
			MSG_WriteString( cls.message, 'spawn ' + cls.spawnparms );
			break;

		case 3:
			MSG_WriteByte( cls.message, clc_stringcmd );
			MSG_WriteString( cls.message, 'begin' );
			// Cache_Report();  // print remaining memory
			break;

		case 4:
			SCR_EndLoadingPlaque(); // allow normal screen updates
			break;

	}

}

/*
=====================
CL_NextDemo

Called to play the next demo in the demo loop
=====================
*/
export function CL_NextDemo() {

	if ( cls.demonum === - 1 )
		return; // don't play demos

	SCR_BeginLoadingPlaque();

	if ( ! cls.demos[ cls.demonum ] || cls.demonum === MAX_DEMOS ) {

		cls.demonum = 0;
		if ( ! cls.demos[ cls.demonum ] ) {

			Con_Printf( 'No demos listed with startdemos\n' );
			cls.demonum = - 1;
			return;

		}

	}

	Cbuf_InsertText( 'playdemo ' + cls.demos[ cls.demonum ] + '\n' );
	cls.demonum ++;

}

/*
==============
CL_PrintEntities_f
==============
*/
function CL_PrintEntities_f() {

	for ( let i = 0; i < cl.num_entities; i ++ ) {

		const ent = cl_entities[ i ];
		Con_Printf( '%3i:', i );
		if ( ! ent.model ) {

			Con_Printf( 'EMPTY\n' );
			continue;

		}

		Con_Printf( '%s:%2i  (%5.1f,%5.1f,%5.1f) [%5.1f %5.1f %5.1f]\n',
			ent.model.name, ent.frame,
			ent.origin[ 0 ], ent.origin[ 1 ], ent.origin[ 2 ],
			ent.angles[ 0 ], ent.angles[ 1 ], ent.angles[ 2 ] );

	}

}

/*
===============
CL_AllocDlight

===============
*/
export function CL_AllocDlight( key ) {

	// first look for an exact key match
	if ( key ) {

		for ( let i = 0; i < MAX_DLIGHTS; i ++ ) {

			if ( cl_dlights[ i ].key === key ) {

				const dl = cl_dlights[ i ];
				dl.origin.fill( 0 );
				dl.radius = 0;
				dl.die = 0;
				dl.decay = 0;
				dl.minlight = 0;
				dl.key = key;
				return dl;

			}

		}

	}

	// then look for anything else
	for ( let i = 0; i < MAX_DLIGHTS; i ++ ) {

		if ( cl_dlights[ i ].die < cl.time ) {

			const dl = cl_dlights[ i ];
			dl.origin.fill( 0 );
			dl.radius = 0;
			dl.die = 0;
			dl.decay = 0;
			dl.minlight = 0;
			dl.key = key;
			return dl;

		}

	}

	const dl = cl_dlights[ 0 ];
	dl.origin.fill( 0 );
	dl.radius = 0;
	dl.die = 0;
	dl.decay = 0;
	dl.minlight = 0;
	dl.key = key;
	return dl;

}

/*
===============
CL_DecayLights

===============
*/
export function CL_DecayLights() {

	const time = cl.time - cl.oldtime;

	for ( let i = 0; i < MAX_DLIGHTS; i ++ ) {

		const dl = cl_dlights[ i ];
		if ( dl.die < cl.time || dl.radius <= 0 )
			continue;

		dl.radius -= time * dl.decay;
		if ( dl.radius < 0 )
			dl.radius = 0;

	}

}

/*
===============
CL_LerpPoint

Determines the fraction between the last two messages that the objects
should be put at.
===============
*/
export function CL_LerpPoint() {

	let f = cl.mtime[ 0 ] - cl.mtime[ 1 ];

	if ( ! f || cl_nolerp.value || cls.timedemo /* || sv.active */ ) {

		cl.time = cl.mtime[ 0 ];
		return 1;

	}

	if ( f > 0.1 ) {

		// dropped packet, or start of demo
		cl.mtime[ 1 ] = cl.mtime[ 0 ] - 0.1;
		f = 0.1;

	}

	let frac = ( cl.time - cl.mtime[ 1 ] ) / f;

	if ( frac < 0 ) {

		if ( frac < - 0.01 ) {

			cl.time = cl.mtime[ 1 ];

		}

		frac = 0;

	} else if ( frac > 1 ) {

		if ( frac > 1.01 ) {

			cl.time = cl.mtime[ 0 ];

		}

		frac = 1;

	}

	return frac;

}

/*
===============
CL_RelinkEntities
===============
*/
export function CL_RelinkEntities() {

	// determine partial update time
	const frac = CL_LerpPoint();

	set_cl_numvisedicts( 0 );

	// Add static entities (torches, flames, etc.) to visedicts.
	// Bypasses the unimplemented efrag system — safe because r_novis=1.
	for ( let i = 0; i < cl.num_statics; i ++ ) {
		if ( cl_numvisedicts >= MAX_VISEDICTS ) break;
		const ent = cl_static_entities[ i ];
		if ( ! ent.model ) continue;
		cl_visedicts[ cl_numvisedicts ] = ent;
		set_cl_numvisedicts( cl_numvisedicts + 1 );
	}

	//
	// interpolate player info
	//
	for ( let i = 0; i < 3; i ++ )
		cl.velocity[ i ] = cl.mvelocity[ 1 ][ i ] +
			frac * ( cl.mvelocity[ 0 ][ i ] - cl.mvelocity[ 1 ][ i ] );

	if ( cls.demoplayback ) {

		// interpolate the angles
		for ( let j = 0; j < 3; j ++ ) {

			let d = cl.mviewangles[ 0 ][ j ] - cl.mviewangles[ 1 ][ j ];
			if ( d > 180 )
				d -= 360;
			else if ( d < - 180 )
				d += 360;
			cl.viewangles[ j ] = cl.mviewangles[ 1 ][ j ] + frac * d;

		}

	}

	const bobjrotate = anglemod( 100 * cl.time );

	// start on the entity after the world
	for ( let i = 1; i < cl.num_entities; i ++ ) {

		const ent = cl_entities[ i ];
		if ( ! ent.model ) {

			// empty slot
			if ( ent.forcelink ) {

				R_RemoveEfrags( ent ); // just became empty

			}

			continue;

		}

		// if the object wasn't included in the last packet, remove it
		if ( ent.msgtime !== cl.mtime[ 0 ] ) {

			ent.model = null;
			continue;

		}

		const oldorg = new Float32Array( 3 );
		VectorCopy( ent.origin, oldorg );

		if ( ent.forcelink ) {

			// the entity was not updated in the last message
			// so move to the final spot
			VectorCopy( ent.msg_origins[ 0 ], ent.origin );
			VectorCopy( ent.msg_angles[ 0 ], ent.angles );

		} else {

			// if the delta is large, assume a teleport and don't lerp
			let f = frac;
			const delta = new Float32Array( 3 );
			for ( let j = 0; j < 3; j ++ ) {

				delta[ j ] = ent.msg_origins[ 0 ][ j ] - ent.msg_origins[ 1 ][ j ];
				if ( delta[ j ] > 100 || delta[ j ] < - 100 )
					f = 1; // assume a teleportation, not a motion

			}

			// interpolate the origin and angles
			for ( let j = 0; j < 3; j ++ ) {

				ent.origin[ j ] = ent.msg_origins[ 1 ][ j ] + f * delta[ j ];

				let d = ent.msg_angles[ 0 ][ j ] - ent.msg_angles[ 1 ][ j ];
				if ( d > 180 )
					d -= 360;
				else if ( d < - 180 )
					d += 360;
				ent.angles[ j ] = ent.msg_angles[ 1 ][ j ] + f * d;

			}

		}

		// rotate binary objects locally
		if ( ent.model && ent.model.flags & 0x0004 ) // EF_ROTATE
			ent.angles[ 1 ] = bobjrotate;

		if ( ent.effects & 0x0002 ) { // EF_MUZZLEFLASH

			const fv = new Float32Array( 3 );
			const rv = new Float32Array( 3 );
			const uv = new Float32Array( 3 );

			const dl = CL_AllocDlight( i );
			VectorCopy( ent.origin, dl.origin );
			dl.origin[ 2 ] += 16;
			AngleVectors( ent.angles, fv, rv, uv );

			VectorMA( dl.origin, 18, fv, dl.origin );
			dl.radius = 200 + ( Math.random() * 32 | 0 );
			dl.minlight = 32;
			dl.die = cl.time + 0.1;

		}

		if ( ent.effects & 0x0004 ) { // EF_BRIGHTLIGHT

			const dl = CL_AllocDlight( i );
			VectorCopy( ent.origin, dl.origin );
			dl.origin[ 2 ] += 16;
			dl.radius = 400 + ( Math.random() * 32 | 0 );
			dl.die = cl.time + 0.001;

		}

		if ( ent.effects & 0x0008 ) { // EF_DIMLIGHT

			const dl = CL_AllocDlight( i );
			VectorCopy( ent.origin, dl.origin );
			dl.radius = 200 + ( Math.random() * 32 | 0 );
			dl.die = cl.time + 0.001;

		}

		// particle trails
		if ( ent.model && ent.model.flags ) {

			if ( ent.model.flags & 0x04 ) // EF_GIB
				R_RocketTrail( oldorg, ent.origin, 2 );
			else if ( ent.model.flags & 0x20 ) // EF_ZOMGIB
				R_RocketTrail( oldorg, ent.origin, 4 );
			else if ( ent.model.flags & 0x10 ) // EF_TRACER
				R_RocketTrail( oldorg, ent.origin, 3 );
			else if ( ent.model.flags & 0x40 ) // EF_TRACER2
				R_RocketTrail( oldorg, ent.origin, 5 );
			else if ( ent.model.flags & 0x01 ) { // EF_ROCKET

				R_RocketTrail( oldorg, ent.origin, 0 );
				const dl = CL_AllocDlight( i );
				VectorCopy( ent.origin, dl.origin );
				dl.radius = 200;
				dl.die = cl.time + 0.01;

			}
			else if ( ent.model.flags & 0x02 ) // EF_GRENADE
				R_RocketTrail( oldorg, ent.origin, 1 );
			else if ( ent.model.flags & 0x80 ) // EF_TRACER3
				R_RocketTrail( oldorg, ent.origin, 6 );

		}

		ent.forcelink = false;

		if ( i === cl.viewentity /* && ! chase_active.value */ )
			continue;

		if ( cl_numvisedicts < MAX_VISEDICTS ) {

			cl_visedicts[ cl_numvisedicts ] = ent;
			set_cl_numvisedicts( cl_numvisedicts + 1 );

		}

	}

}

/*
===============
CL_ReadFromServer

Read all incoming data from the server
===============
*/
export function CL_ReadFromServer() {

	cl.oldtime = cl.time;
	cl.time += host_frametime;

	let ret;
	do {

		ret = CL_GetMessage();

		if ( ret === - 1 )
			Host_Error( 'CL_ReadFromServer: lost server connection' );

		if ( ! ret )
			break;

		cl.last_received_message = realtime;
		CL_ParseServerMessage();

	} while ( ret && cls.state === ca_connected );

	if ( cl_shownet.value )
		Con_Printf( '\n' );

	CL_RelinkEntities();
	CL_UpdateTEnts();

	// Client-side prediction (QuakeWorld style)
	// Predicts local player position for responsive movement with low server tick rates
	if ( ! sv.active ) {

		CL_PredictMove();

	}

	return 0;

}

/*
=================
CL_SendCmd
=================
*/
export function CL_SendCmd() {

	if ( cls.state !== ca_connected )
		return;

	if ( cls.signon === SIGNONS ) {

		// get basic movement from keyboard
		const cmd = new usercmd_t();
		CL_BaseMove( cmd );

		// allow mice or other external controllers to add to the move
		IN_Move( cmd );

		// send the unreliable message
		CL_SendMove( cmd );

	}

	if ( cls.demoplayback ) {

		SZ_Clear( cls.message );
		return;

	}

	// send the reliable message
	if ( ! cls.message.cursize )
		return; // no message at all

	if ( ! NET_CanSendMessage( cls.netcon ) ) {

		Con_DPrintf( 'CL_WriteToServer: can\'t send\n' );
		return;

	}

	if ( NET_SendMessage( cls.netcon, cls.message ) === - 1 )
		Host_Error( 'CL_WriteToServer: lost server connection' );

	SZ_Clear( cls.message );

}

/*
=================
CL_Init
=================
*/
export function CL_Init() {

	SZ_Alloc( cls.message, 1024 );

	CL_InitInput();
	CL_InitTEnts();
	CL_InitPrediction();

	//
	// register our commands
	//
	Cvar_RegisterVariable( cl_name );
	Cvar_RegisterVariable( cl_color );
	Cvar_RegisterVariable( cl_upspeed );
	Cvar_RegisterVariable( cl_forwardspeed );
	Cvar_RegisterVariable( cl_backspeed );
	Cvar_RegisterVariable( cl_sidespeed );
	Cvar_RegisterVariable( cl_movespeedkey );
	Cvar_RegisterVariable( cl_yawspeed );
	Cvar_RegisterVariable( cl_pitchspeed );
	Cvar_RegisterVariable( cl_anglespeedkey );
	Cvar_RegisterVariable( cl_shownet );
	Cvar_RegisterVariable( cl_nolerp );
	Cvar_RegisterVariable( lookspring );
	Cvar_RegisterVariable( lookstrafe );
	Cvar_RegisterVariable( sensitivity );

	Cvar_RegisterVariable( m_pitch );
	Cvar_RegisterVariable( m_yaw );
	Cvar_RegisterVariable( m_forward );
	Cvar_RegisterVariable( m_side );

	Cmd_AddCommand( 'entities', CL_PrintEntities_f );
	Cmd_AddCommand( 'disconnect', CL_Disconnect_f );
	// Cmd_AddCommand( 'record', CL_Record_f );
	// Cmd_AddCommand( 'stop', CL_Stop_f );
	Cmd_AddCommand( 'playdemo', CL_PlayDemo_f );
	// Cmd_AddCommand( 'timedemo', CL_TimeDemo_f );

}

// These are imported from cl_input.js -- declared as stubs for now
// to avoid circular dependency issues. They will be replaced when cl_input.js is loaded.
function CL_InitInput() {

	CL_InitInput_impl();

}

// CL_InitTEnts: imported from cl_tent.js

// Import from cl_demo.js stubs
function CL_StopPlayback() {

	// Will be implemented in cl_demo.js

}

function CL_Stop_f() {

	// Will be implemented in cl_demo.js

}

// Forward declarations for cvars and functions defined in cl_input.js
import { cl_upspeed, cl_forwardspeed, cl_backspeed, cl_sidespeed,
	cl_movespeedkey, cl_yawspeed, cl_pitchspeed,
	cl_anglespeedkey,
	CL_InitInput as CL_InitInput_impl,
	CL_BaseMove, CL_SendMove } from './cl_input.js';
import { IN_Move } from './in_web.js';
