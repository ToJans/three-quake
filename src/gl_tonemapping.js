// HDR Tonemapping Post-Processing
// Maps high dynamic range colors to displayable range while preserving detail

import * as THREE from 'three';
import { renderer, vid, VID_AddResizeCallback } from './vid.js';
import { scene, camera } from './gl_rmain.js';

//============================================================================
// Tonemapping State
//============================================================================

let tonemappingEnabled = false;
let tonemappingInitialized = false;

// Render targets
let sceneRenderTarget = null;

// Materials
let tonemapMaterial = null;

// Screen quad for post-processing
let screenQuad = null;
let screenScene = null;
let screenCamera = null;

// Parameters (controlled by cvars)
let tonemapOperator = 0;  // 0=ACES, 1=Reinhard, 2=Uncharted2
let tonemapExposure = 1.0;
let tonemapGamma = 2.2;
let tonemapDebug = 0;

//============================================================================
// Tonemapping Shaders
//============================================================================

const fullscreenVertexShader = /* glsl */`
varying vec2 vUv;

void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Tonemapping fragment shader with multiple operators
const tonemapFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tScene;
uniform float tonemapOperator;
uniform float exposure;
uniform float gamma;
uniform float debugMode;

// ACES Filmic Tonemapping
// Reference: https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/
vec3 ACESFilm(vec3 x) {
	float a = 2.51;
	float b = 0.03;
	float c = 2.43;
	float d = 0.59;
	float e = 0.14;
	return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Reinhard Tonemapping (simple luminance-based)
vec3 Reinhard(vec3 x) {
	return x / (1.0 + x);
}

// Reinhard Extended (with white point control)
vec3 ReinhardExtended(vec3 x, float whitePoint) {
	float wp2 = whitePoint * whitePoint;
	return (x * (1.0 + x / wp2)) / (1.0 + x);
}

// Uncharted 2 Filmic Tonemapping
// Reference: http://filmicworlds.com/blog/filmic-tonemapping-operators/
vec3 Uncharted2Tonemap(vec3 x) {
	float A = 0.15;  // Shoulder Strength
	float B = 0.50;  // Linear Strength
	float C = 0.10;  // Linear Angle
	float D = 0.20;  // Toe Strength
	float E = 0.02;  // Toe Numerator
	float F = 0.30;  // Toe Denominator
	return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

vec3 Uncharted2(vec3 color) {
	float W = 11.2;  // Linear White Point
	float exposureBias = 2.0;
	vec3 curr = Uncharted2Tonemap(exposureBias * color);
	vec3 whiteScale = 1.0 / Uncharted2Tonemap(vec3(W));
	return curr * whiteScale;
}

void main() {
	vec4 color = texture2D(tScene, vUv);
	vec3 hdrColor = color.rgb;

	// Apply exposure
	hdrColor *= exposure;

	// Debug modes
	if (debugMode > 2.5) {
		// Show raw HDR values (clamped)
		gl_FragColor = vec4(clamp(hdrColor, 0.0, 1.0), 1.0);
		return;
	}

	if (debugMode > 1.5) {
		// Show luminance
		float lum = dot(hdrColor, vec3(0.2126, 0.7152, 0.0722));
		gl_FragColor = vec4(lum, lum, lum, 1.0);
		return;
	}

	if (debugMode > 0.5) {
		// Show exposure-adjusted but no tonemapping
		gl_FragColor = vec4(clamp(hdrColor, 0.0, 1.0), 1.0);
		return;
	}

	// Apply selected tonemapping operator
	vec3 mapped;

	if (tonemapOperator < 0.5) {
		// ACES Filmic (default)
		mapped = ACESFilm(hdrColor);
	} else if (tonemapOperator < 1.5) {
		// Reinhard
		mapped = Reinhard(hdrColor);
	} else {
		// Uncharted 2
		mapped = Uncharted2(hdrColor);
	}

	// Apply gamma correction
	mapped = pow(mapped, vec3(1.0 / gamma));

	gl_FragColor = vec4(mapped, 1.0);
}
`;

//============================================================================
// Initialization
//============================================================================

function createRenderTarget() {

	const width = vid.width;
	const height = vid.height;

	sceneRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.HalfFloatType // HDR
	} );

}

function createMaterial() {

	tonemapMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tScene: { value: null },
			tonemapOperator: { value: tonemapOperator },
			exposure: { value: tonemapExposure },
			gamma: { value: tonemapGamma },
			debugMode: { value: tonemapDebug }
		},
		vertexShader: fullscreenVertexShader,
		fragmentShader: tonemapFragmentShader,
		depthTest: false,
		depthWrite: false
	} );

}

function createScreenQuad() {

	screenScene = new THREE.Scene();
	screenScene.background = null;
	screenCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

	const geometry = new THREE.PlaneGeometry( 2, 2 );
	screenQuad = new THREE.Mesh( geometry, tonemapMaterial );
	screenScene.add( screenQuad );

}

export function Tonemapping_Init() {

	if ( tonemappingInitialized ) return;

	createRenderTarget();
	createMaterial();
	createScreenQuad();

	// Register for resize events
	VID_AddResizeCallback( Tonemapping_Resize );

	tonemappingInitialized = true;

}

//============================================================================
// Resize handling
//============================================================================

export function Tonemapping_Resize( width, height ) {

	if ( ! tonemappingInitialized ) return;

	sceneRenderTarget.setSize( width, height );

}

//============================================================================
// Parameter setters (called from cvar changes)
//============================================================================

export function Tonemapping_SetEnabled( enabled ) {

	tonemappingEnabled = enabled;
	if ( enabled && ! tonemappingInitialized ) {

		Tonemapping_Init();

	}

}

export function Tonemapping_SetOperator( value ) {

	tonemapOperator = value;
	if ( tonemapMaterial ) {

		tonemapMaterial.uniforms.tonemapOperator.value = value;

	}

}

export function Tonemapping_SetExposure( value ) {

	tonemapExposure = value;
	if ( tonemapMaterial ) {

		tonemapMaterial.uniforms.exposure.value = value;

	}

}

export function Tonemapping_SetGamma( value ) {

	tonemapGamma = value;
	if ( tonemapMaterial ) {

		tonemapMaterial.uniforms.gamma.value = value;

	}

}

export function Tonemapping_SetDebugMode( value ) {

	tonemapDebug = value;
	if ( tonemapMaterial ) {

		tonemapMaterial.uniforms.debugMode.value = value;

	}

}

//============================================================================
// Main render function
//============================================================================

export function Tonemapping_Apply() {

	if ( ! tonemappingEnabled || ! tonemappingInitialized ) return;
	if ( ! renderer || ! scene || ! camera ) return;

	const width = vid.width;
	const height = vid.height;

	// Ensure render target is correct size
	if ( sceneRenderTarget.width !== width || sceneRenderTarget.height !== height ) {

		sceneRenderTarget.setSize( width, height );

	}

	// Store current render target
	const currentRenderTarget = renderer.getRenderTarget();

	// 1. Capture the scene to HDR buffer
	renderer.setRenderTarget( sceneRenderTarget );
	renderer.render( scene, camera );

	// 2. Apply tonemapping to the captured scene
	tonemapMaterial.uniforms.tScene.value = sceneRenderTarget.texture;

	screenQuad.material = tonemapMaterial;
	renderer.setRenderTarget( currentRenderTarget );

	// Clear before rendering (tonemapping replaces the scene, doesn't blend)
	renderer.render( screenScene, screenCamera );

}

//============================================================================
// Combined render with bloom
//
// When both bloom and tonemapping are enabled, this function handles both
// in a single pipeline for proper HDR workflow:
// 1. Render scene to HDR buffer
// 2. Extract bright pixels for bloom
// 3. Blur and composite bloom onto HDR scene
// 4. Apply tonemapping to final HDR result
//============================================================================

// Shared scene render target for bloom + tonemapping pipeline
let sharedSceneTarget = null;
let bloomCompositeTarget = null;

function ensureSharedTargets() {

	const width = vid.width;
	const height = vid.height;

	if ( ! sharedSceneTarget ) {

		sharedSceneTarget = new THREE.WebGLRenderTarget( width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType
		} );

	} else if ( sharedSceneTarget.width !== width || sharedSceneTarget.height !== height ) {

		sharedSceneTarget.setSize( width, height );

	}

	if ( ! bloomCompositeTarget ) {

		bloomCompositeTarget = new THREE.WebGLRenderTarget( width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType
		} );

	} else if ( bloomCompositeTarget.width !== width || bloomCompositeTarget.height !== height ) {

		bloomCompositeTarget.setSize( width, height );

	}

	return { sceneTarget: sharedSceneTarget, compositeTarget: bloomCompositeTarget };

}

export function Tonemapping_GetSharedSceneTarget() {

	ensureSharedTargets();
	return sharedSceneTarget;

}

export function Tonemapping_ApplyToTexture( inputTexture ) {

	if ( ! tonemappingEnabled || ! tonemappingInitialized ) return;
	if ( ! renderer ) return;

	// Apply tonemapping to the provided texture
	tonemapMaterial.uniforms.tScene.value = inputTexture;

	screenQuad.material = tonemapMaterial;
	renderer.setRenderTarget( null ); // Render to screen
	renderer.render( screenScene, screenCamera );

}

//============================================================================
// Cleanup
//============================================================================

export function Tonemapping_Dispose() {

	if ( sceneRenderTarget ) sceneRenderTarget.dispose();
	if ( sharedSceneTarget ) sharedSceneTarget.dispose();
	if ( bloomCompositeTarget ) bloomCompositeTarget.dispose();
	if ( tonemapMaterial ) tonemapMaterial.dispose();

	tonemappingInitialized = false;

}
