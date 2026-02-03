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

// Depth shader - renders linear depth
const depthFragmentShader = /* glsl */`
varying vec2 vUv;
uniform float cameraNear;
uniform float cameraFar;

void main() {
	float depth = gl_FragCoord.z;
	// Convert to linear depth
	float linearDepth = (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - depth * (cameraFar - cameraNear));
	// Normalize to 0-1 range
	linearDepth = (linearDepth - cameraNear) / (cameraFar - cameraNear);
	gl_FragColor = vec4(linearDepth, linearDepth, linearDepth, 1.0);
}
`;

// Normal shader - renders view-space normals
const normalFragmentShader = /* glsl */`
varying vec3 vNormal;

void main() {
	vec3 normal = normalize(vNormal);
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
uniform mat4 projectionMatrix;
uniform mat4 inverseProjectionMatrix;
uniform float frameCount;

#define PI 3.14159265359
#define SAMPLES 8

// Reconstruct view-space position from depth
vec3 getViewPosition(vec2 uv, float depth) {
	// Convert UV to clip space
	vec4 clipPos = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
	// Transform to view space
	vec4 viewPos = inverseProjectionMatrix * clipPos;
	return viewPos.xyz / viewPos.w;
}

// Get linear depth from depth buffer
float getLinearDepth(vec2 uv) {
	float depth = texture2D(tDepth, uv).r;
	return depth;
}

// Hash function for random sampling
float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Interleaved gradient noise for temporal stability
float interleavedGradientNoise(vec2 position) {
	vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
	return fract(magic.z * fract(dot(position, magic.xy)));
}

void main() {
	vec2 texelSize = 1.0 / resolution;

	// Sample depth and reconstruct position
	float centerDepth = getLinearDepth(vUv);

	// Skip sky/far plane
	if (centerDepth > 0.999) {
		gl_FragColor = vec4(1.0);
		return;
	}

	// Get view-space position
	vec3 centerPos = getViewPosition(vUv, centerDepth);

	// Get normal from G-buffer
	vec3 normal = texture2D(tNormal, vUv).rgb * 2.0 - 1.0;
	normal = normalize(normal);

	// Calculate AO radius in screen space based on depth
	float radiusPixels = (radius / max(-centerPos.z, 0.1)) * resolution.y * 0.5;
	radiusPixels = clamp(radiusPixels, 3.0, 128.0);

	// Random rotation angle per pixel (temporal noise)
	float noise = interleavedGradientNoise(gl_FragCoord.xy + frameCount * 5.0);
	float rotationAngle = noise * PI * 2.0;

	// GTAO horizon-based sampling
	float occlusion = 0.0;

	// Slice-based approach: sample in multiple directions
	const int NUM_DIRECTIONS = 4;
	const int STEPS_PER_DIR = 4;

	for (int dir = 0; dir < NUM_DIRECTIONS; dir++) {
		float angle = (float(dir) + noise) * PI / float(NUM_DIRECTIONS);
		vec2 direction = vec2(cos(angle), sin(angle));

		// Track horizon angles for this direction
		float horizonCos = -1.0;

		for (int step = 1; step <= STEPS_PER_DIR; step++) {
			float stepRadius = (float(step) / float(STEPS_PER_DIR)) * radiusPixels;
			vec2 sampleOffset = direction * stepRadius * texelSize;
			vec2 sampleUV = vUv + sampleOffset;

			// Skip out-of-bounds samples
			if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
				continue;
			}

			float sampleDepth = getLinearDepth(sampleUV);
			vec3 samplePos = getViewPosition(sampleUV, sampleDepth);

			// Vector from center to sample
			vec3 horizonVec = samplePos - centerPos;
			float horizonDist = length(horizonVec);

			// Skip distant samples
			if (horizonDist > radius * 2.0) continue;

			horizonVec = normalize(horizonVec);

			// Compute horizon angle
			float horizonAngle = dot(horizonVec, normal);

			// Distance falloff
			float distFalloff = 1.0 - smoothstep(0.0, radius, horizonDist * falloff);

			// Update horizon
			horizonCos = max(horizonCos, horizonAngle * distFalloff);
		}

		// Same for opposite direction
		for (int step = 1; step <= STEPS_PER_DIR; step++) {
			float stepRadius = (float(step) / float(STEPS_PER_DIR)) * radiusPixels;
			vec2 sampleOffset = -direction * stepRadius * texelSize;
			vec2 sampleUV = vUv + sampleOffset;

			if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
				continue;
			}

			float sampleDepth = getLinearDepth(sampleUV);
			vec3 samplePos = getViewPosition(sampleUV, sampleDepth);

			vec3 horizonVec = samplePos - centerPos;
			float horizonDist = length(horizonVec);

			if (horizonDist > radius * 2.0) continue;

			horizonVec = normalize(horizonVec);
			float horizonAngle = dot(horizonVec, normal);
			float distFalloff = 1.0 - smoothstep(0.0, radius, horizonDist * falloff);

			horizonCos = max(horizonCos, horizonAngle * distFalloff);
		}

		// Integrate AO for this direction
		// Higher horizon = more occlusion
		occlusion += max(0.0, horizonCos);
	}

	// Normalize and invert
	occlusion = 1.0 - (occlusion / float(NUM_DIRECTIONS));

	// Apply intensity
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

void main() {
	float ao = texture2D(tAO, vUv).r;

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

	// Depth render target
	depthRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		format: THREE.RGBAFormat,
		type: THREE.FloatType
	} );

	// Normal render target
	normalRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.NearestFilter,
		magFilter: THREE.NearestFilter,
		format: THREE.RGBAFormat
	} );

	// AO render target (can be half resolution for performance)
	const aoWidth = Math.floor( width * 0.5 );
	const aoHeight = Math.floor( height * 0.5 );

	aoRenderTarget = new THREE.WebGLRenderTarget( aoWidth, aoHeight, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat
	} );

	aoBlurRenderTarget = new THREE.WebGLRenderTarget( aoWidth, aoHeight, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat
	} );

}

function createMaterials() {

	// Depth material - override for all objects
	depthMaterial = new THREE.MeshDepthMaterial( {
		depthPacking: THREE.BasicDepthPacking
	} );

	// Normal material - override for all objects
	normalMaterial = new THREE.MeshNormalMaterial();

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
			projectionMatrix: { value: new THREE.Matrix4() },
			inverseProjectionMatrix: { value: new THREE.Matrix4() },
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
			tAO: { value: null }
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

	const aoWidth = Math.floor( width * 0.5 );
	const aoHeight = Math.floor( height * 0.5 );
	aoRenderTarget.setSize( aoWidth, aoHeight );
	aoBlurRenderTarget.setSize( aoWidth, aoHeight );

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
	const aoWidth = Math.floor( width * 0.5 );
	const aoHeight = Math.floor( height * 0.5 );

	gtaoMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	gtaoMaterial.uniforms.tNormal.value = normalRenderTarget.texture;
	gtaoMaterial.uniforms.resolution.value.set( aoWidth, aoHeight );
	gtaoMaterial.uniforms.cameraNear.value = camera.near;
	gtaoMaterial.uniforms.cameraFar.value = camera.far;
	gtaoMaterial.uniforms.projectionMatrix.value.copy( camera.projectionMatrix );
	gtaoMaterial.uniforms.inverseProjectionMatrix.value.copy( camera.projectionMatrixInverse );
	gtaoMaterial.uniforms.frameCount.value = frameCount % 64;

	screenQuad.material = gtaoMaterial;
	renderer.setRenderTarget( aoRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 4. Bilateral blur - horizontal pass
	blurMaterial.uniforms.tAO.value = aoRenderTarget.texture;
	blurMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	blurMaterial.uniforms.resolution.value.set( aoWidth, aoHeight );
	blurMaterial.uniforms.direction.value.set( 1, 0 );

	screenQuad.material = blurMaterial;
	renderer.setRenderTarget( aoBlurRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 5. Bilateral blur - vertical pass
	blurMaterial.uniforms.tAO.value = aoBlurRenderTarget.texture;
	blurMaterial.uniforms.direction.value.set( 0, 1 );

	renderer.setRenderTarget( aoRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 6. Composite AO onto the screen using multiply blending
	compositeMaterial.uniforms.tAO.value = aoRenderTarget.texture;

	screenQuad.material = compositeMaterial;
	renderer.setRenderTarget( currentRenderTarget );
	renderer.render( screenScene, screenCamera );

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
