// Ported from: WinQuake/gl_rmain.c -- main GL renderer
// + WinQuake/glquake.h -- GL definitions

import * as THREE from 'three';
import { Sys_Error, Sys_FloatTime } from './sys.js';
import { Con_Printf, Con_DPrintf, COM_CheckParm } from './common.js';
import { PITCH, YAW, ROLL } from './quakedef.js';
import { cvar_t } from './cvar.js';
import { vid, renderer } from './vid.js';
import { r_refdef, r_origin, vpn, vright, vup, entity_t } from './render.js';
import {
	M_PI, DotProduct, VectorCopy, VectorAdd, VectorSubtract, VectorMA,
	VectorNormalize, AngleVectors, Length, RotatePointAroundVector, BoxOnPlaneSide
} from './mathlib.js';
import { R_DrawWorld as R_DrawWorld_impl, R_MarkLeaves as R_MarkLeaves_impl, GL_BuildLightmaps as GL_BuildLightmaps_rsurf, R_DrawBrushModel as R_DrawBrushModel_rsurf, R_DrawWaterSurfaces as R_DrawWaterSurfaces_rsurf, R_CleanupWaterMeshes as R_CleanupWaterMeshes_rsurf } from './gl_rsurf.js';
import { Mod_PointInLeaf, Mod_LeafPVS, Mod_Extradata } from './gl_model.js';
import { R_AnimateLight as R_AnimateLight_impl, R_PushDlights as R_PushDlights_impl, R_RenderDlights as R_RenderDlights_impl, R_LightPoint } from './gl_rlight.js';
import { R_DrawAliasModel as R_DrawAliasModel_mesh } from './gl_mesh.js';
import { r_avertexnormal_dots } from './anorm_dots.js';
import { V_SetContentsColor as V_SetContentsColor_view, V_CalcBlend as V_CalcBlend_view, v_blend as v_blend_view } from './view.js';
import {
	R_InitParticles, R_SetParticleExternals, R_ClearParticles,
	R_DrawParticles as R_DrawParticles_impl
} from './r_part.js';
import { Debug_UpdateOverlay, Debug_ClearLabels } from './debug_overlay.js';
import {
	GTAO_Init, GTAO_Apply, GTAO_SetEnabled, GTAO_SetRadius, GTAO_SetIntensity, GTAO_SetDebugMode
} from './gl_gtao.js';
import {
	Bloom_Init, Bloom_Apply, Bloom_SetEnabled, Bloom_SetThreshold, Bloom_SetIntensity,
	Bloom_SetRadius, Bloom_SetDebugMode, Bloom_ApplyToTarget, Bloom_GetSceneTarget
} from './gl_bloom.js';
import {
	Tonemapping_Init, Tonemapping_Apply, Tonemapping_SetEnabled, Tonemapping_SetOperator,
	Tonemapping_SetExposure, Tonemapping_SetGamma, Tonemapping_SetDebugMode,
	Tonemapping_ApplyToTexture
} from './gl_tonemapping.js';
import {
	cl, cl_visedicts, cl_numvisedicts, cl_dlights, cl_entities,
	cl_lightstyle
} from './client.js';
import { d_lightstylevalue } from './glquake.js';
export { GL_BuildLightmaps_rsurf as GL_BuildLightmaps };

//============================================================================
// glquake.h constants
//============================================================================

export const ALIAS_BASE_SIZE_RATIO = ( 1.0 / 11.0 );
export const MAX_LBM_HEIGHT = 480;

export const TILE_SIZE = 128;
export const SKYSHIFT = 7;
export const SKYSIZE = ( 1 << SKYSHIFT );
export const SKYMASK = ( SKYSIZE - 1 );

export const BACKFACE_EPSILON = 0.01;

export const VERTEXSIZE = 7; // x, y, z, s, t, lightmap_s, lightmap_t

// plane types for fast side tests
export const PLANE_X = 0;
export const PLANE_Y = 1;
export const PLANE_Z = 2;
export const PLANE_ANYZ = 3;

// model types
export const mod_brush = 0;
export const mod_sprite = 1;
export const mod_alias = 2;

// surface flags
export const SURF_PLANEBACK = 2;
export const SURF_DRAWSKY = 4;
export const SURF_DRAWSPRITE = 8;
export const SURF_DRAWTURB = 0x10;
export const SURF_DRAWTILED = 0x20;
export const SURF_DRAWBACKGROUND = 0x40;
export const SURF_UNDERWATER = 0x80;

// max dlights
export const MAX_DLIGHTS = 32;
export const MAXLIGHTMAPS = 4;
export const MAX_VISEDICTS = 256;

//============================================================================
// Globals from gl_rmain.c
//============================================================================

export const r_worldentity = new entity_t();

export let r_cache_thrash = false; // compatability

export const modelorg = new Float32Array( 3 );
export const r_entorigin = new Float32Array( 3 );
export let currententity = null; // entity_t pointer

export let r_visframecount = 0; // bumped when going to a new PVS
export let r_framecount = 0; // used for dlight push checking

// frustum planes (4 planes for view frustum)
export class mplane_t {

	constructor() {

		this.normal = new Float32Array( 3 );
		this.dist = 0;
		this.type = 0; // for texture axis selection and fast side tests
		this.signbits = 0; // signx + signy<<1 + signz<<2

	}

}

export const frustum = [
	new mplane_t(), new mplane_t(), new mplane_t(), new mplane_t()
];

export let c_brush_polys = 0;
export let c_alias_polys = 0;

export let envmap = false; // true during envmap command capture

export let currenttexture = - 1; // to avoid unnecessary texture sets
export const cnttextures = [ - 1, - 1 ]; // cached

export let particletexture = 0; // little dot for particles
export let playertextures = 0; // up to 16 color translated skins

export let mirrortexturenum = 0; // quake texturenum, not gltexturenum
export let mirror = false;
export let mirror_plane = null; // mplane_t pointer

export const r_world_matrix = new Float32Array( 16 );
const r_base_world_matrix = new Float32Array( 16 );

export let r_viewleaf = null; // mleaf_t
export let r_oldviewleaf = null; // mleaf_t

export let r_notexture_mip = null;

// d_lightstylevalue is imported from glquake.js and re-exported here
// so gl_rsurf.js can import it (avoids circular dep with gl_rlight.js)
export { d_lightstylevalue };

export let gldepthmin = 0;
export let gldepthmax = 1;

// Setter functions for mutable state (ES module imports are read-only)
export function set_r_visframecount( v ) { r_visframecount = v; }
export function inc_r_visframecount() { return ++ r_visframecount; }
export function set_r_framecount( v ) { r_framecount = v; }
export function inc_r_framecount() { return ++ r_framecount; }
export function set_c_brush_polys( v ) { c_brush_polys = v; }
export function inc_c_brush_polys() { return ++ c_brush_polys; }
export function set_currenttexture( v ) { currenttexture = v; }
export function set_r_oldviewleaf( v ) { r_oldviewleaf = v; }
export function set_r_viewleaf( v ) { r_viewleaf = v; }
export function set_mirror( v ) { mirror = v; }
export function set_mirror_plane( v ) { mirror_plane = v; }

export let glx = 0, gly = 0, glwidth = 0, glheight = 0;

//============================================================================
// Three.js scene and camera (replace raw GL state)
//============================================================================

export let scene = null; // THREE.Scene
export let camera = null; // THREE.PerspectiveCamera

//============================================================================
// Cvars
//============================================================================

export const r_norefresh = new cvar_t( 'r_norefresh', '0' );
export const r_drawentities = new cvar_t( 'r_drawentities', '1' );
export const r_drawviewmodel = new cvar_t( 'r_drawviewmodel', '1' );
export const r_speeds = new cvar_t( 'r_speeds', '0' );
export const r_fullbright = new cvar_t( 'r_fullbright', '0' );
export const r_lightmap = new cvar_t( 'r_lightmap', '0' );
export const r_shadows = new cvar_t( 'r_shadows', '0' );
export const r_mirroralpha = new cvar_t( 'r_mirroralpha', '1' );
export const r_wateralpha = new cvar_t( 'r_wateralpha', '1' );
export const r_dynamic = new cvar_t( 'r_dynamic', '1' );
export const r_novis = new cvar_t( 'r_novis', '0' );
export const r_drawworld = new cvar_t( 'r_drawworld', '1' );
export const r_waterwarp = new cvar_t( 'r_waterwarp', '1' );

export const gl_finish = new cvar_t( 'gl_finish', '0' );
export const gl_clear = new cvar_t( 'gl_clear', '0' );
export const gl_cull = new cvar_t( 'gl_cull', '1' );
export const gl_texsort = new cvar_t( 'gl_texsort', '1' );
export const gl_smoothmodels = new cvar_t( 'gl_smoothmodels', '1' );
export const gl_affinemodels = new cvar_t( 'gl_affinemodels', '0' );
export const gl_polyblend = new cvar_t( 'gl_polyblend', '1' );
export const gl_flashblend = new cvar_t( 'gl_flashblend', '1' );
export const gl_playermip = new cvar_t( 'gl_playermip', '0' );
export const gl_nocolors = new cvar_t( 'gl_nocolors', '0' );
export const gl_keeptjunctions = new cvar_t( 'gl_keeptjunctions', '0' );
export const gl_reporttjunctions = new cvar_t( 'gl_reporttjunctions', '0' );
export const gl_doubleeyes = new cvar_t( 'gl_doubleeyes', '1' );
export const gl_ztrick = new cvar_t( 'gl_ztrick', '1' );
export const gl_max_size = new cvar_t( 'gl_max_size', '1024' );

//============================================================================
// HQ Visual Fidelity Cvars (cg_hq_*)
//============================================================================

// Master bitmask: bit 0=SSR, bit 1=AO, bit 2=GI, bit 3=Bloom, bit 4=Shadows, bit 5=Volumetric, bit 6=Tonemapping
export const cg_hq = new cvar_t( 'cg_hq', '0', true ); // archived

// Individual feature toggles
export const cg_hq_ao = new cvar_t( 'cg_hq_ao', '1', true ); // Ambient Occlusion (GTAO)
export const cg_hq_ao_radius = new cvar_t( 'cg_hq_ao_radius', '2.0', true );
export const cg_hq_ao_intensity = new cvar_t( 'cg_hq_ao_intensity', '1.5', true );
export const cg_hq_ao_debug = new cvar_t( 'cg_hq_ao_debug', '0' ); // 0=off, 1=white, 2=AO, 3=depth, 4=normals

// Bloom cvars
export const cg_hq_bloom = new cvar_t( 'cg_hq_bloom', '1', true ); // HDR Bloom
export const cg_hq_bloom_threshold = new cvar_t( 'cg_hq_bloom_threshold', '0.05', true );
export const cg_hq_bloom_intensity = new cvar_t( 'cg_hq_bloom_intensity', '1.7', true );
export const cg_hq_bloom_radius = new cvar_t( 'cg_hq_bloom_radius', '0.3', true ); // Blur spread multiplier
export const cg_hq_bloom_debug = new cvar_t( 'cg_hq_bloom_debug', '0' ); // 0=off, 1=bloom, 2=bright pass, 3=scene

// Tonemapping cvars
export const cg_hq_tonemapping = new cvar_t( 'cg_hq_tonemapping', '1', true ); // HDR Tonemapping
export const cg_hq_tonemapping_operator = new cvar_t( 'cg_hq_tonemapping_operator', '0', true ); // 0=ACES, 1=Reinhard, 2=Uncharted2
export const cg_hq_tonemapping_exposure = new cvar_t( 'cg_hq_tonemapping_exposure', '1.0', true );
export const cg_hq_tonemapping_gamma = new cvar_t( 'cg_hq_tonemapping_gamma', '2.2', true );
export const cg_hq_tonemapping_debug = new cvar_t( 'cg_hq_tonemapping_debug', '0' ); // 0=off, 1=no tonemap, 2=luminance, 3=raw HDR

// Placeholder cvars for future features (documented in visual fidelity guide)
export const cg_hq_ssr = new cvar_t( 'cg_hq_ssr', '0', true ); // Screen Space Reflections
export const cg_hq_gi = new cvar_t( 'cg_hq_gi', '0', true ); // Global Illumination
export const cg_hq_shadows = new cvar_t( 'cg_hq_shadows', '0', true ); // Soft Shadows (PCSS)
export const cg_hq_volumetric = new cvar_t( 'cg_hq_volumetric', '0', true ); // Volumetric Lighting

//============================================================================
// v_blend -- screen blend color for damage/powerups
//============================================================================

export const v_blend = new Float32Array( 4 ); // r, g, b, a

export const chase_active = new cvar_t( 'chase_active', '0' );

//============================================================================
// R_CullBox
//
// Returns true if the box is completely outside the frustum
//============================================================================

export function R_CullBox( mins, maxs ) {

	for ( let i = 0; i < 4; i ++ ) {

		if ( BoxOnPlaneSide( mins, maxs, frustum[ i ] ) === 2 )
			return true;

	}

	return false;

}

//============================================================================
// SignbitsForPlane
//============================================================================

function SignbitsForPlane( out ) {

	// for fast box on planeside test
	let bits = 0;
	for ( let j = 0; j < 3; j ++ ) {

		if ( out.normal[ j ] < 0 )
			bits |= 1 << j;

	}

	return bits;

}

//============================================================================
// R_SetFrustum
//============================================================================

export function R_SetFrustum() {

	if ( r_refdef.fov_x === 90 ) {

		// front side is visible
		VectorAdd( vpn, vright, frustum[ 0 ].normal );
		VectorSubtract( vpn, vright, frustum[ 1 ].normal );

		VectorAdd( vpn, vup, frustum[ 2 ].normal );
		VectorSubtract( vpn, vup, frustum[ 3 ].normal );

	} else {

		// rotate VPN right by FOV_X/2 degrees
		RotatePointAroundVector( frustum[ 0 ].normal, vup, vpn, - ( 90 - r_refdef.fov_x / 2 ) );
		// rotate VPN left by FOV_X/2 degrees
		RotatePointAroundVector( frustum[ 1 ].normal, vup, vpn, 90 - r_refdef.fov_x / 2 );
		// rotate VPN up by FOV_Y/2 degrees
		RotatePointAroundVector( frustum[ 2 ].normal, vright, vpn, 90 - r_refdef.fov_y / 2 );
		// rotate VPN down by FOV_Y/2 degrees
		RotatePointAroundVector( frustum[ 3 ].normal, vright, vpn, - ( 90 - r_refdef.fov_y / 2 ) );

	}

	for ( let i = 0; i < 4; i ++ ) {

		frustum[ i ].type = PLANE_ANYZ;
		frustum[ i ].dist = DotProduct( r_origin, frustum[ i ].normal );
		frustum[ i ].signbits = SignbitsForPlane( frustum[ i ] );

	}

}

//============================================================================
// R_SetupFrame
//============================================================================

export function R_SetupFrame() {

	// don't allow cheats in multiplayer
	if ( cl && cl.maxclients > 1 ) {

		r_fullbright.value = 0;
		r_fullbright.string = '0';

	}

	R_AnimateLight();

	r_framecount ++;

	// build the transformation matrix for the given view angles
	VectorCopy( r_refdef.vieworg, r_origin );

	AngleVectors( r_refdef.viewangles, vpn, vright, vup );

	// current viewleaf
	r_oldviewleaf = r_viewleaf;
	if ( cl && cl.worldmodel ) {

		r_viewleaf = Mod_PointInLeaf( r_origin, cl.worldmodel );

	}

	V_SetContentsColor( r_viewleaf ? r_viewleaf.contents : 0 );
	V_CalcBlend();

	r_cache_thrash = false;

	c_brush_polys = 0;
	c_alias_polys = 0;

}

//============================================================================
// R_SetupGL
//
// Instead of raw GL matrix setup, we configure the Three.js camera
// to match Quake's projection and modelview matrices.
//============================================================================

export function R_SetupGL() {

	const screenaspect = r_refdef.vrect.width / r_refdef.vrect.height;

	// set up Three.js camera to match Quake's perspective
	if ( ! camera ) {

		camera = new THREE.PerspectiveCamera(
			r_refdef.fov_y,
			screenaspect,
			4, // zNear
			4096 // zFar
		);

	} else {

		camera.fov = r_refdef.fov_y;
		camera.aspect = screenaspect;
		camera.near = 4;
		camera.far = 4096;
		camera.updateProjectionMatrix();

	}

	//
	// Quake's coordinate system:
	//   X = forward, Y = left, Z = up
	//
	// Three.js coordinate system:
	//   X = right, Y = up, Z = backward (out of screen)
	//
	// The original GL code does:
	//   glRotatef(-90, 1, 0, 0) -- put Z going up
	//   glRotatef(90, 0, 0, 1)  -- put Z going up
	//   glRotatef(-viewangles[ROLL], 1, 0, 0)
	//   glRotatef(-viewangles[PITCH], 0, 1, 0)
	//   glRotatef(-viewangles[YAW], 0, 0, 1)
	//   glTranslatef(-vieworg[0], -vieworg[1], -vieworg[2])
	//
	// We replicate this with Three.js by setting camera position and rotation.

	//
	// Position the camera in Quake world coordinates.
	// Geometry vertices are in Quake coords (X=forward, Y=left, Z=up).
	// Three.js camera looks down -Z with Y=up.
	//
	// We keep all geometry in Quake coordinate space and set up the camera
	// to match, using the same modelview matrix as the original GL code:
	//
	//   glRotatef(-90, 1, 0, 0)   -- maps Quake Z-up to GL Y-up
	//   glRotatef(90, 0, 0, 1)    -- maps Quake X-forward to GL -Z-forward
	//   glRotatef(-roll, 1, 0, 0)
	//   glRotatef(-pitch, 0, 1, 0)
	//   glRotatef(-yaw, 0, 0, 1)
	//   glTranslatef(-vieworg)
	//

	// Set camera position directly in Quake coordinates
	camera.position.set(
		r_refdef.vieworg[ 0 ],
		r_refdef.vieworg[ 1 ],
		r_refdef.vieworg[ 2 ]
	);

	// Build orientation using AngleVectors to get forward/right/up
	const forward = new Float32Array( 3 );
	const right = new Float32Array( 3 );
	const up = new Float32Array( 3 );
	AngleVectors( r_refdef.viewangles, forward, right, up );

	// Build a rotation matrix from the Quake basis vectors.
	// In Quake: forward = where camera looks, right = camera right, up = camera up.
	// Three.js camera looks down -Z, X=right, Y=up.
	// GLQuake uses glCullFace(GL_FRONT) to cull front faces (keeping back faces).
	// We match this with THREE.BackSide on materials.
	const m = new THREE.Matrix4();
	m.set(
		right[ 0 ], up[ 0 ], - forward[ 0 ], r_refdef.vieworg[ 0 ],
		right[ 1 ], up[ 1 ], - forward[ 1 ], r_refdef.vieworg[ 1 ],
		right[ 2 ], up[ 2 ], - forward[ 2 ], r_refdef.vieworg[ 2 ],
		0, 0, 0, 1
	);

	camera.matrixAutoUpdate = false;
	camera.matrixWorld.copy( m );
	camera.matrixWorldInverse.copy( m ).invert();
	camera.matrixWorld.decompose( camera.position, camera.quaternion, camera.scale );

	// Store world matrix for later use (mirror rendering, etc.)
	const elements = camera.matrixWorldInverse.elements;
	for ( let i = 0; i < 16; i ++ ) {

		r_world_matrix[ i ] = elements[ i ];

	}

	// Update viewport dimensions
	glx = 0;
	gly = 0;
	glwidth = vid.width;
	glheight = vid.height;

}

//============================================================================
// R_Clear
//============================================================================

export function R_Clear() {

	if ( ! renderer ) return;

	// In Three.js, clearing is handled by renderer.clear()
	// We configure the clear behavior based on cvars

	if ( gl_clear.value ) {

		renderer.setClearColor( 0x000000, 1 );
		renderer.clear( true, true, false );

	} else {

		renderer.clear( false, true, false ); // depth only

	}

	gldepthmin = 0;
	gldepthmax = 1;

}

//============================================================================
// R_DrawEntitiesOnList
//============================================================================

export function R_DrawEntitiesOnList() {

	if ( ! r_drawentities.value )
		return;

	// first pass: draw alias and brush models
	for ( let i = 0; i < cl_numvisedicts; i ++ ) {

		currententity = cl_visedicts[ i ];

		if ( ! currententity || ! currententity.model )
			continue;

		switch ( currententity.model.type ) {

			case mod_alias:
				R_DrawAliasModel( currententity );
				break;

			case mod_brush:
				R_DrawBrushModel( currententity );
				break;

			default:
				break;

		}

	}

	// second pass: draw sprites separately because of alpha blending
	for ( let i = 0; i < cl_numvisedicts; i ++ ) {

		currententity = cl_visedicts[ i ];

		if ( ! currententity || ! currententity.model )
			continue;

		switch ( currententity.model.type ) {

			case mod_sprite:
				R_DrawSpriteModel( currententity );
				break;

		}

	}

}

//============================================================================
// R_DrawViewModel
//============================================================================

const SHADEDOT_QUANT = 16;

// Cached callbacks for viewmodel depthRange hack (no closures in render loop)
function _viewmodelBeforeRender( r ) {

	r.getContext().depthRange( 0, 0.3 );

}

function _viewmodelAfterRender( r ) {

	r.getContext().depthRange( 0, 1 );

}

export function R_DrawViewModel() {

	if ( ! r_drawviewmodel.value )
		return;

	if ( chase_active.value )
		return;

	if ( envmap )
		return;

	if ( ! r_drawentities.value )
		return;

	if ( ! cl )
		return;

	if ( cl.items & 524288 ) // IT_INVISIBILITY
		return;

	if ( cl.stats && cl.stats[ 0 ] <= 0 ) // STAT_HEALTH
		return;

	currententity = cl.viewent;
	if ( ! currententity || ! currententity.model )
		return;

	// Draw normally — stays in main scene with all lights
	R_DrawAliasModel( currententity );

	// Set up onBeforeRender/onAfterRender to apply depthRange hack
	// This runs right when Three.js draws this mesh, so the GL state sticks
	const mesh = currententity._aliasMesh;
	if ( mesh ) {

		// Clone material once and cache on entity — re-clone only if base material changes
		const baseMaterial = mesh.material;
		if ( ! currententity._viewmodelMaterial || currententity._viewmodelMaterialBase !== baseMaterial ) {

			currententity._viewmodelMaterial = baseMaterial.clone();
			currententity._viewmodelMaterial.transparent = true;
			currententity._viewmodelMaterialBase = baseMaterial;

		}

		mesh.material = currententity._viewmodelMaterial;
		mesh.renderOrder = 999;

		mesh.onBeforeRender = _viewmodelBeforeRender;
		mesh.onAfterRender = _viewmodelAfterRender;

	}

}

//============================================================================
// R_DrawAliasModel (stub -- full implementation requires gl_mesh.js)
//============================================================================

// Track entity meshes currently in the scene for efficient add/remove
let _entityMeshesInScene = new Set();
let _entityMeshesThisFrame = new Set();

// Pre-allocated vector for dynamic light distance calculation (avoid per-frame allocation)
const _dlightDist = [ 0, 0, 0 ];

function R_DrawAliasModel( e ) {

	if ( ! e || ! e.model ) return;
	const paliashdr = e.model.cache ? e.model.cache.data : null;
	if ( ! paliashdr || ! paliashdr.posedata ) return;

	//
	// get lighting information
	//
	let ambientlight = 0;
	let shadelight = 0;
	let shadedots = null;

	if ( cl && e.origin ) {

		ambientlight = shadelight = R_LightPoint( e.origin, cl );

		// always give the gun some light
		if ( e === cl.viewent && ambientlight < 24 )
			ambientlight = shadelight = 24;

		// add dynamic lights to ambient/shade (gl_rmain.c:482-497)
		for ( let lnum = 0; lnum < MAX_DLIGHTS; lnum ++ ) {

			if ( cl_dlights[ lnum ].die >= cl.time ) {

				VectorSubtract( e.origin, cl_dlights[ lnum ].origin, _dlightDist );
				const add = cl_dlights[ lnum ].radius - Length( _dlightDist );

				if ( add > 0 ) {

					ambientlight += add;
					shadelight += add;

				}

			}

		}

		// clamp lighting so it doesn't overbright as much
		if ( ambientlight > 128 )
			ambientlight = 128;
		if ( ambientlight + shadelight > 192 )
			shadelight = 192 - ambientlight;

		// ZOID: never allow players to go totally black
		if ( cl_entities != null && cl.maxclients > 0 ) {

			const idx = e._entityIndex;
			if ( idx !== undefined && idx >= 1 && idx <= cl.maxclients ) {

				if ( ambientlight < 8 )
					ambientlight = shadelight = 8;

			}

		}

		// HACK HACK HACK -- no fullbright colors, so make torches full light
		const clmodel = e.model;
		if ( clmodel.name === 'progs/flame2.mdl' || clmodel.name === 'progs/flame.mdl' )
			ambientlight = shadelight = 256;

		// select shadedots row based on yaw angle
		const yaw = e.angles ? e.angles[ 1 ] : 0;
		shadedots = r_avertexnormal_dots[ ( ( yaw * ( SHADEDOT_QUANT / 360.0 ) ) | 0 ) & ( SHADEDOT_QUANT - 1 ) ];
		shadelight = shadelight / 200.0;

	}

	const mesh = R_DrawAliasModel_mesh( e, paliashdr, shadedots, shadelight );
	if ( mesh && scene ) {

		if ( ! _entityMeshesInScene.has( mesh ) ) {

			scene.add( mesh );
			_entityMeshesInScene.add( mesh );

		}

		_entityMeshesThisFrame.add( mesh );

	}

	c_alias_polys ++;

}

//============================================================================
// R_DrawBrushModel (stub -- full implementation in gl_rsurf.js)
//============================================================================

function R_DrawBrushModel( e ) {

	R_DrawBrushModel_rsurf( e );

}

//============================================================================
// R_DrawSpriteModel (stub)
//============================================================================

// Sprite material cache: texture -> material
const _spriteMaterialCache = new Map();

function R_DrawSpriteModel( e ) {

	if ( ! e || ! e.model ) return;
	const psprite = e.model.cache ? e.model.cache.data : null;
	if ( ! psprite || ! psprite.frames || ! psprite.frames.length ) return;

	const frameIdx = Math.max( 0, Math.min( e.frame || 0, psprite.numframes - 1 ) );
	const fdesc = psprite.frames[ frameIdx ];
	if ( ! fdesc || ! fdesc.frameptr ) return;

	const frame = fdesc.frameptr;
	const texture = frame.gl_texturenum;
	if ( ! texture ) return;

	// Get or create cached geometry and material for this entity
	let mesh = e._spriteMesh;
	let positions, posAttr;

	if ( ! mesh ) {

		// First time: create geometry with pre-allocated buffers
		positions = new Float32Array( 12 ); // 4 vertices * 3
		const uvs = new Float32Array( [ 0, 1, 1, 1, 1, 0, 0, 0 ] );

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.setAttribute( 'uv', new THREE.BufferAttribute( uvs, 2 ) );
		geometry.setIndex( [ 0, 1, 2, 0, 2, 3 ] );

		// Get cached material
		let material = _spriteMaterialCache.get( texture );
		if ( ! material ) {

			material = new THREE.MeshBasicMaterial( {
				map: texture,
				transparent: true,
				alphaTest: 0.5,
				depthWrite: false,
				side: THREE.DoubleSide
			} );
			_spriteMaterialCache.set( texture, material );

		}

		mesh = new THREE.Mesh( geometry, material );
		e._spriteMesh = mesh;

	} else {

		// Update material if texture changed
		let material = _spriteMaterialCache.get( texture );
		if ( ! material ) {

			material = new THREE.MeshBasicMaterial( {
				map: texture,
				transparent: true,
				alphaTest: 0.5,
				depthWrite: false,
				side: THREE.DoubleSide
			} );
			_spriteMaterialCache.set( texture, material );

		}

		if ( mesh.material !== material ) mesh.material = material;

	}

	// Update billboard vertex positions every frame (camera-facing)
	posAttr = mesh.geometry.attributes.position;
	positions = posAttr.array;

	const ox = e.origin[ 0 ];
	const oy = e.origin[ 1 ];
	const oz = e.origin[ 2 ];

	const ux = vup[ 0 ], uy = vup[ 1 ], uz = vup[ 2 ];
	const rx = vright[ 0 ], ry = vright[ 1 ], rz = vright[ 2 ];
	const l = frame.left, r = frame.right, u = frame.up, d = frame.down;

	positions[ 0 ] = ox + ux * d + rx * l;
	positions[ 1 ] = oy + uy * d + ry * l;
	positions[ 2 ] = oz + uz * d + rz * l;

	positions[ 3 ] = ox + ux * d + rx * r;
	positions[ 4 ] = oy + uy * d + ry * r;
	positions[ 5 ] = oz + uz * d + rz * r;

	positions[ 6 ] = ox + ux * u + rx * r;
	positions[ 7 ] = oy + uy * u + ry * r;
	positions[ 8 ] = oz + uz * u + rz * r;

	positions[ 9 ] = ox + ux * u + rx * l;
	positions[ 10 ] = oy + uy * u + ry * l;
	positions[ 11 ] = oz + uz * u + rz * l;

	posAttr.needsUpdate = true;

	if ( scene ) {

		if ( ! _entityMeshesInScene.has( mesh ) ) {

			scene.add( mesh );
			_entityMeshesInScene.add( mesh );

		}

		_entityMeshesThisFrame.add( mesh );

	}

}

//============================================================================
// R_PolyBlend
//
// Draws a full-screen color blend for damage flashes, powerups, etc.
// In Three.js, we use a screen-space overlay.
//============================================================================

let polyBlendMesh = null;
let polyBlendScene = null;
let polyBlendCamera = null;

export function R_PolyBlend() {

	if ( gl_polyblend.value === 0 )
		return;

	if ( v_blend[ 3 ] === 0 )
		return;

	if ( renderer == null )
		return;

	// create overlay geometry on first use
	if ( polyBlendScene == null ) {

		polyBlendScene = new THREE.Scene();
		polyBlendCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

		const geometry = new THREE.PlaneGeometry( 2, 2 );
		const material = new THREE.MeshBasicMaterial( {
			transparent: true,
			depthTest: false,
			depthWrite: false
		} );
		polyBlendMesh = new THREE.Mesh( geometry, material );
		polyBlendScene.add( polyBlendMesh );

	}

	// update blend color (values are sRGB from Quake's palette, tell Three.js to convert)
	polyBlendMesh.material.color.setRGB( v_blend[ 0 ], v_blend[ 1 ], v_blend[ 2 ], THREE.SRGBColorSpace );
	polyBlendMesh.material.opacity = v_blend[ 3 ];

	renderer.render( polyBlendScene, polyBlendCamera );

}

//============================================================================
// R_ApplyHQEffects
//
// Applies HQ visual fidelity post-processing effects based on cg_hq cvars.
// Checks both master bitmask (cg_hq) and individual toggles (cg_hq_*).
//============================================================================

// Bitmask constants for cg_hq
const HQ_SSR = 1;        // bit 0
const HQ_AO = 2;         // bit 1
const HQ_GI = 4;         // bit 2
const HQ_BLOOM = 8;      // bit 3
const HQ_SHADOWS = 16;   // bit 4
const HQ_VOLUMETRIC = 32; // bit 5
const HQ_TONEMAPPING = 64; // bit 6

let _lastAOEnabled = false;
let _lastAORadius = - 1;
let _lastAOIntensity = - 1;
let _lastAODebug = - 1;

let _lastBloomEnabled = false;
let _lastBloomThreshold = - 1;
let _lastBloomIntensity = - 1;
let _lastBloomRadius = - 1;
let _lastBloomDebug = - 1;

let _lastTonemappingEnabled = false;
let _lastTonemappingOperator = - 1;
let _lastTonemappingExposure = - 1;
let _lastTonemappingGamma = - 1;
let _lastTonemappingDebug = - 1;

function isHQFeatureEnabled( bitmask, individualCvar ) {

	// Individual cvar > 0 forces the feature ON
	if ( individualCvar.value > 0 ) return true;

	// Individual cvar < 0 forces the feature OFF (overrides master bitmask)
	if ( individualCvar.value < 0 ) return false;

	// Individual cvar == 0: use master bitmask
	return ( cg_hq.value & bitmask ) !== 0;

}

function R_ApplyHQEffects() {

	// Update GTAO settings if changed
	const aoEnabled = isHQFeatureEnabled( HQ_AO, cg_hq_ao );

	if ( aoEnabled !== _lastAOEnabled ) {

		GTAO_SetEnabled( aoEnabled );
		_lastAOEnabled = aoEnabled;

	}

	if ( aoEnabled ) {

		if ( cg_hq_ao_radius.value !== _lastAORadius ) {

			GTAO_SetRadius( cg_hq_ao_radius.value );
			_lastAORadius = cg_hq_ao_radius.value;

		}

		if ( cg_hq_ao_intensity.value !== _lastAOIntensity ) {

			GTAO_SetIntensity( cg_hq_ao_intensity.value );
			_lastAOIntensity = cg_hq_ao_intensity.value;

		}

		if ( cg_hq_ao_debug.value !== _lastAODebug ) {

			GTAO_SetDebugMode( cg_hq_ao_debug.value );
			_lastAODebug = cg_hq_ao_debug.value;

		}

		// Apply GTAO
		GTAO_Apply();

	}

	// Update Bloom settings if changed
	const bloomEnabled = isHQFeatureEnabled( HQ_BLOOM, cg_hq_bloom );

	if ( bloomEnabled !== _lastBloomEnabled ) {

		Bloom_SetEnabled( bloomEnabled );
		_lastBloomEnabled = bloomEnabled;

	}

	if ( bloomEnabled ) {

		if ( cg_hq_bloom_threshold.value !== _lastBloomThreshold ) {

			Bloom_SetThreshold( cg_hq_bloom_threshold.value );
			_lastBloomThreshold = cg_hq_bloom_threshold.value;

		}

		if ( cg_hq_bloom_intensity.value !== _lastBloomIntensity ) {

			Bloom_SetIntensity( cg_hq_bloom_intensity.value );
			_lastBloomIntensity = cg_hq_bloom_intensity.value;

		}

		if ( cg_hq_bloom_radius.value !== _lastBloomRadius ) {

			Bloom_SetRadius( cg_hq_bloom_radius.value );
			_lastBloomRadius = cg_hq_bloom_radius.value;

		}

		if ( cg_hq_bloom_debug.value !== _lastBloomDebug ) {

			Bloom_SetDebugMode( cg_hq_bloom_debug.value );
			_lastBloomDebug = cg_hq_bloom_debug.value;

		}

	}

	// Update Tonemapping settings if changed
	const tonemappingEnabled = isHQFeatureEnabled( HQ_TONEMAPPING, cg_hq_tonemapping );

	if ( tonemappingEnabled !== _lastTonemappingEnabled ) {

		Tonemapping_SetEnabled( tonemappingEnabled );
		_lastTonemappingEnabled = tonemappingEnabled;

	}

	if ( tonemappingEnabled ) {

		if ( cg_hq_tonemapping_operator.value !== _lastTonemappingOperator ) {

			Tonemapping_SetOperator( cg_hq_tonemapping_operator.value );
			_lastTonemappingOperator = cg_hq_tonemapping_operator.value;

		}

		if ( cg_hq_tonemapping_exposure.value !== _lastTonemappingExposure ) {

			Tonemapping_SetExposure( cg_hq_tonemapping_exposure.value );
			_lastTonemappingExposure = cg_hq_tonemapping_exposure.value;

		}

		if ( cg_hq_tonemapping_gamma.value !== _lastTonemappingGamma ) {

			Tonemapping_SetGamma( cg_hq_tonemapping_gamma.value );
			_lastTonemappingGamma = cg_hq_tonemapping_gamma.value;

		}

		if ( cg_hq_tonemapping_debug.value !== _lastTonemappingDebug ) {

			Tonemapping_SetDebugMode( cg_hq_tonemapping_debug.value );
			_lastTonemappingDebug = cg_hq_tonemapping_debug.value;

		}

	}

	// Apply post-processing effects in correct order
	// Order matters: AO (multiply) -> Bloom (additive) -> Tonemapping (HDR->LDR)
	//
	// When both bloom and tonemapping are enabled, we use an HDR pipeline:
	// 1. Bloom renders scene to HDR buffer and outputs scene+bloom to HDR target
	// 2. Tonemapping reads the HDR target and outputs to screen
	//
	// When only bloom is enabled, it additively blends onto the screen as before.
	// When only tonemapping is enabled, it captures the scene and tonemaps to screen.

	if ( bloomEnabled && tonemappingEnabled ) {

		// Combined HDR pipeline: bloom outputs to HDR target, tonemapping reads it
		const hdrTarget = Bloom_ApplyToTarget();
		if ( hdrTarget ) {

			Tonemapping_ApplyToTexture( hdrTarget.texture );

		} else {

			// Fallback: if bloom failed to produce target, just apply tonemapping
			Tonemapping_Apply();

		}

	} else if ( bloomEnabled ) {

		// Bloom only: additive blend to screen
		Bloom_Apply();

	} else if ( tonemappingEnabled ) {

		// Tonemapping only: capture scene and tonemap
		Tonemapping_Apply();

	}

	// Note: When all effects are disabled, the main scene render from
	// renderer.render(scene, camera) above is already on screen

	// Future: add other HQ effects here
	// if (isHQFeatureEnabled(HQ_SSR, cg_hq_ssr)) { SSR_Apply(); }
	// etc.

}

//============================================================================
// R_RenderScene
//
// r_refdef must be set before the first call
//============================================================================

export function R_RenderScene() {

	// Begin new frame: clear the "this frame" set
	_entityMeshesThisFrame = new Set();

	// Dynamic lights are managed by R_RenderDlights - it updates intensity
	// each frame and removes expired lights from scene

	R_SetupFrame();

	R_SetFrustum();

	R_SetupGL();

	R_MarkLeaves(); // done here so we know if we're in water

	R_DrawWorld(); // adds static entities to the list

	S_ExtraUpdate(); // don't let sound get messed up if going slow

	R_DrawEntitiesOnList();

	// Remove entity meshes that were in the scene last frame but not this frame
	for ( const mesh of _entityMeshesInScene ) {

		if ( ! _entityMeshesThisFrame.has( mesh ) ) {

			if ( scene ) scene.remove( mesh );
			_entityMeshesInScene.delete( mesh );

		}

	}

	R_RenderDlights();

	R_DrawParticles();

	Debug_UpdateOverlay();

}

//============================================================================
// R_RenderView
//
// r_refdef must be set before the first call
//============================================================================

export function R_RenderView() {

	let time1, time2;

	if ( r_norefresh.value )
		return;

	if ( ! r_worldentity.model || ( cl && ! cl.worldmodel ) )
		return; // worldmodel not loaded yet

	if ( r_speeds.value ) {

		time1 = Sys_FloatTime();
		c_brush_polys = 0;
		c_alias_polys = 0;

	}

	mirror = false;

	R_Clear();

	// render normal view
	R_RenderScene();
	R_DrawViewModel();
	R_DrawWaterSurfaces();

	// render mirror view
	R_Mirror();

	// Present the frame via Three.js
	if ( renderer && scene && camera ) {

		renderer.render( scene, camera );

	}

	// Apply HQ post-processing effects
	R_ApplyHQEffects();

	// Draw screen blend overlay AFTER main scene (damage flash, powerups, underwater tint)
	R_PolyBlend();

	// Clean up water meshes AFTER rendering (they need to exist during render)
	R_CleanupWaterMeshes_rsurf();

	if ( r_speeds.value ) {

		time2 = Sys_FloatTime();
		Con_Printf( ( ( ( time2 - time1 ) * 1000 ) | 0 ) + ' ms  ' + c_brush_polys + ' wpoly ' + c_alias_polys + ' epoly' );

	}

}

//============================================================================
// R_Mirror
//
// Only one mirror exists in the entire game (e2m3).
// Requires render-to-texture with flipped camera — not yet implemented.
//============================================================================

let _mirrorWarned = false;

function R_Mirror() {

	if ( mirror === false )
		return;

	if ( _mirrorWarned === false ) {

		Con_Printf( 'R_Mirror: mirror rendering not yet implemented\n' );
		_mirrorWarned = true;

	}

}

//============================================================================
// R_Init
//
// Called at startup to initialize the renderer
//============================================================================

export function R_Init() {

	Con_Printf( 'R_Init' );

	// create the Three.js scene
	scene = new THREE.Scene();
	scene.background = new THREE.Color( 0x000000 );

	// initialize light style values to default
	for ( let i = 0; i < 256; i ++ ) {

		d_lightstylevalue[ i ] = 264; // 'm' is normal light (char 109, 109-'a' = 12, 12*22 = 264)

	}

	R_InitParticles();
	R_SetParticleExternals( { scene: scene } );

	Con_Printf( 'R_Init: Three.js renderer ready' );

}

//============================================================================
// R_NewMap
//
// Called when a new map is loaded
//============================================================================

export function R_NewMap() {

	// clear old data
	r_viewleaf = null;
	r_oldviewleaf = null;

	// reset framecount
	r_framecount = 1;
	r_visframecount = 0;

	// initialize light style values
	for ( let i = 0; i < 256; i ++ ) {

		d_lightstylevalue[ i ] = 264;

	}

	// Clean up all cached entity meshes from the previous map
	for ( const mesh of _entityMeshesInScene ) {

		if ( scene ) scene.remove( mesh );

	}

	_entityMeshesInScene = new Set();
	_entityMeshesThisFrame = new Set();
	_spriteMaterialCache.clear();

	Debug_ClearLabels();

	// rebuild lightmaps
	GL_BuildLightmaps_rsurf();

}

//============================================================================
// Stub functions for external dependencies
// These will be connected to real implementations later
//============================================================================

function R_AnimateLight() {

	if ( cl ) R_AnimateLight_impl( cl, cl_lightstyle );

}

// Mod_PointInLeaf: imported from gl_model.js

function V_SetContentsColor( contents ) {

	V_SetContentsColor_view( contents );

}

function V_CalcBlend() {

	V_CalcBlend_view();
	// Copy view.js's v_blend into gl_rmain.js's v_blend so R_PolyBlend can read it
	v_blend[ 0 ] = v_blend_view[ 0 ];
	v_blend[ 1 ] = v_blend_view[ 1 ];
	v_blend[ 2 ] = v_blend_view[ 2 ];
	v_blend[ 3 ] = v_blend_view[ 3 ];

}

function R_MarkLeaves() {

	R_MarkLeaves_impl();

}

function R_DrawWorld() {

	R_DrawWorld_impl();

}

function R_DrawWaterSurfaces() {

	R_DrawWaterSurfaces_rsurf();

}

function S_ExtraUpdate() {

	// Sound system updates independently via S_Update() in the frame loop

}

function R_RenderDlights() {

	if ( cl != null ) {

		R_RenderDlights_impl( cl, scene );

	}

}

function R_DrawParticles() {

	R_DrawParticles_impl();

}
