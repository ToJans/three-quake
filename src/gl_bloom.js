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
let bloomThreshold = 0.8;
let bloomIntensity = 0.5;
let bloomRadius = 1.0;

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

void main() {
	vec4 color = texture2D(tDiffuse, vUv);

	// Calculate luminance
	float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));

	// Soft threshold with smooth transition
	float brightness = smoothstep(threshold - smoothWidth, threshold + smoothWidth, luminance);

	// Output bright pixels only
	gl_FragColor = vec4(color.rgb * brightness, 1.0);
}
`;

// Gaussian blur - separable (run twice: H then V)
const blurFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform vec2 direction;
uniform vec2 resolution;

// 9-tap Gaussian kernel weights (sigma ~= 2.5)
const float weights[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);

void main() {
	vec2 texelSize = 1.0 / resolution;
	vec3 result = texture2D(tDiffuse, vUv).rgb * weights[0];

	for (int i = 1; i < 5; i++) {
		vec2 offset = direction * texelSize * float(i);
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
uniform float intensity;
uniform float radius;
uniform float debugMode;

void main() {
	// Sample all blur levels
	vec3 bloom = vec3(0.0);

	// Weight each mip level - higher mips = wider blur
	bloom += texture2D(tBlur0, vUv).rgb * 1.0;
	bloom += texture2D(tBlur1, vUv).rgb * 1.2;
	bloom += texture2D(tBlur2, vUv).rgb * 1.4;
	bloom += texture2D(tBlur3, vUv).rgb * 1.6;
	bloom += texture2D(tBlur4, vUv).rgb * 1.8;

	// Normalize and apply intensity
	bloom = bloom / 7.0 * intensity * radius;

	// Debug modes:
	// 0 = normal bloom (additive)
	// 1 = show bloom only (no scene)
	if (debugMode > 0.5) {
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
			smoothWidth: { value: 0.1 }
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
			resolution: { value: new THREE.Vector2() }
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

}

export function Bloom_SetDebugMode( value ) {

	if ( compositeMaterial ) {

		compositeMaterial.uniforms.debugMode.value = value;

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

	// In debug mode, use normal blending to show bloom only
	const debugMode = compositeMaterial.uniforms.debugMode.value;
	if ( debugMode > 0.5 ) {

		compositeMaterial.blending = THREE.NormalBlending;
		renderer.autoClear = true;

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
// Cleanup
//============================================================================

export function Bloom_Dispose() {

	if ( brightPassTarget ) brightPassTarget.dispose();

	for ( let i = 0; i < MIP_LEVELS; i ++ ) {

		if ( blurTargetsH[ i ] ) blurTargetsH[ i ].dispose();
		if ( blurTargetsV[ i ] ) blurTargetsV[ i ].dispose();

	}

	if ( sceneRenderTarget ) sceneRenderTarget.dispose();

	if ( brightPassMaterial ) brightPassMaterial.dispose();
	if ( blurMaterial ) blurMaterial.dispose();
	if ( compositeMaterial ) compositeMaterial.dispose();

	bloomInitialized = false;

}
