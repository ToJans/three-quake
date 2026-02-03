// HDR Bloom Post-Processing
// Creates a soft glow around bright light sources (torches, lava, weapon fire)

import * as THREE from 'three';
import { renderer, vid, VID_AddResizeCallback } from './vid.js';
import { scene, camera } from './gl_rmain.js';

//============================================================================
// Bloom State
//============================================================================

let bloomEnabled = false;
let bloomInitialized = false;

// Render targets - mip chain for progressive blur
const MIP_LEVELS = 5;
let brightPassTarget = null;
let blurTargetsH = []; // Horizontal blur targets
let blurTargetsV = []; // Vertical blur targets (ping-pong)

// Materials
let brightPassMaterial = null;
let blurMaterial = null;
let compositeMaterial = null;

// Screen quad for post-processing
let screenQuad = null;
let screenScene = null;
let screenCamera = null;

// Parameters (controlled by cvars)
let bloomThreshold = 0.0;  // No threshold - bloom everything based on brightness
let bloomIntensity = 6.0;  // Strong glow
let bloomRadius = 2.0;     // Blur spread (wider for softer glow)

//============================================================================
// Bloom Shaders
//============================================================================

const fullscreenVertexShader = /* glsl */`
varying vec2 vUv;

void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Bright pass - extracts pixels above threshold
const brightPassFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform float threshold;
uniform float smoothWidth;
uniform float debugMode;

void main() {
	vec4 color = texture2D(tDiffuse, vUv);

	// Calculate luminance
	float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));

	// Boost warm colors (fire, lava, torches) - they should bloom more
	float warmth = max(0.0, color.r - max(color.g, color.b) * 0.5);
	luminance += warmth * 0.5;

	// Debug mode 4: show raw luminance values
	if (debugMode > 3.5) {
		gl_FragColor = vec4(luminance, luminance, luminance, 1.0);
		return;
	}

	// Output color scaled by luminance - no threshold filtering
	gl_FragColor = vec4(color.rgb * luminance * 3.0, 1.0);
}
`;

// Gaussian blur - separable (run twice: H then V)
const blurFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform vec2 direction;
uniform vec2 resolution;
uniform float radius;

// 9-tap Gaussian kernel weights (sigma ~= 2.5)
const float weights[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);

void main() {
	vec2 texelSize = 1.0 / resolution;
	vec3 result = texture2D(tDiffuse, vUv).rgb * weights[0];

	for (int i = 1; i < 5; i++) {
		// Multiply offset by radius to control blur spread
		vec2 offset = direction * texelSize * float(i) * radius;
		result += texture2D(tDiffuse, vUv + offset).rgb * weights[i];
		result += texture2D(tDiffuse, vUv - offset).rgb * weights[i];
	}

	gl_FragColor = vec4(result, 1.0);
}
`;

// Composite - combines all blur levels with additive blending
const compositeFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tBlur0;
uniform sampler2D tBlur1;
uniform sampler2D tBlur2;
uniform sampler2D tBlur3;
uniform sampler2D tBlur4;
uniform sampler2D tScene;
uniform sampler2D tBrightPass;
uniform float intensity;
uniform float radius;
uniform float debugMode;

void main() {
	// Debug modes:
	// 0 = normal bloom (additive)
	// 1 = show bloom only
	// 2 = show bright pass (what's being extracted)
	// 3 = show captured scene
	// 4 = show luminance values (bright pass outputs luminance)
	// 5 = show first blur level

	if (debugMode > 4.5) {
		// Show first blur level directly
		vec3 blur0 = texture2D(tBlur0, vUv).rgb;
		gl_FragColor = vec4(blur0 * 5.0, 1.0);  // Boost for visibility
		return;
	}

	if (debugMode > 3.5) {
		// Show luminance (bright pass outputs grayscale luminance in this mode)
		vec3 lum = texture2D(tBrightPass, vUv).rgb;
		gl_FragColor = vec4(lum, 1.0);
		return;
	}

	if (debugMode > 2.5) {
		// Show captured scene
		gl_FragColor = texture2D(tScene, vUv);
		return;
	}

	if (debugMode > 1.5) {
		// Show bright pass
		vec3 bright = texture2D(tBrightPass, vUv).rgb;
		gl_FragColor = vec4(bright, 1.0);
		return;
	}

	// Sample all blur levels
	vec3 bloom = vec3(0.0);

	// Weight each mip level - higher mips = wider blur
	bloom += texture2D(tBlur0, vUv).rgb * 1.0;
	bloom += texture2D(tBlur1, vUv).rgb * 1.2;
	bloom += texture2D(tBlur2, vUv).rgb * 1.4;
	bloom += texture2D(tBlur3, vUv).rgb * 1.6;
	bloom += texture2D(tBlur4, vUv).rgb * 1.8;

	// Normalize and apply intensity
	bloom = bloom / 7.0 * intensity;

	if (debugMode > 0.5) {
		// Show bloom only
		gl_FragColor = vec4(bloom, 1.0);
		return;
	}

	// Output bloom for additive blending
	gl_FragColor = vec4(bloom, 1.0);
}
`;

//============================================================================
// Initialization
//============================================================================

function createRenderTargets() {

	const width = vid.width;
	const height = vid.height;

	// Bright pass at full resolution
	brightPassTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.HalfFloatType // HDR
	} );

	// Create mip chain for progressive blur
	blurTargetsH = [];
	blurTargetsV = [];

	for ( let i = 0; i < MIP_LEVELS; i ++ ) {

		const mipWidth = Math.max( 1, Math.floor( width / Math.pow( 2, i + 1 ) ) );
		const mipHeight = Math.max( 1, Math.floor( height / Math.pow( 2, i + 1 ) ) );

		blurTargetsH[ i ] = new THREE.WebGLRenderTarget( mipWidth, mipHeight, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType
		} );

		blurTargetsV[ i ] = new THREE.WebGLRenderTarget( mipWidth, mipHeight, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType
		} );

	}

}

function createMaterials() {

	// Bright pass material
	brightPassMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tDiffuse: { value: null },
			threshold: { value: bloomThreshold },
			smoothWidth: { value: 0.2 },  // Wider transition for softer falloff
			debugMode: { value: 0.0 }
		},
		vertexShader: fullscreenVertexShader,
		fragmentShader: brightPassFragmentShader,
		depthTest: false,
		depthWrite: false
	} );

	// Blur material (reused for H and V passes)
	blurMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tDiffuse: { value: null },
			direction: { value: new THREE.Vector2( 1, 0 ) },
			resolution: { value: new THREE.Vector2() },
			radius: { value: bloomRadius }
		},
		vertexShader: fullscreenVertexShader,
		fragmentShader: blurFragmentShader,
		depthTest: false,
		depthWrite: false
	} );

	// Composite material - additive blend
	compositeMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tBlur0: { value: null },
			tBlur1: { value: null },
			tBlur2: { value: null },
			tBlur3: { value: null },
			tBlur4: { value: null },
			tScene: { value: null },
			tBrightPass: { value: null },
			intensity: { value: bloomIntensity },
			radius: { value: bloomRadius },
			debugMode: { value: 0.0 }
		},
		vertexShader: fullscreenVertexShader,
		fragmentShader: compositeFragmentShader,
		depthTest: false,
		depthWrite: false,
		transparent: true,
		blending: THREE.AdditiveBlending
	} );

}

function createScreenQuad() {

	screenScene = new THREE.Scene();
	screenScene.background = null;
	screenCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

	const geometry = new THREE.PlaneGeometry( 2, 2 );
	screenQuad = new THREE.Mesh( geometry, brightPassMaterial );
	screenScene.add( screenQuad );

}

export function Bloom_Init() {

	if ( bloomInitialized ) return;

	createRenderTargets();
	createMaterials();
	createScreenQuad();

	// Register for resize events
	VID_AddResizeCallback( Bloom_Resize );

	bloomInitialized = true;

}

//============================================================================
// Resize handling
//============================================================================

export function Bloom_Resize( width, height ) {

	if ( ! bloomInitialized ) return;

	// Resize bright pass target
	brightPassTarget.setSize( width, height );

	// Resize mip chain
	for ( let i = 0; i < MIP_LEVELS; i ++ ) {

		const mipWidth = Math.max( 1, Math.floor( width / Math.pow( 2, i + 1 ) ) );
		const mipHeight = Math.max( 1, Math.floor( height / Math.pow( 2, i + 1 ) ) );

		blurTargetsH[ i ].setSize( mipWidth, mipHeight );
		blurTargetsV[ i ].setSize( mipWidth, mipHeight );

	}

}

//============================================================================
// Parameter setters (called from cvar changes)
//============================================================================

export function Bloom_SetEnabled( enabled ) {

	bloomEnabled = enabled;
	if ( enabled && ! bloomInitialized ) {

		Bloom_Init();

	}

}

export function Bloom_SetThreshold( value ) {

	bloomThreshold = value;
	if ( brightPassMaterial ) {

		brightPassMaterial.uniforms.threshold.value = value;

	}

}

export function Bloom_SetIntensity( value ) {

	bloomIntensity = value;
	if ( compositeMaterial ) {

		compositeMaterial.uniforms.intensity.value = value;

	}

}

export function Bloom_SetRadius( value ) {

	bloomRadius = value;
	if ( compositeMaterial ) {

		compositeMaterial.uniforms.radius.value = value;

	}

	if ( blurMaterial ) {

		blurMaterial.uniforms.radius.value = value;

	}

}

export function Bloom_SetDebugMode( value ) {

	if ( compositeMaterial ) {

		compositeMaterial.uniforms.debugMode.value = value;

	}

	if ( brightPassMaterial ) {

		brightPassMaterial.uniforms.debugMode.value = value;

	}

}

//============================================================================
// Main render function
//============================================================================

// We need a way to get the rendered scene texture
// Since we render after the main scene, we need to capture it first
let sceneRenderTarget = null;

function ensureSceneRenderTarget() {

	const width = vid.width;
	const height = vid.height;

	if ( ! sceneRenderTarget ) {

		sceneRenderTarget = new THREE.WebGLRenderTarget( width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType // HDR for bloom
		} );

	} else if ( sceneRenderTarget.width !== width || sceneRenderTarget.height !== height ) {

		sceneRenderTarget.setSize( width, height );

	}

	return sceneRenderTarget;

}

export function Bloom_Apply() {

	if ( ! bloomEnabled || ! bloomInitialized ) return;
	if ( ! renderer || ! scene || ! camera ) return;

	const width = vid.width;
	const height = vid.height;

	// Store current render target
	const currentRenderTarget = renderer.getRenderTarget();

	// 1. Capture the current framebuffer to use as input
	// Since we're called after renderer.render(), we need to re-render to a target
	const sceneTarget = ensureSceneRenderTarget();
	renderer.setRenderTarget( sceneTarget );
	renderer.render( scene, camera );

	// 2. Bright pass - extract bright pixels
	brightPassMaterial.uniforms.tDiffuse.value = sceneTarget.texture;
	brightPassMaterial.uniforms.threshold.value = bloomThreshold;

	screenQuad.material = brightPassMaterial;
	renderer.setRenderTarget( brightPassTarget );
	renderer.render( screenScene, screenCamera );

	// 3. Progressive blur through mip chain
	let inputTexture = brightPassTarget.texture;

	for ( let i = 0; i < MIP_LEVELS; i ++ ) {

		const mipWidth = blurTargetsH[ i ].width;
		const mipHeight = blurTargetsH[ i ].height;

		// Horizontal blur
		blurMaterial.uniforms.tDiffuse.value = inputTexture;
		blurMaterial.uniforms.direction.value.set( 1, 0 );
		blurMaterial.uniforms.resolution.value.set( mipWidth, mipHeight );

		screenQuad.material = blurMaterial;
		renderer.setRenderTarget( blurTargetsH[ i ] );
		renderer.render( screenScene, screenCamera );

		// Vertical blur
		blurMaterial.uniforms.tDiffuse.value = blurTargetsH[ i ].texture;
		blurMaterial.uniforms.direction.value.set( 0, 1 );

		renderer.setRenderTarget( blurTargetsV[ i ] );
		renderer.render( screenScene, screenCamera );

		// Use this level's output as input for next level (progressive downsampling)
		inputTexture = blurTargetsV[ i ].texture;

	}

	// 4. Composite all blur levels onto the screen with additive blending
	const oldAutoClear = renderer.autoClear;
	const oldAutoClearColor = renderer.autoClearColor;
	const oldAutoClearDepth = renderer.autoClearDepth;
	const oldAutoClearStencil = renderer.autoClearStencil;

	renderer.autoClear = false;
	renderer.autoClearColor = false;
	renderer.autoClearDepth = false;
	renderer.autoClearStencil = false;

	compositeMaterial.uniforms.tBlur0.value = blurTargetsV[ 0 ].texture;
	compositeMaterial.uniforms.tBlur1.value = blurTargetsV[ 1 ].texture;
	compositeMaterial.uniforms.tBlur2.value = blurTargetsV[ 2 ].texture;
	compositeMaterial.uniforms.tBlur3.value = blurTargetsV[ 3 ].texture;
	compositeMaterial.uniforms.tBlur4.value = blurTargetsV[ 4 ].texture;
	compositeMaterial.uniforms.tScene.value = sceneTarget.texture;
	compositeMaterial.uniforms.tBrightPass.value = brightPassTarget.texture;

	// In debug mode, use normal blending to show buffers directly
	const debugMode = compositeMaterial.uniforms.debugMode.value;
	if ( debugMode > 0.5 ) {

		compositeMaterial.blending = THREE.NormalBlending;
		renderer.autoClear = true; // Clear to show buffer directly

	} else {

		compositeMaterial.blending = THREE.AdditiveBlending;

	}

	screenQuad.material = compositeMaterial;
	renderer.setRenderTarget( currentRenderTarget );
	renderer.render( screenScene, screenCamera );

	// Restore autoClear state
	renderer.autoClear = oldAutoClear;
	renderer.autoClearColor = oldAutoClearColor;
	renderer.autoClearDepth = oldAutoClearDepth;
	renderer.autoClearStencil = oldAutoClearStencil;

}

//============================================================================
// HDR Pipeline Support
//
// When tonemapping is enabled, we need to output bloom to an HDR target
// instead of directly to the screen with additive blending.
//============================================================================

let bloomCompositeTarget = null;

// Composite shader that combines scene + bloom (no additive blend, direct output)
const compositeHDRFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tBlur0;
uniform sampler2D tBlur1;
uniform sampler2D tBlur2;
uniform sampler2D tBlur3;
uniform sampler2D tBlur4;
uniform sampler2D tScene;
uniform sampler2D tBrightPass;
uniform float intensity;
uniform float radius;
uniform float debugMode;

void main() {
	// Debug modes work the same as regular composite
	if (debugMode > 4.5) {
		vec3 blur0 = texture2D(tBlur0, vUv).rgb;
		gl_FragColor = vec4(blur0 * 5.0, 1.0);
		return;
	}

	if (debugMode > 3.5) {
		vec3 lum = texture2D(tBrightPass, vUv).rgb;
		gl_FragColor = vec4(lum, 1.0);
		return;
	}

	if (debugMode > 2.5) {
		gl_FragColor = texture2D(tScene, vUv);
		return;
	}

	if (debugMode > 1.5) {
		vec3 bright = texture2D(tBrightPass, vUv).rgb;
		gl_FragColor = vec4(bright, 1.0);
		return;
	}

	// Sample all blur levels
	vec3 bloom = vec3(0.0);

	bloom += texture2D(tBlur0, vUv).rgb * 1.0;
	bloom += texture2D(tBlur1, vUv).rgb * 1.2;
	bloom += texture2D(tBlur2, vUv).rgb * 1.4;
	bloom += texture2D(tBlur3, vUv).rgb * 1.6;
	bloom += texture2D(tBlur4, vUv).rgb * 1.8;

	bloom = bloom / 7.0 * intensity;

	if (debugMode > 0.5) {
		gl_FragColor = vec4(bloom, 1.0);
		return;
	}

	// Combine scene + bloom (additive, but output directly to HDR target)
	vec3 sceneColor = texture2D(tScene, vUv).rgb;
	gl_FragColor = vec4(sceneColor + bloom, 1.0);
}
`;

let compositeHDRMaterial = null;

function ensureHDRPipelineMaterials() {

	if ( ! compositeHDRMaterial ) {

		compositeHDRMaterial = new THREE.ShaderMaterial( {
			uniforms: {
				tBlur0: { value: null },
				tBlur1: { value: null },
				tBlur2: { value: null },
				tBlur3: { value: null },
				tBlur4: { value: null },
				tScene: { value: null },
				tBrightPass: { value: null },
				intensity: { value: bloomIntensity },
				radius: { value: bloomRadius },
				debugMode: { value: 0.0 }
			},
			vertexShader: fullscreenVertexShader,
			fragmentShader: compositeHDRFragmentShader,
			depthTest: false,
			depthWrite: false
		} );

	}

	return compositeHDRMaterial;

}

function ensureBloomCompositeTarget() {

	const width = vid.width;
	const height = vid.height;

	if ( ! bloomCompositeTarget ) {

		bloomCompositeTarget = new THREE.WebGLRenderTarget( width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType // HDR for tonemapping
		} );

	} else if ( bloomCompositeTarget.width !== width || bloomCompositeTarget.height !== height ) {

		bloomCompositeTarget.setSize( width, height );

	}

	return bloomCompositeTarget;

}

export function Bloom_ApplyToTarget() {

	if ( ! bloomEnabled || ! bloomInitialized ) return null;
	if ( ! renderer || ! scene || ! camera ) return null;

	// Ensure we have the HDR composite target and material
	const compositeTarget = ensureBloomCompositeTarget();
	const hdrMaterial = ensureHDRPipelineMaterials();

	// 1. Capture the scene to HDR buffer
	const sceneTarget = ensureSceneRenderTarget();
	renderer.setRenderTarget( sceneTarget );
	renderer.render( scene, camera );

	// 2. Bright pass - extract bright pixels
	brightPassMaterial.uniforms.tDiffuse.value = sceneTarget.texture;
	brightPassMaterial.uniforms.threshold.value = bloomThreshold;

	screenQuad.material = brightPassMaterial;
	renderer.setRenderTarget( brightPassTarget );
	renderer.render( screenScene, screenCamera );

	// 3. Progressive blur through mip chain
	let inputTexture = brightPassTarget.texture;

	for ( let i = 0; i < MIP_LEVELS; i ++ ) {

		const mipWidth = blurTargetsH[ i ].width;
		const mipHeight = blurTargetsH[ i ].height;

		// Horizontal blur
		blurMaterial.uniforms.tDiffuse.value = inputTexture;
		blurMaterial.uniforms.direction.value.set( 1, 0 );
		blurMaterial.uniforms.resolution.value.set( mipWidth, mipHeight );

		screenQuad.material = blurMaterial;
		renderer.setRenderTarget( blurTargetsH[ i ] );
		renderer.render( screenScene, screenCamera );

		// Vertical blur
		blurMaterial.uniforms.tDiffuse.value = blurTargetsH[ i ].texture;
		blurMaterial.uniforms.direction.value.set( 0, 1 );

		renderer.setRenderTarget( blurTargetsV[ i ] );
		renderer.render( screenScene, screenCamera );

		inputTexture = blurTargetsV[ i ].texture;

	}

	// 4. Composite scene + bloom to HDR target (not to screen)
	hdrMaterial.uniforms.tBlur0.value = blurTargetsV[ 0 ].texture;
	hdrMaterial.uniforms.tBlur1.value = blurTargetsV[ 1 ].texture;
	hdrMaterial.uniforms.tBlur2.value = blurTargetsV[ 2 ].texture;
	hdrMaterial.uniforms.tBlur3.value = blurTargetsV[ 3 ].texture;
	hdrMaterial.uniforms.tBlur4.value = blurTargetsV[ 4 ].texture;
	hdrMaterial.uniforms.tScene.value = sceneTarget.texture;
	hdrMaterial.uniforms.tBrightPass.value = brightPassTarget.texture;
	hdrMaterial.uniforms.intensity.value = bloomIntensity;
	hdrMaterial.uniforms.debugMode.value = compositeMaterial.uniforms.debugMode.value;

	screenQuad.material = hdrMaterial;
	renderer.setRenderTarget( compositeTarget );
	renderer.render( screenScene, screenCamera );

	return compositeTarget;

}

export function Bloom_GetSceneTarget() {

	return sceneRenderTarget;

}

//============================================================================
// Cleanup
//============================================================================

export function Bloom_Dispose() {

	if ( brightPassTarget ) brightPassTarget.dispose();

	for ( let i = 0; i < MIP_LEVELS; i ++ ) {

		if ( blurTargetsH[ i ] ) blurTargetsH[ i ].dispose();
		if ( blurTargetsV[ i ] ) blurTargetsV[ i ].dispose();

	}

	if ( sceneRenderTarget ) sceneRenderTarget.dispose();
	if ( bloomCompositeTarget ) bloomCompositeTarget.dispose();

	if ( brightPassMaterial ) brightPassMaterial.dispose();
	if ( blurMaterial ) blurMaterial.dispose();
	if ( compositeMaterial ) compositeMaterial.dispose();
	if ( compositeHDRMaterial ) compositeHDRMaterial.dispose();

	bloomInitialized = false;

}
