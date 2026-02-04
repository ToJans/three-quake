// Light Probe System for BSP-Based Relighting
//
// Uses Spherical Harmonics (L1 SH) for colored directional lighting.
// One probe per BSP leaf for O(1) lookup.
// Supports animated lightstyles.

import { CONTENTS_EMPTY, CONTENTS_WATER, CONTENTS_SLIME, CONTENTS_LAVA } from './bspfile.js';
import { Mod_PointInLeaf } from './gl_model.js';
import { d_lightstylevalue, MAXLIGHTMAPS } from './glquake.js';
import { DotProduct } from './mathlib.js';
import { Con_Printf, Con_DPrintf } from './common.js';
import { cvar_t } from './cvar.js';

// Surface flags (from gl_model.js)
const SURF_DRAWTURB = 0x10;

// ============================================================================
// Constants
// ============================================================================

// SH basis function constants for L1 (order 1) spherical harmonics
// L0: Y_00 = 1 / (2 * sqrt(PI)) = 0.282095
// L1: Y_1x = sqrt(3) / (2 * sqrt(PI)) = 0.488603
const SH_C0 = 0.282095; // Y_00 constant (ambient)
const SH_C1 = 0.488603; // Y_1x constants (directional)

// Emissive colors for liquid surfaces (normalized RGB, intensity handled separately)
// These surfaces glow and contribute colored light to nearby entities
const LIQUID_COLORS = {
	lava: [ 1.0, 0.4, 0.1 ],    // Orange-red glow
	slime: [ 0.2, 0.9, 0.3 ],   // Bright green glow
	water: [ 0.3, 0.5, 0.8 ],   // Blue tint
	teleport: [ 0.8, 0.4, 1.0 ] // Purple glow
};

// Emission intensity for liquid surfaces (how much light they contribute)
const LIQUID_EMISSION_INTENSITY = 0.6;

// Ray sampling directions for SH baking at different quality levels

// Low quality: 6 axis-aligned directions (fast)
const RAY_DIRECTIONS_LOW = [
	[ 1, 0, 0 ], [ -1, 0, 0 ],
	[ 0, 1, 0 ], [ 0, -1, 0 ],
	[ 0, 0, 1 ], [ 0, 0, -1 ]
];

// Medium quality: 26 directions (6 axes + 8 corners + 12 edge midpoints)
const RAY_DIRECTIONS_MEDIUM = [
	// 6 axis directions
	[ 1, 0, 0 ], [ -1, 0, 0 ],
	[ 0, 1, 0 ], [ 0, -1, 0 ],
	[ 0, 0, 1 ], [ 0, 0, -1 ],
	// 8 corner directions (normalized)
	[ 0.577350, 0.577350, 0.577350 ], [ 0.577350, 0.577350, -0.577350 ],
	[ 0.577350, -0.577350, 0.577350 ], [ 0.577350, -0.577350, -0.577350 ],
	[ -0.577350, 0.577350, 0.577350 ], [ -0.577350, 0.577350, -0.577350 ],
	[ -0.577350, -0.577350, 0.577350 ], [ -0.577350, -0.577350, -0.577350 ],
	// 12 edge midpoints (normalized)
	[ 0.707107, 0.707107, 0 ], [ 0.707107, -0.707107, 0 ],
	[ -0.707107, 0.707107, 0 ], [ -0.707107, -0.707107, 0 ],
	[ 0.707107, 0, 0.707107 ], [ 0.707107, 0, -0.707107 ],
	[ -0.707107, 0, 0.707107 ], [ -0.707107, 0, -0.707107 ],
	[ 0, 0.707107, 0.707107 ], [ 0, 0.707107, -0.707107 ],
	[ 0, -0.707107, 0.707107 ], [ 0, -0.707107, -0.707107 ]
];

// High quality: 66 directions (uniform sphere sampling via icosphere subdivision)
// Generated from icosahedron vertices + edge midpoints + face centers
const RAY_DIRECTIONS_HIGH = ( function () {

	const dirs = [];

	// Golden ratio for icosahedron
	const phi = ( 1 + Math.sqrt( 5 ) ) / 2;
	const invLen = 1 / Math.sqrt( 1 + phi * phi );

	// 12 icosahedron vertices
	const icoVerts = [
		[ 0, 1, phi ], [ 0, -1, phi ], [ 0, 1, -phi ], [ 0, -1, -phi ],
		[ 1, phi, 0 ], [ -1, phi, 0 ], [ 1, -phi, 0 ], [ -1, -phi, 0 ],
		[ phi, 0, 1 ], [ -phi, 0, 1 ], [ phi, 0, -1 ], [ -phi, 0, -1 ]
	];

	for ( const v of icoVerts ) {

		const len = Math.sqrt( v[ 0 ] * v[ 0 ] + v[ 1 ] * v[ 1 ] + v[ 2 ] * v[ 2 ] );
		dirs.push( [ v[ 0 ] / len, v[ 1 ] / len, v[ 2 ] / len ] );

	}

	// 6 axis directions
	dirs.push( [ 1, 0, 0 ], [ -1, 0, 0 ], [ 0, 1, 0 ], [ 0, -1, 0 ], [ 0, 0, 1 ], [ 0, 0, -1 ] );

	// 8 cube corners
	const s = 0.577350;
	dirs.push(
		[ s, s, s ], [ s, s, -s ], [ s, -s, s ], [ s, -s, -s ],
		[ -s, s, s ], [ -s, s, -s ], [ -s, -s, s ], [ -s, -s, -s ]
	);

	// 12 edge midpoints
	const e = 0.707107;
	dirs.push(
		[ e, e, 0 ], [ e, -e, 0 ], [ -e, e, 0 ], [ -e, -e, 0 ],
		[ e, 0, e ], [ e, 0, -e ], [ -e, 0, e ], [ -e, 0, -e ],
		[ 0, e, e ], [ 0, e, -e ], [ 0, -e, e ], [ 0, -e, -e ]
	);

	// Additional directions between major axes (24 more)
	const a = 0.8506508;
	const b = 0.5257311;
	dirs.push(
		[ a, b, 0 ], [ a, -b, 0 ], [ -a, b, 0 ], [ -a, -b, 0 ],
		[ b, a, 0 ], [ b, -a, 0 ], [ -b, a, 0 ], [ -b, -a, 0 ],
		[ a, 0, b ], [ a, 0, -b ], [ -a, 0, b ], [ -a, 0, -b ],
		[ b, 0, a ], [ b, 0, -a ], [ -b, 0, a ], [ -b, 0, -a ],
		[ 0, a, b ], [ 0, a, -b ], [ 0, -a, b ], [ 0, -a, -b ],
		[ 0, b, a ], [ 0, b, -a ], [ 0, -b, a ], [ 0, -b, -a ]
	);

	return dirs;

} )();

// Default to medium quality
let currentRayDirections = RAY_DIRECTIONS_MEDIUM;

// ============================================================================
// Cvars
// ============================================================================

export const r_lightprobes = new cvar_t( 'r_hq_lightprobes', '1', true );

// Quality level: 0=low (6 rays), 1=medium (26 rays), 2=high (66 rays)
export const r_lightprobes_quality = new cvar_t( 'r_hq_lightprobes_quality', '2', true );

// Number of sample positions per probe (1=centroid only, higher=multi-sample)
export const r_lightprobes_samples = new cvar_t( 'r_hq_lightprobes_samples', '4', true );

/**
 * Get ray directions array based on current quality setting.
 */
function GetRayDirections() {

	const quality = r_lightprobes_quality.value | 0;

	if ( quality <= 0 ) return RAY_DIRECTIONS_LOW;
	if ( quality === 1 ) return RAY_DIRECTIONS_MEDIUM;
	return RAY_DIRECTIONS_HIGH;

}

// ============================================================================
// Probe Data Structure
// ============================================================================

/**
 * Light probe containing L1 spherical harmonics coefficients.
 *
 * L1 SH uses 4 coefficients per color channel:
 *   [0] = L00 (ambient/DC)
 *   [1] = L1-1 (Y direction)
 *   [2] = L10 (Z direction)
 *   [3] = L11 (X direction)
 *
 * Total: 4 coefficients × 3 channels (RGB) = 12 floats
 */
class LightProbe {

	constructor( leafIndex, position ) {

		this.leafIndex = leafIndex;
		this.position = new Float32Array( position );

		// L1 SH coefficients: 4 per channel × RGB = 12 floats
		// Stored as [R0,R1,R2,R3, G0,G1,G2,G3, B0,B1,B2,B3]
		this.sh = new Float32Array( 12 );

		// Base lighting (style 0, always-on lights)
		this.shBase = new Float32Array( 12 );

		// Per-style contributions for animated lights
		// Array of { style: number, sh: Float32Array[12] }
		this.styleContribs = [];

		// Cache for change detection
		this.cachedStyleValues = null;

	}

}

// ============================================================================
// Module State
// ============================================================================

// Array of probes indexed by leaf index
let probes = null;

// Lookup array: leafIndex -> probe (for leaves without probes, null)
let leafToProbe = null;

// Reference to the current worldmodel
let currentWorldmodel = null;

// Surface cache for lightmap sampling
let surfaceCache = null;

// ============================================================================
// SH Math Functions
// ============================================================================

/**
 * Encode a directional light contribution into L1 SH coefficients.
 *
 * @param {Float32Array} sh - Output SH coefficients (12 floats)
 * @param {number[]} direction - Normalized direction vector [x, y, z]
 * @param {number} r - Red intensity
 * @param {number} g - Green intensity
 * @param {number} b - Blue intensity
 */
function SH_AddDirectionalLight( sh, direction, r, g, b ) {

	const dx = direction[ 0 ];
	const dy = direction[ 1 ];
	const dz = direction[ 2 ];

	// L0 (ambient) contribution
	sh[ 0 ] += r * SH_C0;
	sh[ 4 ] += g * SH_C0;
	sh[ 8 ] += b * SH_C0;

	// L1 (directional) contributions
	// Note: Quake coordinate system is X=forward, Y=left, Z=up
	// SH L1 basis: Y_1-1 ~ y, Y_10 ~ z, Y_11 ~ x

	// L1-1 (Y direction)
	sh[ 1 ] += r * SH_C1 * dy;
	sh[ 5 ] += g * SH_C1 * dy;
	sh[ 9 ] += b * SH_C1 * dy;

	// L10 (Z direction)
	sh[ 2 ] += r * SH_C1 * dz;
	sh[ 6 ] += g * SH_C1 * dz;
	sh[ 10 ] += b * SH_C1 * dz;

	// L11 (X direction)
	sh[ 3 ] += r * SH_C1 * dx;
	sh[ 7 ] += g * SH_C1 * dx;
	sh[ 11 ] += b * SH_C1 * dx;

}

/**
 * Evaluate L1 SH at a given normal direction.
 *
 * @param {Float32Array} sh - Input SH coefficients (12 floats)
 * @param {number[]} normal - Surface normal [x, y, z]
 * @returns {number[]} RGB color [r, g, b]
 */
export function SH_Evaluate( sh, normal ) {

	const nx = normal[ 0 ];
	const ny = normal[ 1 ];
	const nz = normal[ 2 ];

	// Evaluate SH: color = L0 * c0 + L1y * c1 * ny + L1z * c1 * nz + L1x * c1 * nx
	const r = Math.max( 0, sh[ 0 ] * SH_C0 + sh[ 1 ] * SH_C1 * ny + sh[ 2 ] * SH_C1 * nz + sh[ 3 ] * SH_C1 * nx );
	const g = Math.max( 0, sh[ 4 ] * SH_C0 + sh[ 5 ] * SH_C1 * ny + sh[ 6 ] * SH_C1 * nz + sh[ 7 ] * SH_C1 * nx );
	const b = Math.max( 0, sh[ 8 ] * SH_C0 + sh[ 9 ] * SH_C1 * ny + sh[ 10 ] * SH_C1 * nz + sh[ 11 ] * SH_C1 * nx );

	return [ r, g, b ];

}

/**
 * Get the average (ambient) light from SH coefficients.
 * This is just the L0 term.
 *
 * @param {Float32Array} sh - Input SH coefficients (12 floats)
 * @returns {number[]} RGB color [r, g, b]
 */
export function SH_GetAmbient( sh ) {

	// L0 coefficient evaluated at any direction gives the ambient
	return [
		Math.max( 0, sh[ 0 ] * SH_C0 ),
		Math.max( 0, sh[ 4 ] * SH_C0 ),
		Math.max( 0, sh[ 8 ] * SH_C0 )
	];

}

// ============================================================================
// Ray Casting for Lightmap Sampling
// ============================================================================

// Pre-allocated scratch vectors
const _rayEnd = new Float32Array( 3 );
const _rayMid = new Float32Array( 3 );

/**
 * Sample RGB light at a point by tracing down to find a surface and reading its lightmap.
 * Returns color as [r, g, b] normalized to 0-1 range, or null if no surface hit.
 *
 * @param {Float32Array} point - Starting point [x, y, z]
 * @param {Float32Array} direction - Ray direction [x, y, z] (normalized)
 * @param {object} model - The worldmodel
 * @returns {number[]|null} RGB color [r, g, b] or null if no hit
 */
function R_SampleLightmapRGB( point, direction, model ) {

	if ( ! model || ! model.lightdata || ! model.nodes )
		return null;

	// Trace a ray from point in the given direction
	const maxDist = 4096;
	_rayEnd[ 0 ] = point[ 0 ] + direction[ 0 ] * maxDist;
	_rayEnd[ 1 ] = point[ 1 ] + direction[ 1 ] * maxDist;
	_rayEnd[ 2 ] = point[ 2 ] + direction[ 2 ] * maxDist;

	return RecursiveLightPointRGB( model.nodes[ 0 ], point, _rayEnd, model.surfaces, 0 );

}

/**
 * Get liquid type from texture name.
 * Returns 'lava', 'slime', 'water', 'teleport', or null.
 */
function GetLiquidType( textureName ) {

	if ( ! textureName ) return null;

	const name = textureName.toLowerCase();

	// Quake liquid textures start with '*'
	if ( name.charAt( 0 ) !== '*' ) return null;

	if ( name.indexOf( 'lava' ) !== -1 ) return 'lava';
	if ( name.indexOf( 'slime' ) !== -1 ) return 'slime';
	if ( name.indexOf( 'water' ) !== -1 ) return 'water';
	if ( name.indexOf( 'teleport' ) !== -1 ) return 'teleport';

	// Default water for unknown liquid types
	return 'water';

}

/**
 * Recursive BSP traversal to find surface and sample RGB lightmap.
 * Similar to RecursiveLightPoint but returns full RGB.
 * Also detects liquid surfaces (lava, slime, water) and returns colored emission.
 */
function RecursiveLightPointRGB( node, start, end, surfaces, depth ) {

	if ( ! node || node.contents < 0 ) {

		// Check if we entered a liquid volume (leaf contents)
		if ( node && node.contents !== undefined ) {

			// Return colored light based on liquid type
			if ( node.contents === CONTENTS_LAVA ) {

				const c = LIQUID_COLORS.lava;
				return [ c[ 0 ] * LIQUID_EMISSION_INTENSITY, c[ 1 ] * LIQUID_EMISSION_INTENSITY, c[ 2 ] * LIQUID_EMISSION_INTENSITY ];

			}

			if ( node.contents === CONTENTS_SLIME ) {

				const c = LIQUID_COLORS.slime;
				return [ c[ 0 ] * LIQUID_EMISSION_INTENSITY, c[ 1 ] * LIQUID_EMISSION_INTENSITY, c[ 2 ] * LIQUID_EMISSION_INTENSITY ];

			}

			if ( node.contents === CONTENTS_WATER ) {

				const c = LIQUID_COLORS.water;
				return [ c[ 0 ] * LIQUID_EMISSION_INTENSITY * 0.3, c[ 1 ] * LIQUID_EMISSION_INTENSITY * 0.3, c[ 2 ] * LIQUID_EMISSION_INTENSITY * 0.3 ];

			}

		}

		return null;

	}

	const plane = node.plane;
	if ( ! plane ) return null;

	const front = DotProduct( start, plane.normal ) - plane.dist;
	const back = DotProduct( end, plane.normal ) - plane.dist;
	const side = front < 0 ? 1 : 0;

	if ( ( back < 0 ) === ( front < 0 ) )
		return RecursiveLightPointRGB( node.children[ side ], start, end, surfaces, depth );

	const frac = front / ( front - back );
	_rayMid[ 0 ] = start[ 0 ] + ( end[ 0 ] - start[ 0 ] ) * frac;
	_rayMid[ 1 ] = start[ 1 ] + ( end[ 1 ] - start[ 1 ] ) * frac;
	_rayMid[ 2 ] = start[ 2 ] + ( end[ 2 ] - start[ 2 ] ) * frac;

	// Check front side first
	const result = RecursiveLightPointRGB( node.children[ side ], start, _rayMid, surfaces, depth + 1 );
	if ( result !== null )
		return result;

	if ( ( back < 0 ) === ( front < 0 ) )
		return null;

	// Check for impact on this node's surfaces
	const surfStart = node.firstsurface;
	for ( let i = 0; i < node.numsurfaces; i ++ ) {

		const surf = surfaces[ surfStart + i ];
		if ( ! surf ) continue;

		const tex = surf.texinfo;
		if ( ! tex ) continue;

		// Check if this is a liquid surface (SURF_DRAWTURB)
		if ( surf.flags & SURF_DRAWTURB ) {

			// Get liquid type from texture name
			const texName = tex.texture ? tex.texture.name : null;
			const liquidType = GetLiquidType( texName );

			if ( liquidType && LIQUID_COLORS[ liquidType ] ) {

				const c = LIQUID_COLORS[ liquidType ];
				const intensity = liquidType === 'water' ? LIQUID_EMISSION_INTENSITY * 0.3 : LIQUID_EMISSION_INTENSITY;
				return [ c[ 0 ] * intensity, c[ 1 ] * intensity, c[ 2 ] * intensity ];

			}

		}

		// Skip surfaces without lightmaps (but we already handled liquids above)
		if ( surf.flags & 0x20 ) // SURF_DRAWTILED
			continue;

		const s = DotProduct( _rayMid, tex.vecs[ 0 ] ) + tex.vecs[ 0 ][ 3 ];
		const t = DotProduct( _rayMid, tex.vecs[ 1 ] ) + tex.vecs[ 1 ][ 3 ];

		if ( s < surf.texturemins[ 0 ] || t < surf.texturemins[ 1 ] )
			continue;

		const ds = s - surf.texturemins[ 0 ];
		const dt = t - surf.texturemins[ 1 ];

		if ( ds > surf.extents[ 0 ] || dt > surf.extents[ 1 ] )
			continue;

		if ( ! surf.samples )
			return [ 0, 0, 0 ];

		const ds4 = ds >> 4;
		const dt4 = dt >> 4;

		const lightmap = surf.samples;
		const smax = ( surf.extents[ 0 ] >> 4 ) + 1;
		const tmax = ( surf.extents[ 1 ] >> 4 ) + 1;
		let lightmapOffset = ( surf.sampleOffset || 0 ) + dt4 * smax + ds4;

		// Sample RGB from lightmap
		// Quake lightmaps are grayscale, but we track per-style contributions
		let r = 0, g = 0, b = 0;

		for ( let maps = 0; maps < MAXLIGHTMAPS && surf.styles[ maps ] !== 255; maps ++ ) {

			const scale = d_lightstylevalue[ surf.styles[ maps ] ];
			const sample = lightmap[ lightmapOffset ];

			// Grayscale lightmap - same value for RGB
			r += sample * scale;
			g += sample * scale;
			b += sample * scale;

			lightmapOffset += smax * tmax;

		}

		// Normalize: Quake uses 0-255 range with scale 0-512 (256 = normal)
		// Result should be roughly 0-255 for full bright
		r = ( r >> 8 ) / 255;
		g = ( g >> 8 ) / 255;
		b = ( b >> 8 ) / 255;

		return [ r, g, b ];

	}

	// Check back side
	return RecursiveLightPointRGB( node.children[ side ? 0 : 1 ], _rayMid, end, surfaces, depth + 1 );

}

/**
 * Sample lightmap at a point for a specific lightstyle only.
 * Used during baking to separate style contributions.
 */
function R_SampleLightmapForStyle( point, direction, model, targetStyle ) {

	if ( ! model || ! model.lightdata || ! model.nodes )
		return null;

	const maxDist = 4096;
	_rayEnd[ 0 ] = point[ 0 ] + direction[ 0 ] * maxDist;
	_rayEnd[ 1 ] = point[ 1 ] + direction[ 1 ] * maxDist;
	_rayEnd[ 2 ] = point[ 2 ] + direction[ 2 ] * maxDist;

	return RecursiveLightPointForStyle( model.nodes[ 0 ], point, _rayEnd, model.surfaces, targetStyle, 0 );

}

function RecursiveLightPointForStyle( node, start, end, surfaces, targetStyle, depth ) {

	if ( ! node || node.contents < 0 ) {

		// For style 0 (base lighting), include liquid emission
		if ( targetStyle === 0 && node && node.contents !== undefined ) {

			if ( node.contents === CONTENTS_LAVA ) {

				const c = LIQUID_COLORS.lava;
				return [ c[ 0 ] * LIQUID_EMISSION_INTENSITY, c[ 1 ] * LIQUID_EMISSION_INTENSITY, c[ 2 ] * LIQUID_EMISSION_INTENSITY ];

			}

			if ( node.contents === CONTENTS_SLIME ) {

				const c = LIQUID_COLORS.slime;
				return [ c[ 0 ] * LIQUID_EMISSION_INTENSITY, c[ 1 ] * LIQUID_EMISSION_INTENSITY, c[ 2 ] * LIQUID_EMISSION_INTENSITY ];

			}

			if ( node.contents === CONTENTS_WATER ) {

				const c = LIQUID_COLORS.water;
				return [ c[ 0 ] * LIQUID_EMISSION_INTENSITY * 0.3, c[ 1 ] * LIQUID_EMISSION_INTENSITY * 0.3, c[ 2 ] * LIQUID_EMISSION_INTENSITY * 0.3 ];

			}

		}

		return null;

	}

	const plane = node.plane;
	if ( ! plane ) return null;

	const front = DotProduct( start, plane.normal ) - plane.dist;
	const back = DotProduct( end, plane.normal ) - plane.dist;
	const side = front < 0 ? 1 : 0;

	if ( ( back < 0 ) === ( front < 0 ) )
		return RecursiveLightPointForStyle( node.children[ side ], start, end, surfaces, targetStyle, depth );

	const frac = front / ( front - back );
	_rayMid[ 0 ] = start[ 0 ] + ( end[ 0 ] - start[ 0 ] ) * frac;
	_rayMid[ 1 ] = start[ 1 ] + ( end[ 1 ] - start[ 1 ] ) * frac;
	_rayMid[ 2 ] = start[ 2 ] + ( end[ 2 ] - start[ 2 ] ) * frac;

	const result = RecursiveLightPointForStyle( node.children[ side ], start, _rayMid, surfaces, targetStyle, depth + 1 );
	if ( result !== null )
		return result;

	if ( ( back < 0 ) === ( front < 0 ) )
		return null;

	const surfStart = node.firstsurface;
	for ( let i = 0; i < node.numsurfaces; i ++ ) {

		const surf = surfaces[ surfStart + i ];
		if ( ! surf ) continue;

		const tex = surf.texinfo;
		if ( ! tex ) continue;

		// For style 0 (base lighting), include liquid surface emission
		if ( targetStyle === 0 && ( surf.flags & SURF_DRAWTURB ) ) {

			const texName = tex.texture ? tex.texture.name : null;
			const liquidType = GetLiquidType( texName );

			if ( liquidType && LIQUID_COLORS[ liquidType ] ) {

				const c = LIQUID_COLORS[ liquidType ];
				const intensity = liquidType === 'water' ? LIQUID_EMISSION_INTENSITY * 0.3 : LIQUID_EMISSION_INTENSITY;
				return [ c[ 0 ] * intensity, c[ 1 ] * intensity, c[ 2 ] * intensity ];

			}

		}

		if ( surf.flags & 0x20 )
			continue;

		const s = DotProduct( _rayMid, tex.vecs[ 0 ] ) + tex.vecs[ 0 ][ 3 ];
		const t = DotProduct( _rayMid, tex.vecs[ 1 ] ) + tex.vecs[ 1 ][ 3 ];

		if ( s < surf.texturemins[ 0 ] || t < surf.texturemins[ 1 ] )
			continue;

		const ds = s - surf.texturemins[ 0 ];
		const dt = t - surf.texturemins[ 1 ];

		if ( ds > surf.extents[ 0 ] || dt > surf.extents[ 1 ] )
			continue;

		if ( ! surf.samples )
			return [ 0, 0, 0 ];

		const ds4 = ds >> 4;
		const dt4 = dt >> 4;

		const lightmap = surf.samples;
		const smax = ( surf.extents[ 0 ] >> 4 ) + 1;
		const tmax = ( surf.extents[ 1 ] >> 4 ) + 1;
		let lightmapOffset = ( surf.sampleOffset || 0 ) + dt4 * smax + ds4;

		let r = 0, g = 0, b = 0;

		for ( let maps = 0; maps < MAXLIGHTMAPS && surf.styles[ maps ] !== 255; maps ++ ) {

			if ( surf.styles[ maps ] !== targetStyle ) {

				lightmapOffset += smax * tmax;
				continue;

			}

			// Found the target style - sample with scale=256 (normalized)
			const sample = lightmap[ lightmapOffset ];
			r = sample / 255;
			g = sample / 255;
			b = sample / 255;
			break;

		}

		return [ r, g, b ];

	}

	return RecursiveLightPointForStyle( node.children[ side ? 0 : 1 ], _rayMid, end, surfaces, targetStyle, depth + 1 );

}

// ============================================================================
// Probe Building
// ============================================================================

/**
 * Build light probes for the world model.
 * Called when a new map is loaded.
 *
 * @param {object} model - The worldmodel (cl.worldmodel)
 */
export function R_BuildLightProbes( model ) {

	if ( ! model || ! model.leafs || ! model.lightdata ) {

		Con_Printf( 'R_BuildLightProbes: no world model\n' );
		probes = null;
		leafToProbe = null;
		currentWorldmodel = null;
		return;

	}

	currentWorldmodel = model;

	const startTime = performance.now();
	const numLeafs = model.numleafs;
	let numProbes = 0;

	// Initialize arrays
	probes = [];
	leafToProbe = new Array( numLeafs + 1 ).fill( null );

	// Collect all unique lightstyles used in the map
	const usedStyles = new Set();
	usedStyles.add( 0 ); // Style 0 is always used (static lights)

	for ( let i = 0; i < model.numsurfaces; i ++ ) {

		const surf = model.surfaces[ i ];
		if ( ! surf || ! surf.samples ) continue;

		for ( let j = 0; j < MAXLIGHTMAPS && surf.styles[ j ] !== 255; j ++ ) {

			usedStyles.add( surf.styles[ j ] );

		}

	}

	const stylesArray = Array.from( usedStyles ).filter( s => s !== 0 );

	// Get ray directions based on quality setting
	const rayDirs = GetRayDirections();
	const numSamples = Math.max( 1, Math.min( 8, r_lightprobes_samples.value | 0 ) );

	Con_DPrintf( `Light probe quality: ${rayDirs.length} rays, ${numSamples} samples per probe\n` );

	// Create probes for each empty leaf
	for ( let i = 1; i <= numLeafs; i ++ ) {

		const leaf = model.leafs[ i ];
		if ( ! leaf ) continue;

		// Only create probes in empty (walkable) leaves
		if ( leaf.contents !== CONTENTS_EMPTY )
			continue;

		// Compute leaf bounds
		const minX = leaf.minmaxs[ 0 ], minY = leaf.minmaxs[ 1 ], minZ = leaf.minmaxs[ 2 ];
		const maxX = leaf.minmaxs[ 3 ], maxY = leaf.minmaxs[ 4 ], maxZ = leaf.minmaxs[ 5 ];

		// Compute leaf centroid
		const centroid = new Float32Array( 3 );
		centroid[ 0 ] = ( minX + maxX ) * 0.5;
		centroid[ 1 ] = ( minY + maxY ) * 0.5;
		centroid[ 2 ] = ( minZ + maxZ ) * 0.5;

		const probe = new LightProbe( i, centroid );

		// Generate sample positions within the leaf
		const samplePositions = [];

		if ( numSamples === 1 ) {

			// Single sample at centroid
			samplePositions.push( centroid );

		} else {

			// Multi-sample: centroid + jittered positions within leaf bounds
			samplePositions.push( centroid );

			// Shrink bounds to avoid sampling too close to walls
			const shrink = 0.2;
			const sizeX = ( maxX - minX ) * ( 1 - shrink * 2 );
			const sizeY = ( maxY - minY ) * ( 1 - shrink * 2 );
			const sizeZ = ( maxZ - minZ ) * ( 1 - shrink * 2 );
			const baseX = minX + ( maxX - minX ) * shrink;
			const baseY = minY + ( maxY - minY ) * shrink;
			const baseZ = minZ + ( maxZ - minZ ) * shrink;

			// Use stratified sampling for better coverage
			for ( let s = 1; s < numSamples; s ++ ) {

				const pos = new Float32Array( 3 );

				// Halton-like sequence for better distribution
				const fx = ( ( s * 0.618034 ) % 1 );
				const fy = ( ( s * 0.773064 ) % 1 );
				const fz = ( ( s * 0.437585 ) % 1 );

				pos[ 0 ] = baseX + fx * sizeX;
				pos[ 1 ] = baseY + fy * sizeY;
				pos[ 2 ] = baseZ + fz * sizeZ;

				samplePositions.push( pos );

			}

		}

		// Bake base lighting (all styles combined at current values)
		BakeProbeMultiSample( probe, model, rayDirs, samplePositions );

		// Bake per-style contributions for animated lights
		for ( const style of stylesArray ) {

			const styleSH = new Float32Array( 12 );
			BakeProbeForStyleMultiSample( samplePositions, styleSH, model, rayDirs, style );

			// Only store if this style contributes to this probe
			let hasContrib = false;
			for ( let j = 0; j < 12; j ++ ) {

				if ( styleSH[ j ] !== 0 ) {

					hasContrib = true;
					break;

				}

			}

			if ( hasContrib ) {

				probe.styleContribs.push( { style, sh: styleSH } );

			}

		}

		// Store base SH (style 0 only) - also use multi-sample
		BakeProbeForStyleMultiSample( samplePositions, probe.shBase, model, rayDirs, 0 );

		probes.push( probe );
		leafToProbe[ i ] = probe;
		numProbes ++;

	}

	const elapsed = ( performance.now() - startTime ).toFixed( 1 );
	Con_Printf( `R_BuildLightProbes: ${numProbes} probes in ${elapsed}ms\n` );

}

/**
 * Bake SH coefficients for a probe by sampling in multiple directions.
 */
function BakeProbe( probe, model, directions ) {

	probe.sh.fill( 0 );

	const numDirs = directions.length;
	let totalWeight = 0;

	for ( let i = 0; i < numDirs; i ++ ) {

		const dir = directions[ i ];
		const color = R_SampleLightmapRGB( probe.position, dir, model );

		if ( color ) {

			// Invert direction for SH encoding (light coming FROM that direction)
			const invDir = [ -dir[ 0 ], -dir[ 1 ], -dir[ 2 ] ];
			SH_AddDirectionalLight( probe.sh, invDir, color[ 0 ], color[ 1 ], color[ 2 ] );
			totalWeight += 1;

		}

	}

	// Normalize by number of samples
	if ( totalWeight > 0 ) {

		const invWeight = 1 / totalWeight;
		for ( let i = 0; i < 12; i ++ ) {

			probe.sh[ i ] *= invWeight;

		}

	}

}

/**
 * Bake SH coefficients for a specific lightstyle only.
 */
function BakeProbeForStyle( position, sh, model, directions, targetStyle ) {

	sh.fill( 0 );

	const numDirs = directions.length;
	let totalWeight = 0;

	for ( let i = 0; i < numDirs; i ++ ) {

		const dir = directions[ i ];
		const color = R_SampleLightmapForStyle( position, dir, model, targetStyle );

		if ( color ) {

			const invDir = [ -dir[ 0 ], -dir[ 1 ], -dir[ 2 ] ];
			SH_AddDirectionalLight( sh, invDir, color[ 0 ], color[ 1 ], color[ 2 ] );
			totalWeight += 1;

		}

	}

	if ( totalWeight > 0 ) {

		const invWeight = 1 / totalWeight;
		for ( let i = 0; i < 12; i ++ ) {

			sh[ i ] *= invWeight;

		}

	}

}

/**
 * Bake SH coefficients for a probe using multiple sample positions.
 * Averages lighting from several positions within the leaf for smoother results.
 */
function BakeProbeMultiSample( probe, model, directions, samplePositions ) {

	probe.sh.fill( 0 );

	const numDirs = directions.length;
	const numPositions = samplePositions.length;
	let totalWeight = 0;

	for ( let p = 0; p < numPositions; p ++ ) {

		const pos = samplePositions[ p ];

		for ( let i = 0; i < numDirs; i ++ ) {

			const dir = directions[ i ];
			const color = R_SampleLightmapRGB( pos, dir, model );

			if ( color ) {

				// Invert direction for SH encoding (light coming FROM that direction)
				const invDir = [ -dir[ 0 ], -dir[ 1 ], -dir[ 2 ] ];
				SH_AddDirectionalLight( probe.sh, invDir, color[ 0 ], color[ 1 ], color[ 2 ] );
				totalWeight += 1;

			}

		}

	}

	// Normalize by total number of samples
	if ( totalWeight > 0 ) {

		const invWeight = 1 / totalWeight;
		for ( let i = 0; i < 12; i ++ ) {

			probe.sh[ i ] *= invWeight;

		}

	}

}

/**
 * Bake SH coefficients for a specific lightstyle using multiple sample positions.
 */
function BakeProbeForStyleMultiSample( samplePositions, sh, model, directions, targetStyle ) {

	sh.fill( 0 );

	const numDirs = directions.length;
	const numPositions = samplePositions.length;
	let totalWeight = 0;

	for ( let p = 0; p < numPositions; p ++ ) {

		const pos = samplePositions[ p ];

		for ( let i = 0; i < numDirs; i ++ ) {

			const dir = directions[ i ];
			const color = R_SampleLightmapForStyle( pos, dir, model, targetStyle );

			if ( color ) {

				const invDir = [ -dir[ 0 ], -dir[ 1 ], -dir[ 2 ] ];
				SH_AddDirectionalLight( sh, invDir, color[ 0 ], color[ 1 ], color[ 2 ] );
				totalWeight += 1;

			}

		}

	}

	if ( totalWeight > 0 ) {

		const invWeight = 1 / totalWeight;
		for ( let i = 0; i < 12; i ++ ) {

			sh[ i ] *= invWeight;

		}

	}

}

// ============================================================================
// Runtime Probe Lookup
// ============================================================================

/**
 * Get the light probe for a given world position.
 *
 * @param {Float32Array} point - World position [x, y, z]
 * @param {object} model - The worldmodel
 * @returns {LightProbe|null} The probe for this position, or null
 */
export function R_GetLightProbe( point, model ) {

	if ( ! r_lightprobes.value || ! leafToProbe || model !== currentWorldmodel )
		return null;

	const leaf = Mod_PointInLeaf( point, model );
	if ( ! leaf )
		return null;

	// Find probe index - leafs array is 1-indexed
	// We need to find which leaf index this is
	for ( let i = 1; i <= model.numleafs; i ++ ) {

		if ( model.leafs[ i ] === leaf ) {

			return leafToProbe[ i ];

		}

	}

	return null;

}

/**
 * Evaluate lighting at a point with a given normal.
 *
 * @param {Float32Array} point - World position [x, y, z]
 * @param {Float32Array} normal - Surface normal [x, y, z]
 * @param {object} model - The worldmodel
 * @returns {number[]|null} RGB color [r, g, b] or null if no probe
 */
export function R_EvaluateLightProbe( point, normal, model ) {

	const probe = R_GetLightProbe( point, model );
	if ( ! probe )
		return null;

	return SH_Evaluate( probe.sh, normal );

}

/**
 * Get ambient light at a point (no directional component).
 *
 * @param {Float32Array} point - World position [x, y, z]
 * @param {object} model - The worldmodel
 * @returns {number[]|null} RGB color [r, g, b] or null if no probe
 */
export function R_GetProbeAmbient( point, model ) {

	const probe = R_GetLightProbe( point, model );
	if ( ! probe )
		return null;

	return SH_GetAmbient( probe.sh );

}

// ============================================================================
// Lightstyle Updates
// ============================================================================

// Cached lightstyle values for change detection
let cachedLightstyleValues = null;

/**
 * Update light probes when lightstyle values change.
 * Should be called after R_AnimateLight.
 */
export function R_UpdateLightProbes() {

	if ( ! r_lightprobes.value || ! probes || probes.length === 0 )
		return;

	// Initialize cache on first call
	if ( ! cachedLightstyleValues ) {

		cachedLightstyleValues = new Int32Array( 256 );
		cachedLightstyleValues.set( d_lightstylevalue );
		return; // First frame, probes already have correct values

	}

	// Check if any style values changed
	let anyChanged = false;
	const changedStyles = new Set();

	for ( let i = 0; i < 256; i ++ ) {

		if ( d_lightstylevalue[ i ] !== cachedLightstyleValues[ i ] ) {

			changedStyles.add( i );
			anyChanged = true;

		}

	}

	if ( ! anyChanged )
		return;

	// Update probes affected by changed styles
	for ( const probe of probes ) {

		// Check if this probe uses any changed styles
		let needsUpdate = false;
		for ( const contrib of probe.styleContribs ) {

			if ( changedStyles.has( contrib.style ) ) {

				needsUpdate = true;
				break;

			}

		}

		if ( ! needsUpdate )
			continue;

		// Recompute SH: base (style 0) + sum of style contributions
		probe.sh.set( probe.shBase );

		for ( const contrib of probe.styleContribs ) {

			const scale = d_lightstylevalue[ contrib.style ] / 256; // Normalize to 0-1 range

			for ( let i = 0; i < 12; i ++ ) {

				probe.sh[ i ] += contrib.sh[ i ] * scale;

			}

		}

	}

	// Update cache
	cachedLightstyleValues.set( d_lightstylevalue );

}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Clear all light probes. Called when map is unloaded.
 */
export function R_ClearLightProbes() {

	probes = null;
	leafToProbe = null;
	currentWorldmodel = null;
	cachedLightstyleValues = null;

}

/**
 * Get probe statistics for debugging.
 */
export function R_GetLightProbeStats() {

	if ( ! probes )
		return null;

	let totalStyleContribs = 0;
	for ( const probe of probes ) {

		totalStyleContribs += probe.styleContribs.length;

	}

	return {
		numProbes: probes.length,
		totalStyleContribs,
		memoryBytes: probes.length * ( 12 * 4 * 2 + 12 ) + totalStyleContribs * ( 12 * 4 + 4 )
	};

}
