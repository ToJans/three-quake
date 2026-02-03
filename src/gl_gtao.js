// Ground Truth Ambient Occlusion (GTAO) Post-Processing
// Based on "Practical Realtime Strategies for Accurate Indirect Occlusion"
// by Jorge Jimenez et al. (Activision)

import * as THREE from 'three';
import { renderer, vid, VID_AddResizeCallback } from './vid.js';
import { scene, camera } from './gl_rmain.js';

//============================================================================
// GTAO State
//============================================================================

let gtaoEnabled = false;
let gtaoInitialized = false;

// Render targets
let depthRenderTarget = null;
let normalRenderTarget = null;
let aoRenderTarget = null;
let aoBlurRenderTarget = null;

// Materials
let depthMaterial = null;
let normalMaterial = null;
let gtaoMaterial = null;
let blurMaterial = null;
let compositeMaterial = null;

// Screen quad for post-processing
let screenQuad = null;
let screenScene = null;
let screenCamera = null;

// Parameters (controlled by cvars)
let gtaoRadius = 2.0;
let gtaoIntensity = 1.5;
let gtaoSamples = 8;
let gtaoFalloff = 1.0;

//============================================================================
// GTAO Shaders
//============================================================================

const gtaoVertexShader = /* glsl */`
varying vec2 vUv;

void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Custom depth material vertex shader
const depthVertexShader = /* glsl */`
varying float vViewZ;

void main() {
	vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
	vViewZ = -mvPosition.z; // Negate because view space Z is negative
	gl_Position = projectionMatrix * mvPosition;
}
`;

// Custom depth material fragment shader - outputs linear depth
const depthFragmentShader = /* glsl */`
precision highp float;

varying float vViewZ;
uniform float cameraNear;
uniform float cameraFar;

void main() {
	// Normalize view Z to 0-1 range
	float linearDepth = (vViewZ - cameraNear) / (cameraFar - cameraNear);
	linearDepth = clamp(linearDepth, 0.0, 1.0);
	gl_FragColor = vec4(linearDepth, linearDepth, linearDepth, 1.0);
}
`;

// Custom normal material vertex shader
const normalVertexShader = /* glsl */`
varying vec3 vViewNormal;

void main() {
	// Transform normal to view space
	vViewNormal = normalize(normalMatrix * normal);
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Custom normal material fragment shader - outputs view-space normals
const normalFragmentShader = /* glsl */`
precision highp float;

varying vec3 vViewNormal;

void main() {
	vec3 normal = normalize(vViewNormal);
	// Pack normal into 0-1 range
	gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
}
`;

// GTAO shader - the main ambient occlusion calculation
const gtaoFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform vec2 resolution;
uniform float radius;
uniform float intensity;
uniform float falloff;
uniform float cameraNear;
uniform float cameraFar;
uniform mat4 cameraProjectionMatrix;
uniform mat4 cameraInverseProjectionMatrix;
uniform float frameCount;

#define PI 3.14159265359

// Get linear depth from depth buffer (already linear 0-1)
float getLinearDepth(vec2 uv) {
	return texture2D(tDepth, uv).r;
}

// Reconstruct view-space position from UV and linear depth
vec3 getViewPosition(vec2 uv, float linearDepth) {
	float viewZ = linearDepth * (cameraFar - cameraNear) + cameraNear;
	vec2 ndc = uv * 2.0 - 1.0;
	vec4 clipPos = vec4(ndc, 0.0, 1.0);
	vec4 viewRay = cameraInverseProjectionMatrix * clipPos;
	viewRay.xyz /= viewRay.w;
	vec3 viewPos = viewRay.xyz * (viewZ / -viewRay.z);
	return viewPos;
}

// Noise for sampling variation
float interleavedGradientNoise(vec2 position) {
	vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
	return fract(magic.z * fract(dot(position, magic.xy)));
}

void main() {
	vec2 texelSize = 1.0 / resolution;
	float centerDepth = getLinearDepth(vUv);

	// Skip sky/far plane
	if (centerDepth > 0.99) {
		gl_FragColor = vec4(1.0);
		return;
	}

	vec3 centerPos = getViewPosition(vUv, centerDepth);
	vec3 normal = texture2D(tNormal, vUv).rgb * 2.0 - 1.0;
	normal = normalize(normal);

	// Screen-space radius based on depth
	float radiusPixels = (radius / max(length(centerPos), 0.1)) * resolution.y * 0.25;
	radiusPixels = clamp(radiusPixels, 2.0, 64.0);

	float noise = interleavedGradientNoise(gl_FragCoord.xy + frameCount * 5.0);
	float occlusion = 0.0;

	const int NUM_DIRECTIONS = 4;
	const int STEPS_PER_DIR = 3;

	for (int dir = 0; dir < NUM_DIRECTIONS; dir++) {
		float angle = (float(dir) + noise) * PI / float(NUM_DIRECTIONS);
		vec2 direction = vec2(cos(angle), sin(angle));
		float horizonCos = -1.0;

		for (int step = 1; step <= STEPS_PER_DIR; step++) {
			float stepRadius = (float(step) / float(STEPS_PER_DIR)) * radiusPixels;
			vec2 sampleUV = vUv + direction * stepRadius * texelSize;

			if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) continue;

			float sampleDepth = getLinearDepth(sampleUV);
			vec3 samplePos = getViewPosition(sampleUV, sampleDepth);
			vec3 horizonVec = samplePos - centerPos;
			float horizonDist = length(horizonVec);

			if (horizonDist > radius * 2.0) continue;

			horizonVec /= horizonDist;
			float horizonAngle = dot(horizonVec, normal);
			float distFalloff = 1.0 - smoothstep(0.0, radius, horizonDist * falloff);
			horizonCos = max(horizonCos, horizonAngle * distFalloff);
		}

		// Opposite direction
		for (int step = 1; step <= STEPS_PER_DIR; step++) {
			float stepRadius = (float(step) / float(STEPS_PER_DIR)) * radiusPixels;
			vec2 sampleUV = vUv - direction * stepRadius * texelSize;

			if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) continue;

			float sampleDepth = getLinearDepth(sampleUV);
			vec3 samplePos = getViewPosition(sampleUV, sampleDepth);
			vec3 horizonVec = samplePos - centerPos;
			float horizonDist = length(horizonVec);

			if (horizonDist > radius * 2.0) continue;

			horizonVec /= horizonDist;
			float horizonAngle = dot(horizonVec, normal);
			float distFalloff = 1.0 - smoothstep(0.0, radius, horizonDist * falloff);
			horizonCos = max(horizonCos, horizonAngle * distFalloff);
		}

		occlusion += max(0.0, horizonCos);
	}

	// Normalize and invert (1 = no occlusion, 0 = full occlusion)
	occlusion = 1.0 - (occlusion / float(NUM_DIRECTIONS));
	occlusion = pow(occlusion, intensity);

	gl_FragColor = vec4(vec3(occlusion), 1.0);
}
`;

// Bilateral blur shader for edge-preserving smoothing
const blurFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform vec2 direction;

#define KERNEL_SIZE 4

void main() {
	vec2 texelSize = 1.0 / resolution;

	float centerDepth = texture2D(tDepth, vUv).r;
	float centerAO = texture2D(tAO, vUv).r;

	float totalAO = centerAO;
	float totalWeight = 1.0;

	// Bilateral weights based on depth similarity
	for (int i = 1; i <= KERNEL_SIZE; i++) {
		vec2 offset = direction * float(i) * texelSize;

		// Sample in both directions
		for (int sign = -1; sign <= 1; sign += 2) {
			vec2 sampleUV = vUv + offset * float(sign);

			if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
				continue;
			}

			float sampleDepth = texture2D(tDepth, sampleUV).r;
			float sampleAO = texture2D(tAO, sampleUV).r;

			// Depth-based weight (bilateral)
			float depthDiff = abs(centerDepth - sampleDepth);
			float depthWeight = exp(-depthDiff * 100.0);

			// Spatial weight (Gaussian)
			float spatialWeight = exp(-float(i * i) / 8.0);

			float weight = depthWeight * spatialWeight;

			totalAO += sampleAO * weight;
			totalWeight += weight;
		}
	}

	gl_FragColor = vec4(vec3(totalAO / totalWeight), 1.0);
}
`;

// Composite shader - applies AO as multiply blend overlay
const compositeFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform float debugMode;

void main() {
	float ao = texture2D(tAO, vUv).r;
	float depth = texture2D(tDepth, vUv).r;
	vec3 normal = texture2D(tNormal, vUv).rgb;

	// Debug modes:
	// 0 = normal AO multiply blend
	// 1 = white (test blending works)
	// 2 = show raw AO
	// 3 = show depth buffer
	// 4 = show normal buffer
	if (debugMode > 3.5) {
		gl_FragColor = vec4(normal, 1.0);
		return;
	}
	if (debugMode > 2.5) {
		gl_FragColor = vec4(depth, depth, depth, 1.0);
		return;
	}
	if (debugMode > 1.5) {
		gl_FragColor = vec4(ao, ao, ao, 1.0);
		return;
	}
	if (debugMode > 0.5) {
		gl_FragColor = vec4(1.0, 1.0, 1.0, 1.0);
		return;
	}

	// Output AO value - will be used with multiply blending
	gl_FragColor = vec4(ao, ao, ao, 1.0);
}
`;

//============================================================================
// Initialization
//============================================================================

function createRenderTargets() {

	const width = vid.width;
	const height = vid.height;

	// Depth render target - use linear filter for smooth sampling
	depthRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.FloatType
	} );

	// Normal render target - use linear filter for smooth sampling
	normalRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat
	} );

	// AO render target - full resolution for quality
	aoRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat
	} );

	aoBlurRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat
	} );

}

// Get AO resolution (can be made configurable later)
function getAOResolution() {

	return { width: vid.width, height: vid.height };

}

function createMaterials() {

	// Custom depth material - outputs linear depth in view space
	depthMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			cameraNear: { value: 4 },
			cameraFar: { value: 4096 }
		},
		vertexShader: depthVertexShader,
		fragmentShader: depthFragmentShader
	} );

	// Custom normal material - outputs view-space normals
	normalMaterial = new THREE.ShaderMaterial( {
		vertexShader: normalVertexShader,
		fragmentShader: normalFragmentShader
	} );

	// GTAO material
	gtaoMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tDepth: { value: null },
			tNormal: { value: null },
			resolution: { value: new THREE.Vector2() },
			radius: { value: gtaoRadius },
			intensity: { value: gtaoIntensity },
			falloff: { value: gtaoFalloff },
			cameraNear: { value: 0.1 },
			cameraFar: { value: 1000 },
			cameraProjectionMatrix: { value: new THREE.Matrix4() },
			cameraInverseProjectionMatrix: { value: new THREE.Matrix4() },
			frameCount: { value: 0 }
		},
		vertexShader: gtaoVertexShader,
		fragmentShader: gtaoFragmentShader,
		depthTest: false,
		depthWrite: false
	} );

	// Blur material
	blurMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tAO: { value: null },
			tDepth: { value: null },
			resolution: { value: new THREE.Vector2() },
			direction: { value: new THREE.Vector2( 1, 0 ) }
		},
		vertexShader: gtaoVertexShader,
		fragmentShader: blurFragmentShader,
		depthTest: false,
		depthWrite: false
	} );

	// Composite material - uses multiply blending to darken scene with AO
	compositeMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tAO: { value: null },
			tDepth: { value: null },
			tNormal: { value: null },
			debugMode: { value: 0.0 } // 0=normal, 1=white, 2=AO, 3=depth, 4=normals
		},
		vertexShader: gtaoVertexShader,
		fragmentShader: compositeFragmentShader,
		depthTest: false,
		depthWrite: false,
		transparent: true,
		blending: THREE.MultiplyBlending,
		premultipliedAlpha: true
	} );

}

function createScreenQuad() {

	screenScene = new THREE.Scene();
	screenScene.background = null; // No background - don't clear
	screenCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

	const geometry = new THREE.PlaneGeometry( 2, 2 );
	screenQuad = new THREE.Mesh( geometry, gtaoMaterial );
	screenScene.add( screenQuad );

}

export function GTAO_Init() {

	if ( gtaoInitialized ) return;

	createRenderTargets();
	createMaterials();
	createScreenQuad();

	// Register for resize events
	VID_AddResizeCallback( GTAO_Resize );

	gtaoInitialized = true;

}

//============================================================================
// Resize handling
//============================================================================

export function GTAO_Resize( width, height ) {

	if ( ! gtaoInitialized ) return;

	depthRenderTarget.setSize( width, height );
	normalRenderTarget.setSize( width, height );
	aoRenderTarget.setSize( width, height );
	aoBlurRenderTarget.setSize( width, height );

}

//============================================================================
// Parameter setters (called from cvar changes)
//============================================================================

export function GTAO_SetEnabled( enabled ) {

	gtaoEnabled = enabled;
	if ( enabled && ! gtaoInitialized ) {

		GTAO_Init();

	}

}

export function GTAO_SetRadius( value ) {

	gtaoRadius = value;
	if ( gtaoMaterial ) {

		gtaoMaterial.uniforms.radius.value = value;

	}

}

export function GTAO_SetIntensity( value ) {

	gtaoIntensity = value;
	if ( gtaoMaterial ) {

		gtaoMaterial.uniforms.intensity.value = value;

	}

}

export function GTAO_SetFalloff( value ) {

	gtaoFalloff = value;
	if ( gtaoMaterial ) {

		gtaoMaterial.uniforms.falloff.value = value;

	}

}

export function GTAO_SetDebugMode( value ) {

	if ( compositeMaterial ) {

		compositeMaterial.uniforms.debugMode.value = value;

	}

}

//============================================================================
// Main render function
//============================================================================

let frameCount = 0;

export function GTAO_Apply() {

	if ( ! gtaoEnabled || ! gtaoInitialized ) return;
	if ( ! renderer || ! scene || ! camera ) return;

	frameCount ++;

	const width = vid.width;
	const height = vid.height;

	// Store current render target
	const currentRenderTarget = renderer.getRenderTarget();

	// 1. Render depth buffer
	depthMaterial.uniforms.cameraNear.value = camera.near;
	depthMaterial.uniforms.cameraFar.value = camera.far;

	renderer.setRenderTarget( depthRenderTarget );
	scene.overrideMaterial = depthMaterial;
	renderer.render( scene, camera );
	scene.overrideMaterial = null;

	// 2. Render normals
	renderer.setRenderTarget( normalRenderTarget );
	scene.overrideMaterial = normalMaterial;
	renderer.render( scene, camera );
	scene.overrideMaterial = null;

	// 3. Compute GTAO
	gtaoMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	gtaoMaterial.uniforms.tNormal.value = normalRenderTarget.texture;
	gtaoMaterial.uniforms.resolution.value.set( width, height );
	gtaoMaterial.uniforms.cameraNear.value = camera.near;
	gtaoMaterial.uniforms.cameraFar.value = camera.far;
	gtaoMaterial.uniforms.cameraProjectionMatrix.value.copy( camera.projectionMatrix );
	gtaoMaterial.uniforms.cameraInverseProjectionMatrix.value.copy( camera.projectionMatrixInverse );
	gtaoMaterial.uniforms.frameCount.value = frameCount % 64;

	screenQuad.material = gtaoMaterial;
	renderer.setRenderTarget( aoRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 4. Bilateral blur - horizontal pass
	blurMaterial.uniforms.tAO.value = aoRenderTarget.texture;
	blurMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	blurMaterial.uniforms.resolution.value.set( width, height );
	blurMaterial.uniforms.direction.value.set( 1, 0 );

	screenQuad.material = blurMaterial;
	renderer.setRenderTarget( aoBlurRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 5. Bilateral blur - vertical pass
	blurMaterial.uniforms.tAO.value = aoBlurRenderTarget.texture;
	blurMaterial.uniforms.direction.value.set( 0, 1 );

	renderer.setRenderTarget( aoRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 6. Composite AO onto the screen
	// Save and disable all autoClear flags so we don't wipe the existing scene
	const oldAutoClear = renderer.autoClear;
	const oldAutoClearColor = renderer.autoClearColor;
	const oldAutoClearDepth = renderer.autoClearDepth;
	const oldAutoClearStencil = renderer.autoClearStencil;

	renderer.autoClear = false;
	renderer.autoClearColor = false;
	renderer.autoClearDepth = false;
	renderer.autoClearStencil = false;

	compositeMaterial.uniforms.tAO.value = aoRenderTarget.texture;
	compositeMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	compositeMaterial.uniforms.tNormal.value = normalRenderTarget.texture;

	// In any debug mode, use normal blending to show buffers directly
	const debugMode = compositeMaterial.uniforms.debugMode.value;
	if ( debugMode > 0.5 ) {

		compositeMaterial.blending = THREE.NormalBlending;
		renderer.autoClear = true;
		renderer.autoClearColor = true;

	} else {

		compositeMaterial.blending = THREE.MultiplyBlending;

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

export function GTAO_Dispose() {

	if ( depthRenderTarget ) depthRenderTarget.dispose();
	if ( normalRenderTarget ) normalRenderTarget.dispose();
	if ( aoRenderTarget ) aoRenderTarget.dispose();
	if ( aoBlurRenderTarget ) aoBlurRenderTarget.dispose();

	if ( depthMaterial ) depthMaterial.dispose();
	if ( normalMaterial ) normalMaterial.dispose();
	if ( gtaoMaterial ) gtaoMaterial.dispose();
	if ( blurMaterial ) blurMaterial.dispose();
	if ( compositeMaterial ) compositeMaterial.dispose();

	gtaoInitialized = false;

}
