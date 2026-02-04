//============================================================================
// gl_texture_enhance.js - GPU-accelerated texture upscaling and PBR enhancement
//
// Features:
// - xBRZ-style pixel art upscaling (WebGL shader, load-time)
// - PBR map generation (roughness, normal maps)
// - Memory-conscious design with disposal and tracking
//
// CVars:
// - r_tex_upscale: 0=off, 1=2x, 2=4x upscaling
// - r_tex_pbr: 0=off, 1=on (generate and use PBR maps)
// - r_tex_upscale_filter: 0=xBRZ (pixel art), 1=bilinear (smooth)
//============================================================================

import * as THREE from 'three';
import { cvar_t } from './cvar.js';

//============================================================================
// CVars
//============================================================================

export const r_tex_upscale = new cvar_t( 'r_tex_upscale', '1', true ); // 0=off, 1=2x (default), 2=4x
export const r_tex_pbr = new cvar_t( 'r_tex_pbr', '1', true ); // 0=off, 1=on (default on)
export const r_tex_upscale_filter = new cvar_t( 'r_tex_upscale_filter', '0', true ); // 0=scale2x (sharp), 1=scale2x enhanced (smoother)

//============================================================================
// Memory tracking
//============================================================================

let _totalTextureMemory = 0; // bytes
let _upscaledTextureCount = 0;
let _pbrMapCount = 0;

export function getTextureMemoryStats() {

	return {
		totalBytes: _totalTextureMemory,
		totalMB: ( _totalTextureMemory / ( 1024 * 1024 ) ).toFixed( 2 ),
		upscaledCount: _upscaledTextureCount,
		pbrMapCount: _pbrMapCount
	};

}

function trackTextureMemory( width, height, channels = 4, add = true ) {

	const bytes = width * height * channels;
	if ( add ) {

		_totalTextureMemory += bytes;

	} else {

		_totalTextureMemory -= bytes;

	}

}

//============================================================================
// xBRZ Upscaler (WebGL shader-based)
//
// Adapted from libretro xbrz-freescale.glsl
// Processes textures at load-time using render-to-texture
//============================================================================

let _upscalerInitialized = false;
let _upscalerRenderer = null;
let _upscalerScene = null;
let _upscalerCamera = null;
let _upscalerMaterial = null;
let _upscalerQuad = null;

// xBRZ vertex shader
const XBRZ_VERTEX_SHADER = `
varying vec2 vUv;
varying vec2 vTexCoord;

uniform vec2 textureSize;
uniform vec2 outputSize;

void main() {
	vUv = uv;
	vTexCoord = uv * 1.0001; // Slight offset to avoid edge artifacts
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// xBRZ fragment shader - simplified but effective pixel art upscaler
// Based on xBR/xBRZ pattern matching for clean edges
const XBRZ_FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 textureSize;
uniform vec2 outputSize;

varying vec2 vUv;
varying vec2 vTexCoord;

#define BLEND_NONE 0
#define BLEND_NORMAL 1
#define BLEND_DOMINANT 2

#define LUMINANCE_WEIGHT 1.0
#define EQUAL_COLOR_TOLERANCE 0.1176470588 // 30.0/255.0
#define STEEP_DIRECTION_THRESHOLD 2.2
#define DOMINANT_DIRECTION_THRESHOLD 3.6

// YCbCr-based color distance (perceptually accurate)
float distYCbCr(vec3 pixA, vec3 pixB) {
	const vec3 w = vec3(0.2627, 0.6780, 0.0593);
	const float scaleB = 0.5 / (1.0 - w.b);
	const float scaleR = 0.5 / (1.0 - w.r);
	vec3 diff = pixA - pixB;
	float Y = dot(diff, w);
	float Cb = scaleB * (diff.b - Y);
	float Cr = scaleR * (diff.r - Y);
	return sqrt((LUMINANCE_WEIGHT * Y * LUMINANCE_WEIGHT * Y) + Cb * Cb + Cr * Cr);
}

bool isPixEqual(vec3 pixA, vec3 pixB) {
	return distYCbCr(pixA, pixB) < EQUAL_COLOR_TOLERANCE;
}

// Blend ratio calculation for smooth edges
float getLeftRatio(vec2 center, vec2 origin, vec2 direction, vec2 scale) {
	vec2 P0 = center - origin;
	vec2 proj = direction * (dot(P0, direction) / dot(direction, direction));
	vec2 distv = P0 - proj;
	vec2 orth = vec2(-direction.y, direction.x);
	float side = sign(dot(P0, orth));
	float v = side * length(distv * scale);
	return smoothstep(-0.7071067811865476, 0.7071067811865476, v); // sqrt(2)/2
}

#define P(x,y) texture2D(tDiffuse, coord + texelSize * vec2(float(x), float(y))).rgb

void main() {
	vec2 texelSize = 1.0 / textureSize;
	vec2 scale = outputSize / textureSize;
	vec2 pos = fract(vTexCoord * textureSize) - vec2(0.5);
	vec2 coord = vTexCoord - pos * texelSize;

	// Sample 3x3 neighborhood
	vec3 A = P(-1, -1);
	vec3 B = P( 0, -1);
	vec3 C = P( 1, -1);
	vec3 D = P(-1,  0);
	vec3 E = P( 0,  0);
	vec3 F = P( 1,  0);
	vec3 G = P(-1,  1);
	vec3 H = P( 0,  1);
	vec3 I = P( 1,  1);

	// Blend result for each corner
	ivec4 blendResult = ivec4(BLEND_NONE);

	// Corner analysis (bottom-right)
	if (!((E == F && H == I) || (E == H && F == I))) {
		float dist_H_F = distYCbCr(G, E) + distYCbCr(E, C) + distYCbCr(P(0,2), I) + distYCbCr(I, P(2,0)) + 4.0 * distYCbCr(H, F);
		float dist_E_I = distYCbCr(D, H) + distYCbCr(H, P(1,2)) + distYCbCr(B, F) + distYCbCr(F, P(2,1)) + 4.0 * distYCbCr(E, I);
		bool dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * dist_H_F) < dist_E_I;
		blendResult.z = ((dist_H_F < dist_E_I) && !isPixEqual(E, F) && !isPixEqual(E, H))
			? (dominantGradient ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
	}

	// Corner analysis (bottom-left)
	if (!((D == E && G == H) || (D == G && E == H))) {
		float dist_G_E = distYCbCr(P(-2,1), D) + distYCbCr(D, B) + distYCbCr(P(-1,2), H) + distYCbCr(H, F) + 4.0 * distYCbCr(G, E);
		float dist_D_H = distYCbCr(P(-2,0), G) + distYCbCr(G, P(0,2)) + distYCbCr(A, E) + distYCbCr(E, I) + 4.0 * distYCbCr(D, H);
		bool dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * dist_D_H) < dist_G_E;
		blendResult.w = ((dist_G_E > dist_D_H) && !isPixEqual(E, D) && !isPixEqual(E, H))
			? (dominantGradient ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
	}

	// Corner analysis (top-right)
	if (!((B == C && E == F) || (B == E && C == F))) {
		float dist_E_C = distYCbCr(D, B) + distYCbCr(B, P(1,-2)) + distYCbCr(H, F) + distYCbCr(F, P(2,-1)) + 4.0 * distYCbCr(E, C);
		float dist_B_F = distYCbCr(A, E) + distYCbCr(E, I) + distYCbCr(P(0,-2), C) + distYCbCr(C, P(2,0)) + 4.0 * distYCbCr(B, F);
		bool dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * dist_B_F) < dist_E_C;
		blendResult.y = ((dist_E_C > dist_B_F) && !isPixEqual(E, B) && !isPixEqual(E, F))
			? (dominantGradient ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
	}

	// Corner analysis (top-left)
	if (!((A == B && D == E) || (A == D && B == E))) {
		float dist_D_B = distYCbCr(P(-2,0), A) + distYCbCr(A, P(0,-2)) + distYCbCr(G, E) + distYCbCr(E, C) + 4.0 * distYCbCr(D, B);
		float dist_A_E = distYCbCr(P(-2,-1), D) + distYCbCr(D, H) + distYCbCr(P(-1,-2), B) + distYCbCr(B, F) + 4.0 * distYCbCr(A, E);
		bool dominantGradient = (DOMINANT_DIRECTION_THRESHOLD * dist_D_B) < dist_A_E;
		blendResult.x = ((dist_D_B < dist_A_E) && !isPixEqual(E, D) && !isPixEqual(E, B))
			? (dominantGradient ? BLEND_DOMINANT : BLEND_NORMAL) : BLEND_NONE;
	}

	vec3 res = E;

	// Apply blending for bottom-right corner
	if (blendResult.z != BLEND_NONE) {
		float dist_F_G = distYCbCr(F, G);
		float dist_H_C = distYCbCr(H, C);
		bool doLineBlend = (blendResult.z == BLEND_DOMINANT ||
			!((blendResult.y != BLEND_NONE && !isPixEqual(E, G)) ||
			  (blendResult.w != BLEND_NONE && !isPixEqual(E, C)) ||
			  (isPixEqual(G, H) && isPixEqual(H, I) && isPixEqual(I, F) && isPixEqual(F, C) && !isPixEqual(E, I))));

		vec2 origin = vec2(0.0, 0.7071067811865476);
		vec2 direction = vec2(1.0, -1.0);
		if (doLineBlend) {
			bool haveShallowLine = (STEEP_DIRECTION_THRESHOLD * dist_F_G <= dist_H_C) && !isPixEqual(E, G) && !isPixEqual(D, G);
			bool haveSteepLine = (STEEP_DIRECTION_THRESHOLD * dist_H_C <= dist_F_G) && !isPixEqual(E, C) && !isPixEqual(B, C);
			origin = haveShallowLine ? vec2(0.0, 0.25) : vec2(0.0, 0.5);
			direction.x += haveShallowLine ? 1.0 : 0.0;
			direction.y -= haveSteepLine ? 1.0 : 0.0;
		}
		vec3 blendPix = mix(H, F, step(distYCbCr(E, F), distYCbCr(E, H)));
		res = mix(res, blendPix, getLeftRatio(pos, origin, direction, scale));
	}

	// Apply blending for bottom-left corner
	if (blendResult.w != BLEND_NONE) {
		float dist_H_A = distYCbCr(H, A);
		float dist_D_I = distYCbCr(D, I);
		bool doLineBlend = (blendResult.w == BLEND_DOMINANT ||
			!((blendResult.z != BLEND_NONE && !isPixEqual(E, A)) ||
			  (blendResult.x != BLEND_NONE && !isPixEqual(E, I)) ||
			  (isPixEqual(A, D) && isPixEqual(D, G) && isPixEqual(G, H) && isPixEqual(H, I) && !isPixEqual(E, G))));

		vec2 origin = vec2(-0.7071067811865476, 0.0);
		vec2 direction = vec2(1.0, 1.0);
		if (doLineBlend) {
			bool haveShallowLine = (STEEP_DIRECTION_THRESHOLD * dist_H_A <= dist_D_I) && !isPixEqual(E, A) && !isPixEqual(B, A);
			bool haveSteepLine = (STEEP_DIRECTION_THRESHOLD * dist_D_I <= dist_H_A) && !isPixEqual(E, I) && !isPixEqual(F, I);
			origin = haveShallowLine ? vec2(-0.25, 0.0) : vec2(-0.5, 0.0);
			direction.y += haveShallowLine ? 1.0 : 0.0;
			direction.x += haveSteepLine ? 1.0 : 0.0;
		}
		vec3 blendPix = mix(H, D, step(distYCbCr(E, D), distYCbCr(E, H)));
		res = mix(res, blendPix, getLeftRatio(pos, origin, direction, scale));
	}

	// Apply blending for top-right corner
	if (blendResult.y != BLEND_NONE) {
		float dist_B_I = distYCbCr(B, I);
		float dist_F_A = distYCbCr(F, A);
		bool doLineBlend = (blendResult.y == BLEND_DOMINANT ||
			!((blendResult.x != BLEND_NONE && !isPixEqual(E, I)) ||
			  (blendResult.z != BLEND_NONE && !isPixEqual(E, A)) ||
			  (isPixEqual(I, F) && isPixEqual(F, C) && isPixEqual(C, B) && isPixEqual(B, A) && !isPixEqual(E, C))));

		vec2 origin = vec2(0.7071067811865476, 0.0);
		vec2 direction = vec2(-1.0, -1.0);
		if (doLineBlend) {
			bool haveShallowLine = (STEEP_DIRECTION_THRESHOLD * dist_B_I <= dist_F_A) && !isPixEqual(E, I) && !isPixEqual(H, I);
			bool haveSteepLine = (STEEP_DIRECTION_THRESHOLD * dist_F_A <= dist_B_I) && !isPixEqual(E, A) && !isPixEqual(D, A);
			origin = haveShallowLine ? vec2(0.25, 0.0) : vec2(0.5, 0.0);
			direction.y -= haveShallowLine ? 1.0 : 0.0;
			direction.x -= haveSteepLine ? 1.0 : 0.0;
		}
		vec3 blendPix = mix(F, B, step(distYCbCr(E, B), distYCbCr(E, F)));
		res = mix(res, blendPix, getLeftRatio(pos, origin, direction, scale));
	}

	// Apply blending for top-left corner
	if (blendResult.x != BLEND_NONE) {
		float dist_D_C = distYCbCr(D, C);
		float dist_B_G = distYCbCr(B, G);
		bool doLineBlend = (blendResult.x == BLEND_DOMINANT ||
			!((blendResult.w != BLEND_NONE && !isPixEqual(E, C)) ||
			  (blendResult.y != BLEND_NONE && !isPixEqual(E, G)) ||
			  (isPixEqual(C, B) && isPixEqual(B, A) && isPixEqual(A, D) && isPixEqual(D, G) && !isPixEqual(E, A))));

		vec2 origin = vec2(0.0, -0.7071067811865476);
		vec2 direction = vec2(-1.0, 1.0);
		if (doLineBlend) {
			bool haveShallowLine = (STEEP_DIRECTION_THRESHOLD * dist_D_C <= dist_B_G) && !isPixEqual(E, C) && !isPixEqual(F, C);
			bool haveSteepLine = (STEEP_DIRECTION_THRESHOLD * dist_B_G <= dist_D_C) && !isPixEqual(E, G) && !isPixEqual(H, G);
			origin = haveShallowLine ? vec2(0.0, -0.25) : vec2(0.0, -0.5);
			direction.x -= haveShallowLine ? 1.0 : 0.0;
			direction.y += haveSteepLine ? 1.0 : 0.0;
		}
		vec3 blendPix = mix(D, B, step(distYCbCr(E, B), distYCbCr(E, D)));
		res = mix(res, blendPix, getLeftRatio(pos, origin, direction, scale));
	}

	gl_FragColor = vec4(res, 1.0);
}
`;

// Simple bilinear upscale shader (alternative to xBRZ)
const BILINEAR_FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 textureSize;
uniform vec2 outputSize;

varying vec2 vUv;

void main() {
	gl_FragColor = texture2D(tDiffuse, vUv);
}
`;

// Debug shader - outputs magenta to verify pipeline works
const DEBUG_FRAGMENT_SHADER = `
precision highp float;

uniform sampler2D tDiffuse;
varying vec2 vUv;

void main() {
	// Mix original color with magenta tint to verify shader is running
	vec4 orig = texture2D(tDiffuse, vUv);
	gl_FragColor = vec4(orig.r * 1.5, orig.g * 0.5, orig.b * 1.5, 1.0);
}
`;

/**
 * Initialize the upscaler system (lazy init on first use)
 */
function initUpscaler( mainRenderer ) {

	if ( _upscalerInitialized ) return;

	_upscalerRenderer = mainRenderer;
	_upscalerScene = new THREE.Scene();
	_upscalerCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

	// Create fullscreen quad
	const geometry = new THREE.PlaneGeometry( 2, 2 );
	_upscalerQuad = new THREE.Mesh( geometry );
	_upscalerScene.add( _upscalerQuad );

	_upscalerInitialized = true;

}

/**
 * Get or create the upscaler material for given filter type
 */
function getUpscalerMaterial( filterType, textureSize, outputSize ) {

	const isXBRZ = filterType === 0;

	// Debug: use debug shader to verify pipeline (set to true to test)
	const useDebugShader = true;

	let fragmentShader;
	if ( useDebugShader ) {

		fragmentShader = DEBUG_FRAGMENT_SHADER;

	} else if ( isXBRZ ) {

		fragmentShader = XBRZ_FRAGMENT_SHADER;

	} else {

		fragmentShader = BILINEAR_FRAGMENT_SHADER;

	}

	const material = new THREE.ShaderMaterial( {
		uniforms: {
			tDiffuse: { value: null },
			textureSize: { value: new THREE.Vector2( textureSize.x, textureSize.y ) },
			outputSize: { value: new THREE.Vector2( outputSize.x, outputSize.y ) }
		},
		vertexShader: XBRZ_VERTEX_SHADER,
		fragmentShader: fragmentShader,
		depthTest: false,
		depthWrite: false
	} );

	return material;

}

//============================================================================
// Intelligent Texture Enhancement
//
// Analyzes textures to extract intrinsic properties:
// 1. Detect light direction from shadow/highlight patterns
// 2. Extract albedo (base color without baked lighting)
// 3. Derive height/normal from shading
// 4. Estimate roughness from local variance
// 5. Upscale each component appropriately and recombine
//============================================================================

/**
 * Get pixel index with wrapping for seamless textures
 */
function wrapCoord( v, max ) {

	return ( ( v % max ) + max ) % max;

}

function getIdx( x, y, width, height ) {

	return ( wrapCoord( y, height ) * width + wrapCoord( x, width ) ) * 4;

}

/**
 * Convert RGB to grayscale luminance
 */
function luminance( r, g, b ) {

	return 0.299 * r + 0.587 * g + 0.114 * b;

}

/**
 * Detect dominant light direction by analyzing gradients
 * Returns normalized light vector [lx, ly] where positive Y is down
 * Quake textures typically have light from top-left
 */
function detectLightDirection( srcData, width, height ) {

	let sumGx = 0, sumGy = 0;
	let totalWeight = 0;

	// Sobel gradients weighted by magnitude (edges reveal light direction)
	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			// Get 3x3 neighborhood luminances
			const lumTL = luminance( ...getRGB( srcData, x - 1, y - 1, width, height ) );
			const lumT = luminance( ...getRGB( srcData, x, y - 1, width, height ) );
			const lumTR = luminance( ...getRGB( srcData, x + 1, y - 1, width, height ) );
			const lumL = luminance( ...getRGB( srcData, x - 1, y, width, height ) );
			const lumR = luminance( ...getRGB( srcData, x + 1, y, width, height ) );
			const lumBL = luminance( ...getRGB( srcData, x - 1, y + 1, width, height ) );
			const lumB = luminance( ...getRGB( srcData, x, y + 1, width, height ) );
			const lumBR = luminance( ...getRGB( srcData, x + 1, y + 1, width, height ) );

			// Sobel gradients
			const gx = ( lumTR + 2 * lumR + lumBR ) - ( lumTL + 2 * lumL + lumBL );
			const gy = ( lumBL + 2 * lumB + lumBR ) - ( lumTL + 2 * lumT + lumTR );

			const mag = Math.sqrt( gx * gx + gy * gy );
			if ( mag > 10 ) { // Only consider significant edges

				// Gradient points toward brighter pixels (toward light)
				sumGx += gx;
				sumGy += gy;
				totalWeight += mag;

			}

		}

	}

	// Calculate gradient strength relative to texture size
	const gradientStrength = Math.sqrt( sumGx * sumGx + sumGy * sumGy ) / ( width * height );

	// If gradient is weak or ambiguous (floor/ceiling textures), assume light from top
	// Floor and ceiling textures don't have obvious directional lighting
	if ( totalWeight < 1 || gradientStrength < 0.01 ) {

		// Default: light from top (Y-negative in texture space)
		return { x: 0, y: - 1 };

	}

	// Average gradient direction (normalized)
	const len = Math.sqrt( sumGx * sumGx + sumGy * sumGy );
	if ( len < 1 ) return { x: 0, y: - 1 };

	// Return detected direction, but bias toward top-light for ambiguous cases
	const detectedX = sumGx / len;
	const detectedY = sumGy / len;

	// If Y component is near zero (horizontal light), bias toward top
	if ( Math.abs( detectedY ) < 0.3 ) {

		return { x: detectedX * 0.5, y: - 0.866 }; // Blend toward top-light

	}

	return { x: detectedX, y: detectedY };

}

function getRGB( srcData, x, y, width, height ) {

	const idx = getIdx( x, y, width, height );
	return [ srcData[ idx ], srcData[ idx + 1 ], srcData[ idx + 2 ] ];

}

/**
 * Extract albedo by removing baked lighting
 * Uses local normalization to remove low-frequency shading
 * Preserves bright areas (likely light sources) - energy conserving
 */
function extractAlbedo( srcData, width, height, lightDir ) {

	const albedo = new Uint8Array( width * height * 4 );
	const kernelSize = Math.max( 3, Math.floor( Math.min( width, height ) / 8 ) | 1 );
	const halfK = Math.floor( kernelSize / 2 );

	// First pass: compute local average luminance (low-freq lighting)
	const localLum = new Float32Array( width * height );
	const pixelLum = new Float32Array( width * height );

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			let sum = 0, count = 0;

			for ( let ky = - halfK; ky <= halfK; ky ++ ) {

				for ( let kx = - halfK; kx <= halfK; kx ++ ) {

					const [ r, g, b ] = getRGB( srcData, x + kx, y + ky, width, height );
					sum += luminance( r, g, b );
					count ++;

				}

			}

			localLum[ y * width + x ] = sum / count;

			const [ r, g, b ] = getRGB( srcData, x, y, width, height );
			pixelLum[ y * width + x ] = luminance( r, g, b );

		}

	}

	// Global average and max luminance
	let globalLum = 0, maxLum = 0;
	for ( let i = 0; i < localLum.length; i ++ ) {

		globalLum += pixelLum[ i ];
		maxLum = Math.max( maxLum, pixelLum[ i ] );

	}
	globalLum /= localLum.length;

	// Threshold for "bright" pixels (likely light sources) - preserve these
	const brightThreshold = maxLum * 0.75;

	// Second pass: normalize colors by local luminance to extract albedo
	// But preserve bright areas (light sources)
	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const idx = getIdx( x, y, width, height );
			const outIdx = ( y * width + x ) * 4;

			const r = srcData[ idx ];
			const g = srcData[ idx + 1 ];
			const b = srcData[ idx + 2 ];
			const a = srcData[ idx + 3 ];

			const pLum = pixelLum[ y * width + x ];
			const local = localLum[ y * width + x ];

			// For bright pixels (light sources), preserve original color
			// For darker pixels, normalize to remove baked shading
			if ( pLum > brightThreshold ) {

				// Keep original - this is likely a light source
				albedo[ outIdx ] = r;
				albedo[ outIdx + 1 ] = g;
				albedo[ outIdx + 2 ] = b;

			} else {

				// Gentle normalization - don't over-correct
				const scale = local > 1 ? Math.sqrt( globalLum / local ) : 1; // sqrt for gentler correction
				albedo[ outIdx ] = Math.min( 255, Math.max( 0, Math.round( r * scale ) ) );
				albedo[ outIdx + 1 ] = Math.min( 255, Math.max( 0, Math.round( g * scale ) ) );
				albedo[ outIdx + 2 ] = Math.min( 255, Math.max( 0, Math.round( b * scale ) ) );

			}

			albedo[ outIdx + 3 ] = a;

		}

	}

	return albedo;

}

/**
 * Extract height map from shading using shape-from-shading principles
 * Brighter areas facing light = raised, darker = recessed
 */
function extractHeightMap( srcData, width, height, lightDir ) {

	const heightMap = new Float32Array( width * height );

	// Compute shading (dot product of gradient with light direction)
	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const [ r, g, b ] = getRGB( srcData, x, y, width, height );
			const lum = luminance( r, g, b ) / 255;

			// Use luminance as proxy for height (brighter = more facing light = raised)
			// Adjust by local contrast to emphasize features
			const lumL = luminance( ...getRGB( srcData, x - 1, y, width, height ) ) / 255;
			const lumR = luminance( ...getRGB( srcData, x + 1, y, width, height ) ) / 255;
			const lumT = luminance( ...getRGB( srcData, x, y - 1, width, height ) ) / 255;
			const lumB = luminance( ...getRGB( srcData, x, y + 1, width, height ) ) / 255;

			// Gradient in light direction indicates slope
			const gx = ( lumR - lumL ) * 0.5;
			const gy = ( lumB - lumT ) * 0.5;

			// Height estimate: integrate shading
			// Positive gradient in light direction means surface facing toward light
			const facing = gx * lightDir.x + gy * lightDir.y;
			heightMap[ y * width + x ] = lum + facing * 0.5;

		}

	}

	// Normalize height map to 0-1 range
	let minH = Infinity, maxH = - Infinity;
	for ( let i = 0; i < heightMap.length; i ++ ) {

		minH = Math.min( minH, heightMap[ i ] );
		maxH = Math.max( maxH, heightMap[ i ] );

	}

	const range = maxH - minH || 1;
	for ( let i = 0; i < heightMap.length; i ++ ) {

		heightMap[ i ] = ( heightMap[ i ] - minH ) / range;

	}

	return heightMap;

}

/**
 * Compute roughness from local variance (high variance = rough texture)
 */
function extractRoughness( srcData, width, height ) {

	const roughness = new Float32Array( width * height );

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			let sum = 0, sumSq = 0, count = 0;

			for ( let ky = - 1; ky <= 1; ky ++ ) {

				for ( let kx = - 1; kx <= 1; kx ++ ) {

					const [ r, g, b ] = getRGB( srcData, x + kx, y + ky, width, height );
					const lum = luminance( r, g, b ) / 255;
					sum += lum;
					sumSq += lum * lum;
					count ++;

				}

			}

			const mean = sum / count;
			const variance = sumSq / count - mean * mean;
			roughness[ y * width + x ] = Math.min( 1, Math.sqrt( variance ) * 4 );

		}

	}

	return roughness;

}

/**
 * Intelligent 2x upscale using extracted components
 */
function intelligentUpscale2x( srcData, albedo, heightMap, roughness, width, height, lightDir ) {

	const outWidth = width * 2;
	const outHeight = height * 2;
	const out = new Uint8Array( outWidth * outHeight * 4 );

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			// Get center pixel and neighbors from albedo
			const cIdx = ( y * width + x ) * 4;
			const cR = albedo[ cIdx ], cG = albedo[ cIdx + 1 ], cB = albedo[ cIdx + 2 ], cA = albedo[ cIdx + 3 ];

			// Get height values for edge-aware interpolation
			const hC = heightMap[ y * width + x ];
			const hL = heightMap[ y * width + wrapCoord( x - 1, width ) ];
			const hR = heightMap[ y * width + wrapCoord( x + 1, width ) ];
			const hT = heightMap[ wrapCoord( y - 1, height ) * width + x ];
			const hB = heightMap[ wrapCoord( y + 1, height ) * width + x ];
			const hTL = heightMap[ wrapCoord( y - 1, height ) * width + wrapCoord( x - 1, width ) ];
			const hTR = heightMap[ wrapCoord( y - 1, height ) * width + wrapCoord( x + 1, width ) ];
			const hBL = heightMap[ wrapCoord( y + 1, height ) * width + wrapCoord( x - 1, width ) ];
			const hBR = heightMap[ wrapCoord( y + 1, height ) * width + wrapCoord( x + 1, width ) ];

			// Get neighbor albedo colors
			const getAlbedoAt = ( ax, ay ) => {

				const idx = ( wrapCoord( ay, height ) * width + wrapCoord( ax, width ) ) * 4;
				return { r: albedo[ idx ], g: albedo[ idx + 1 ], b: albedo[ idx + 2 ], a: albedo[ idx + 3 ] };

			};

			const aL = getAlbedoAt( x - 1, y );
			const aR = getAlbedoAt( x + 1, y );
			const aT = getAlbedoAt( x - 1, y );
			const aB = getAlbedoAt( x, y + 1 );
			const aTL = getAlbedoAt( x - 1, y - 1 );
			const aTR = getAlbedoAt( x + 1, y - 1 );
			const aBL = getAlbedoAt( x - 1, y + 1 );
			const aBR = getAlbedoAt( x + 1, y + 1 );

			// Height-aware edge detection
			const edgeThreshold = 0.15;
			const isEdgeL = Math.abs( hC - hL ) > edgeThreshold;
			const isEdgeR = Math.abs( hC - hR ) > edgeThreshold;
			const isEdgeT = Math.abs( hC - hT ) > edgeThreshold;
			const isEdgeB = Math.abs( hC - hB ) > edgeThreshold;

			// Local roughness affects interpolation sharpness
			const r = roughness[ y * width + x ];
			const sharpness = 0.5 + r * 0.5; // Rougher = sharper edges

			// Output 4 pixels with intelligent interpolation
			const ox = x * 2;
			const oy = y * 2;

			// Top-left output pixel
			let e0r = cR, e0g = cG, e0b = cB;
			if ( ! isEdgeL && ! isEdgeT ) {

				// Smooth area: blend toward top-left
				const blend = 0.25 * ( 1 - sharpness );
				e0r = Math.round( cR * ( 1 - blend ) + aTL.r * blend );
				e0g = Math.round( cG * ( 1 - blend ) + aTL.g * blend );
				e0b = Math.round( cB * ( 1 - blend ) + aTL.b * blend );

			} else if ( Math.abs( hTL - hC ) < Math.abs( hTR - hC ) && Math.abs( hTL - hC ) < Math.abs( hBL - hC ) ) {

				// Diagonal edge: extend toward similar height
				const blend = 0.3;
				e0r = Math.round( cR * ( 1 - blend ) + aTL.r * blend );
				e0g = Math.round( cG * ( 1 - blend ) + aTL.g * blend );
				e0b = Math.round( cB * ( 1 - blend ) + aTL.b * blend );

			}

			// Top-right output pixel
			let e1r = cR, e1g = cG, e1b = cB;
			if ( ! isEdgeR && ! isEdgeT ) {

				const blend = 0.25 * ( 1 - sharpness );
				e1r = Math.round( cR * ( 1 - blend ) + aTR.r * blend );
				e1g = Math.round( cG * ( 1 - blend ) + aTR.g * blend );
				e1b = Math.round( cB * ( 1 - blend ) + aTR.b * blend );

			} else if ( Math.abs( hTR - hC ) < Math.abs( hTL - hC ) && Math.abs( hTR - hC ) < Math.abs( hBR - hC ) ) {

				const blend = 0.3;
				e1r = Math.round( cR * ( 1 - blend ) + aTR.r * blend );
				e1g = Math.round( cG * ( 1 - blend ) + aTR.g * blend );
				e1b = Math.round( cB * ( 1 - blend ) + aTR.b * blend );

			}

			// Bottom-left output pixel
			let e2r = cR, e2g = cG, e2b = cB;
			if ( ! isEdgeL && ! isEdgeB ) {

				const blend = 0.25 * ( 1 - sharpness );
				e2r = Math.round( cR * ( 1 - blend ) + aBL.r * blend );
				e2g = Math.round( cG * ( 1 - blend ) + aBL.g * blend );
				e2b = Math.round( cB * ( 1 - blend ) + aBL.b * blend );

			} else if ( Math.abs( hBL - hC ) < Math.abs( hTL - hC ) && Math.abs( hBL - hC ) < Math.abs( hBR - hC ) ) {

				const blend = 0.3;
				e2r = Math.round( cR * ( 1 - blend ) + aBL.r * blend );
				e2g = Math.round( cG * ( 1 - blend ) + aBL.g * blend );
				e2b = Math.round( cB * ( 1 - blend ) + aBL.b * blend );

			}

			// Bottom-right output pixel
			let e3r = cR, e3g = cG, e3b = cB;
			if ( ! isEdgeR && ! isEdgeB ) {

				const blend = 0.25 * ( 1 - sharpness );
				e3r = Math.round( cR * ( 1 - blend ) + aBR.r * blend );
				e3g = Math.round( cG * ( 1 - blend ) + aBR.g * blend );
				e3b = Math.round( cB * ( 1 - blend ) + aBR.b * blend );

			} else if ( Math.abs( hBR - hC ) < Math.abs( hTR - hC ) && Math.abs( hBR - hC ) < Math.abs( hBL - hC ) ) {

				const blend = 0.3;
				e3r = Math.round( cR * ( 1 - blend ) + aBR.r * blend );
				e3g = Math.round( cG * ( 1 - blend ) + aBR.g * blend );
				e3b = Math.round( cB * ( 1 - blend ) + aBR.b * blend );

			}

			// Add subtle depth enhancement based on height, but preserve original energy
			// This adds detail without changing overall brightness
			const addDepthDetail = ( baseR, baseG, baseB, nx, ny ) => {

				// Compute surface normal
				const nz = 1.0;
				const len = Math.sqrt( nx * nx + ny * ny + nz * nz );
				const nnx = nx / len, nny = ny / len, nnz = nz / len;

				// Shading factor (how much surface faces light)
				const ndotl = nnx * lightDir.x + nny * lightDir.y + nnz * 0.7;

				// Detail multiplier: centered around 1.0 (energy conserving)
				// Range ~0.85 to ~1.15 - subtle enhancement, not replacement
				const detail = 1.0 + ndotl * 0.15;

				return {
					r: Math.min( 255, Math.max( 0, Math.round( baseR * detail ) ) ),
					g: Math.min( 255, Math.max( 0, Math.round( baseG * detail ) ) ),
					b: Math.min( 255, Math.max( 0, Math.round( baseB * detail ) ) )
				};

			};

			// Estimate normals from height differences (subtle)
			const scale = 1.0;
			const nx0 = ( hC - hL ) * scale, ny0 = ( hC - hT ) * scale;
			const nx1 = ( hR - hC ) * scale, ny1 = ( hC - hT ) * scale;
			const nx2 = ( hC - hL ) * scale, ny2 = ( hB - hC ) * scale;
			const nx3 = ( hR - hC ) * scale, ny3 = ( hB - hC ) * scale;

			const lit0 = addDepthDetail( e0r, e0g, e0b, nx0, ny0 );
			const lit1 = addDepthDetail( e1r, e1g, e1b, nx1, ny1 );
			const lit2 = addDepthDetail( e2r, e2g, e2b, nx2, ny2 );
			const lit3 = addDepthDetail( e3r, e3g, e3b, nx3, ny3 );

			// Energy conservation: ensure average output brightness matches input
			const inputLum = luminance( cR, cG, cB );
			const outputLum = ( luminance( lit0.r, lit0.g, lit0.b ) +
				luminance( lit1.r, lit1.g, lit1.b ) +
				luminance( lit2.r, lit2.g, lit2.b ) +
				luminance( lit3.r, lit3.g, lit3.b ) ) / 4;

			// Scale to conserve energy if needed
			const energyScale = outputLum > 0 ? inputLum / outputLum : 1;

			// Write output pixels with energy conservation
			const setOut = ( px, py, r, g, b ) => {

				const idx = ( py * outWidth + px ) * 4;
				out[ idx ] = Math.min( 255, Math.round( r * energyScale ) );
				out[ idx + 1 ] = Math.min( 255, Math.round( g * energyScale ) );
				out[ idx + 2 ] = Math.min( 255, Math.round( b * energyScale ) );
				out[ idx + 3 ] = cA;

			};

			setOut( ox, oy, lit0.r, lit0.g, lit0.b );
			setOut( ox + 1, oy, lit1.r, lit1.g, lit1.b );
			setOut( ox, oy + 1, lit2.r, lit2.g, lit2.b );
			setOut( ox + 1, oy + 1, lit3.r, lit3.g, lit3.b );

		}

	}

	return { data: out, width: outWidth, height: outHeight };

}

/**
 * Upscale a texture using intelligent analysis
 *
 * Extracts intrinsic properties (albedo, height, roughness) and uses them
 * to guide upscaling with proper edge detection and relighting.
 *
 * @param {THREE.WebGLRenderer} renderer - The main renderer (unused, kept for API compat)
 * @param {THREE.Texture} sourceTexture - Input texture to upscale
 * @param {number} scaleFactor - 2 or 4
 * @param {number} filterType - Reserved for future use
 * @returns {THREE.Texture} - Upscaled texture (caller must dispose when done)
 */
export function upscaleTexture( renderer, sourceTexture, scaleFactor, filterType ) {

	if ( ! sourceTexture || ! sourceTexture.image ) {

		return sourceTexture;

	}

	// Get source dimensions and data
	const srcWidth = sourceTexture.image.width;
	const srcHeight = sourceTexture.image.height;
	const srcData = sourceTexture.image.data;

	if ( ! srcData ) {

		return sourceTexture;

	}

	// Don't upscale already large textures (memory savings)
	if ( srcWidth > 256 || srcHeight > 256 ) {

		return sourceTexture;

	}

	// Don't upscale tiny textures (icons, particles)
	if ( srcWidth < 16 || srcHeight < 16 ) {

		return sourceTexture;

	}

	// Step 1: Analyze texture to extract intrinsic properties
	const lightDir = detectLightDirection( srcData, srcWidth, srcHeight );
	const albedo = extractAlbedo( srcData, srcWidth, srcHeight, lightDir );
	const heightMap = extractHeightMap( srcData, srcWidth, srcHeight, lightDir );
	const roughness = extractRoughness( srcData, srcWidth, srcHeight );

	// Step 2: Intelligent upscaling using extracted properties
	let result = intelligentUpscale2x( srcData, albedo, heightMap, roughness, srcWidth, srcHeight, lightDir );

	// Second 2x pass for 4x total (if requested)
	if ( scaleFactor >= 4 ) {

		// Re-analyze at higher resolution for second pass
		const lightDir2 = detectLightDirection( result.data, result.width, result.height );
		const albedo2 = extractAlbedo( result.data, result.width, result.height, lightDir2 );
		const heightMap2 = extractHeightMap( result.data, result.width, result.height, lightDir2 );
		const roughness2 = extractRoughness( result.data, result.width, result.height );

		result = intelligentUpscale2x( result.data, albedo2, heightMap2, roughness2, result.width, result.height, lightDir2 );

	}

	const pixels = result.data;
	const outWidth = result.width;
	const outHeight = result.height;

	// Create new DataTexture from upscaled pixels
	const upscaledTexture = new THREE.DataTexture( pixels, outWidth, outHeight, THREE.RGBAFormat );
	upscaledTexture.wrapS = THREE.RepeatWrapping;
	upscaledTexture.wrapT = THREE.RepeatWrapping;
	upscaledTexture.magFilter = THREE.LinearFilter;
	upscaledTexture.minFilter = THREE.LinearMipmapLinearFilter;
	upscaledTexture.generateMipmaps = true;
	upscaledTexture.colorSpace = THREE.SRGBColorSpace;
	upscaledTexture.needsUpdate = true;

	// Copy userData (preserves any existing data)
	upscaledTexture.userData = { ...sourceTexture.userData };
	upscaledTexture.userData.originalSize = { width: srcWidth, height: srcHeight };
	upscaledTexture.userData.upscaled = true;
	upscaledTexture.userData.scaleFactor = scaleFactor;
	// Store pixels for PBR generation (will be cleared after use to save memory)
	upscaledTexture.userData.upscaledPixels = pixels;

	// Track memory
	trackTextureMemory( outWidth, outHeight, 4, true );
	_upscaledTextureCount ++;

	return upscaledTexture;

}

//============================================================================
// PBR Map Generation (enhanced from gl_texture_analysis.js)
//
// Generates roughness and normal maps from the (possibly upscaled) texture
//============================================================================

/**
 * Generate PBR maps from RGBA pixel data
 * Memory-conscious: generates maps only when r_tex_pbr is enabled
 *
 * @param {Uint8Array} rgba - RGBA pixel data
 * @param {number} width - Texture width
 * @param {number} height - Texture height
 * @returns {Object|null} { roughnessMap, normalMap } or null if disabled
 */
export function generatePBRMaps( rgba, width, height ) {

	// Convert to grayscale for analysis
	const gray = new Float32Array( width * height );
	for ( let i = 0; i < width * height; i ++ ) {

		gray[ i ] = (
			rgba[ i * 4 ] * 0.299 +
			rgba[ i * 4 + 1 ] * 0.587 +
			rgba[ i * 4 + 2 ] * 0.114
		) / 255;

	}

	// Generate roughness map
	const roughnessData = generateRoughnessMapData( gray, width, height );
	const roughnessMap = createGrayscaleTexture( roughnessData, width, height );

	// Generate normal map
	const normalData = generateNormalMapData( gray, width, height );
	const normalMap = createNormalTexture( normalData, width, height );

	// Track memory
	trackTextureMemory( width, height, 4, true ); // roughness (stored as RGBA)
	trackTextureMemory( width, height, 4, true ); // normal
	_pbrMapCount += 2;

	return { roughnessMap, normalMap };

}

/**
 * Generate roughness map data from local variance
 */
function generateRoughnessMapData( gray, width, height ) {

	const roughness = new Uint8Array( width * height );
	const kernelSize = 3;
	const halfKernel = Math.floor( kernelSize / 2 );

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			let sum = 0;
			let sumSq = 0;
			let count = 0;

			for ( let ky = - halfKernel; ky <= halfKernel; ky ++ ) {

				for ( let kx = - halfKernel; kx <= halfKernel; kx ++ ) {

					const sx = ( x + kx + width ) % width;
					const sy = ( y + ky + height ) % height;
					const val = gray[ sy * width + sx ];

					sum += val;
					sumSq += val * val;
					count ++;

				}

			}

			const mean = sum / count;
			const variance = ( sumSq / count ) - ( mean * mean );

			// Higher variance = higher roughness
			// Inverted so smooth areas have low roughness (shiny)
			const rough = Math.min( 1, Math.sqrt( variance ) * 4 );
			roughness[ y * width + x ] = Math.floor( rough * 255 );

		}

	}

	return roughness;

}

/**
 * Generate normal map data using Sobel edge detection
 */
function generateNormalMapData( gray, width, height ) {

	const normals = new Uint8Array( width * height * 4 );
	const strength = 0.5; // Keep normals subtle to avoid harsh specular highlights

	const sobelX = [ - 1, 0, 1, - 2, 0, 2, - 1, 0, 1 ];
	const sobelY = [ - 1, - 2, - 1, 0, 0, 0, 1, 2, 1 ];

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			let gx = 0;
			let gy = 0;

			for ( let ky = - 1; ky <= 1; ky ++ ) {

				for ( let kx = - 1; kx <= 1; kx ++ ) {

					const sx = ( x + kx + width ) % width;
					const sy = ( y + ky + height ) % height;
					const val = gray[ sy * width + sx ];

					const ki = ( ky + 1 ) * 3 + ( kx + 1 );
					gx += val * sobelX[ ki ];
					gy += val * sobelY[ ki ];

				}

			}

			const nx = - gx * strength;
			const ny = - gy * strength;
			const nz = 1;
			const len = Math.sqrt( nx * nx + ny * ny + nz * nz );

			const i = ( y * width + x ) * 4;
			normals[ i ] = Math.floor( ( ( nx / len ) * 0.5 + 0.5 ) * 255 );
			normals[ i + 1 ] = Math.floor( ( ( ny / len ) * 0.5 + 0.5 ) * 255 );
			normals[ i + 2 ] = Math.floor( ( ( nz / len ) * 0.5 + 0.5 ) * 255 );
			normals[ i + 3 ] = 255;

		}

	}

	return normals;

}

/**
 * Create grayscale Three.js texture
 */
function createGrayscaleTexture( data, width, height ) {

	const rgba = new Uint8Array( width * height * 4 );
	for ( let i = 0; i < width * height; i ++ ) {

		rgba[ i * 4 ] = data[ i ];
		rgba[ i * 4 + 1 ] = data[ i ];
		rgba[ i * 4 + 2 ] = data[ i ];
		rgba[ i * 4 + 3 ] = 255;

	}

	const texture = new THREE.DataTexture( rgba, width, height, THREE.RGBAFormat );
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;

	return texture;

}

/**
 * Create normal map Three.js texture
 */
function createNormalTexture( data, width, height ) {

	const texture = new THREE.DataTexture( data, width, height, THREE.RGBAFormat );
	texture.wrapS = THREE.RepeatWrapping;
	texture.wrapT = THREE.RepeatWrapping;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearMipmapLinearFilter;
	texture.generateMipmaps = true;
	texture.needsUpdate = true;

	return texture;

}

//============================================================================
// High-level API for texture enhancement pipeline
//============================================================================

/**
 * Enhance a texture based on current cvar settings
 * This is the main entry point called during texture loading
 *
 * @param {THREE.WebGLRenderer} renderer - The main renderer
 * @param {THREE.Texture} texture - The source texture
 * @param {Uint8Array} rgba - Original RGBA pixel data
 * @param {number} width - Original width
 * @param {number} height - Original height
 * @param {boolean} isAlphaTexture - Whether texture has transparency
 * @returns {THREE.Texture} - Enhanced texture (may be same as input if no enhancement)
 */
export function enhanceTexture( renderer, texture, rgba, width, height, isAlphaTexture ) {

	// Skip enhancement for alpha textures (fence textures, etc.)
	if ( isAlphaTexture ) {

		return texture;

	}

	// Skip very small textures
	if ( width < 16 || height < 16 ) {

		return texture;

	}

	let resultTexture = texture;
	let resultRgba = rgba;
	let resultWidth = width;
	let resultHeight = height;

	// Step 1: Upscale if enabled
	const upscaleLevel = r_tex_upscale.value | 0;
	if ( upscaleLevel > 0 && renderer ) {

		const scaleFactor = upscaleLevel === 1 ? 2 : 4;
		const filterType = r_tex_upscale_filter.value | 0;

		const upscaled = upscaleTexture( renderer, texture, scaleFactor, filterType );

		if ( upscaled !== texture ) {

			// Dispose original texture to save memory
			texture.dispose();
			trackTextureMemory( width, height, 4, false );

			resultTexture = upscaled;
			resultWidth = width * scaleFactor;
			resultHeight = height * scaleFactor;

			// Get upscaled RGBA data for PBR generation (stored in userData)
			if ( r_tex_pbr.value && upscaled.userData.upscaledPixels ) {

				resultRgba = upscaled.userData.upscaledPixels;

			}

		}

	}

	// Step 2: Generate PBR maps if enabled
	if ( r_tex_pbr.value ) {

		// Use the (possibly upscaled) rgba data
		const pixelData = resultRgba || rgba;
		const pbrMaps = generatePBRMaps( pixelData, resultWidth, resultHeight );

		if ( pbrMaps ) {

			resultTexture.userData = resultTexture.userData || {};
			resultTexture.userData.roughnessMap = pbrMaps.roughnessMap;
			resultTexture.userData.normalMap = pbrMaps.normalMap;

		}

	}

	// Clear temporary pixel data to save memory
	if ( resultTexture.userData && resultTexture.userData.upscaledPixels ) {

		delete resultTexture.userData.upscaledPixels;

	}

	return resultTexture;

}

//============================================================================
// Cleanup and disposal
//============================================================================

/**
 * Dispose of all enhancement-related resources
 * Call when changing maps or shutting down
 */
export function disposeEnhancementResources() {

	if ( _upscalerQuad ) {

		_upscalerQuad.geometry.dispose();
		if ( _upscalerQuad.material ) {

			_upscalerQuad.material.dispose();

		}

	}

	_upscalerScene = null;
	_upscalerCamera = null;
	_upscalerQuad = null;
	_upscalerMaterial = null;
	_upscalerInitialized = false;

	// Reset counters
	_totalTextureMemory = 0;
	_upscaledTextureCount = 0;
	_pbrMapCount = 0;

}

/**
 * Dispose PBR maps from a texture's userData to free memory
 */
export function disposePBRMaps( texture ) {

	if ( ! texture || ! texture.userData ) return;

	if ( texture.userData.roughnessMap ) {

		texture.userData.roughnessMap.dispose();
		trackTextureMemory(
			texture.userData.roughnessMap.image.width,
			texture.userData.roughnessMap.image.height,
			4, false
		);
		texture.userData.roughnessMap = null;
		_pbrMapCount --;

	}

	if ( texture.userData.normalMap ) {

		texture.userData.normalMap.dispose();
		trackTextureMemory(
			texture.userData.normalMap.image.width,
			texture.userData.normalMap.image.height,
			4, false
		);
		texture.userData.normalMap = null;
		_pbrMapCount --;

	}

}
