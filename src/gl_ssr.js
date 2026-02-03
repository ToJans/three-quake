// Screen Space Reflections (SSR) Post-Processing
// Ray marches in screen space to find reflections

import * as THREE from 'three';
import { renderer, vid, VID_AddResizeCallback } from './vid.js';
import { scene, camera } from './gl_rmain.js';

//============================================================================
// SSR State
//============================================================================

let ssrEnabled = false;
let ssrInitialized = false;

// Render targets
let depthRenderTarget = null;
let normalRenderTarget = null;
let colorRenderTarget = null;
let reflectivityRenderTarget = null;
let ssrRenderTarget = null;
let ssrBlurRenderTarget = null;

// Materials
let depthMaterial = null;
let normalMaterial = null;
let reflectivityMaterial = null;
let ssrMaterial = null;
let blurMaterial = null;
let compositeMaterial = null;

// Screen quad for post-processing
let screenQuad = null;
let screenScene = null;
let screenCamera = null;

// Parameters (controlled by cvars)
let ssrMaxSteps = 32;
let ssrMaxDistance = 100.0;
let ssrThickness = 0.5;
let ssrIntensity = 0.5;

//============================================================================
// SSR Shaders
//============================================================================

const fullscreenVertexShader = /* glsl */`
varying vec2 vUv;

void main() {
	vUv = uv;
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// Custom depth material - outputs linear depth
const depthVertexShader = /* glsl */`
varying float vViewZ;

void main() {
	vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
	vViewZ = -mvPosition.z;
	gl_Position = projectionMatrix * mvPosition;
}
`;

const depthFragmentShader = /* glsl */`
precision highp float;

varying float vViewZ;
uniform float cameraNear;
uniform float cameraFar;

void main() {
	float linearDepth = (vViewZ - cameraNear) / (cameraFar - cameraNear);
	linearDepth = clamp(linearDepth, 0.0, 1.0);
	gl_FragColor = vec4(linearDepth, linearDepth, linearDepth, 1.0);
}
`;

// Custom normal material - outputs view-space normals
const normalVertexShader = /* glsl */`
varying vec3 vViewNormal;

void main() {
	vViewNormal = normalize(normalMatrix * normal);
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const normalFragmentShader = /* glsl */`
precision highp float;

varying vec3 vViewNormal;

void main() {
	vec3 normal = normalize(vViewNormal);
	gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);
}
`;

// Reflectivity material - outputs surface reflectivity based on:
// - userData.reflectivity (for water/special surfaces)
// - World-space normal direction (floors are more reflective)
const reflectivityVertexShader = /* glsl */`
varying vec3 vWorldNormal;

void main() {
	// Transform normal to world space
	vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
	gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const reflectivityFragmentShader = /* glsl */`
precision highp float;

varying vec3 vWorldNormal;
uniform float baseReflectivity;    // Per-object base (for water)
uniform float floorReflectivity;   // Extra reflectivity for floors
uniform float globalBaseReflectivity; // Minimum for all surfaces (for glass/walls)

void main() {
	vec3 worldNormal = normalize(vWorldNormal);

	// Check if this is a floor (normal pointing up in world space)
	// In Quake coords: Z is up
	float upFacing = max(0.0, worldNormal.z);

	// Floors (upFacing > 0.7) get floor reflectivity
	// Steep angle threshold to avoid walls
	float floorFactor = smoothstep(0.7, 0.9, upFacing);

	// Combine: global base + floor bonus + per-object base (water)
	float reflectivity = globalBaseReflectivity + floorFactor * floorReflectivity;
	reflectivity = max(reflectivity, baseReflectivity);

	gl_FragColor = vec4(reflectivity, reflectivity, reflectivity, 1.0);
}
`;

// SSR ray marching shader
const ssrFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tDepth;
uniform sampler2D tNormal;
uniform sampler2D tColor;
uniform sampler2D tReflectivity;
uniform vec2 resolution;
uniform float cameraNear;
uniform float cameraFar;
uniform mat4 cameraProjectionMatrix;
uniform mat4 cameraInverseProjectionMatrix;
uniform int maxSteps;
uniform float maxDistance;
uniform float thickness;
uniform float intensity;

// Get linear depth from depth buffer
float getLinearDepth(vec2 uv) {
	return texture2D(tDepth, uv).r;
}

// Convert linear depth to view-space Z
float linearDepthToViewZ(float linearDepth) {
	return linearDepth * (cameraFar - cameraNear) + cameraNear;
}

// Reconstruct view-space position from UV and linear depth
vec3 getViewPosition(vec2 uv, float linearDepth) {
	float viewZ = linearDepthToViewZ(linearDepth);
	vec2 ndc = uv * 2.0 - 1.0;
	vec4 clipPos = vec4(ndc, 0.0, 1.0);
	vec4 viewRay = cameraInverseProjectionMatrix * clipPos;
	viewRay.xyz /= viewRay.w;
	vec3 viewPos = viewRay.xyz * (viewZ / -viewRay.z);
	return viewPos;
}

// Project view-space position to screen UV
vec2 viewToScreen(vec3 viewPos) {
	vec4 clipPos = cameraProjectionMatrix * vec4(viewPos, 1.0);
	clipPos.xyz /= clipPos.w;
	return clipPos.xy * 0.5 + 0.5;
}

// Fresnel approximation - more reflection at grazing angles
// Returns value from baseReflectivity to 1.0
float fresnel(vec3 viewDir, vec3 normal, float baseReflectivity) {
	float cosTheta = max(dot(-viewDir, normal), 0.0);
	// Schlick's approximation - use surface reflectivity as F0
	return baseReflectivity + (1.0 - baseReflectivity) * pow(1.0 - cosTheta, 5.0);
}

void main() {
	float centerDepth = getLinearDepth(vUv);

	// Skip sky/far plane
	if (centerDepth > 0.99) {
		gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
		return;
	}

	// Get surface reflectivity from mask
	float surfaceReflectivity = texture2D(tReflectivity, vUv).r;

	// Skip non-reflective surfaces early
	if (surfaceReflectivity < 0.01) {
		gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
		return;
	}

	// Get view-space position and normal
	vec3 viewPos = getViewPosition(vUv, centerDepth);
	vec3 normal = texture2D(tNormal, vUv).rgb * 2.0 - 1.0;
	normal = normalize(normal);

	// View direction (from surface to camera)
	vec3 viewDir = normalize(viewPos);

	// Reflect view direction around normal
	vec3 reflectDir = reflect(viewDir, normal);

	// Calculate reflection strength using Fresnel
	// Surface reflectivity is the base, Fresnel boosts at grazing angles
	float reflectionStrength = fresnel(viewDir, normal, surfaceReflectivity);

	// Skip if reflection direction points away from camera
	if (reflectDir.z > 0.0) {
		gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
		return;
	}

	// Ray march in view space
	vec3 rayOrigin = viewPos;
	vec3 rayDir = reflectDir;

	// Calculate step size based on distance
	float stepSize = maxDistance / float(maxSteps);

	vec2 hitUV = vec2(0.0);
	float hitStrength = 0.0;

	for (int i = 1; i <= 64; i++) {
		if (i > maxSteps) break;

		// Step along ray
		vec3 rayPos = rayOrigin + rayDir * stepSize * float(i);

		// Project to screen
		vec2 rayUV = viewToScreen(rayPos);

		// Check if ray went off screen
		if (rayUV.x < 0.0 || rayUV.x > 1.0 || rayUV.y < 0.0 || rayUV.y > 1.0) {
			break;
		}

		// Get depth at ray position
		float rayDepth = getLinearDepth(rayUV);
		float rayViewZ = linearDepthToViewZ(rayDepth);

		// Check for intersection
		float depthDiff = -rayPos.z - rayViewZ;

		if (depthDiff > 0.0 && depthDiff < thickness) {
			// Hit!
			// Edge fade only - don't fade by distance (looks better)
			vec2 edgeFade = smoothstep(0.0, 0.1, rayUV) * smoothstep(1.0, 0.9, rayUV);
			float screenFade = edgeFade.x * edgeFade.y;

			hitUV = rayUV;
			// Reflectivity controls strength, screen edge fades artifacts
			hitStrength = reflectionStrength * screenFade;
			break;
		}
	}

	// Sample reflected color
	vec3 reflectedColor = vec3(0.0);
	if (hitStrength > 0.0) {
		reflectedColor = texture2D(tColor, hitUV).rgb;
	}

	gl_FragColor = vec4(reflectedColor, hitStrength * intensity);
}
`;

// Blur for SSR (reduce moiré and noise)
const blurFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tSSR;
uniform sampler2D tDepth;
uniform vec2 resolution;
uniform vec2 direction;

void main() {
	vec2 texelSize = 1.0 / resolution;

	float centerDepth = texture2D(tDepth, vUv).r;
	vec4 centerSSR = texture2D(tSSR, vUv);

	vec4 totalSSR = centerSSR;
	float totalWeight = 1.0;

	// Wider bilateral blur to reduce moiré (7 pixel radius)
	for (int i = 1; i <= 7; i++) {
		vec2 offset = direction * float(i) * texelSize * 1.5; // 1.5x spacing for wider blur

		for (int sign = -1; sign <= 1; sign += 2) {
			vec2 sampleUV = vUv + offset * float(sign);

			if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
				continue;
			}

			float sampleDepth = texture2D(tDepth, sampleUV).r;
			vec4 sampleSSR = texture2D(tSSR, sampleUV);

			float depthDiff = abs(centerDepth - sampleDepth);
			float depthWeight = exp(-depthDiff * 100.0); // Stricter depth test
			float spatialWeight = exp(-float(i * i) / 18.0); // Wider gaussian
			float weight = depthWeight * spatialWeight;

			totalSSR += sampleSSR * weight;
			totalWeight += weight;
		}
	}

	gl_FragColor = totalSSR / totalWeight;
}
`;

// Composite shader - blends SSR onto scene
const compositeFragmentShader = /* glsl */`
precision highp float;

varying vec2 vUv;

uniform sampler2D tSSR;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tReflectivity;
uniform float debugMode;

void main() {
	vec4 ssr = texture2D(tSSR, vUv);
	vec3 sceneColor = texture2D(tColor, vUv).rgb;
	float depth = texture2D(tDepth, vUv).r;
	float reflectivity = texture2D(tReflectivity, vUv).r;

	// Debug modes:
	// 0 = normal composite
	// 1 = show SSR only
	// 2 = show reflection mask (alpha)
	// 3 = show depth
	// 4 = show scene color buffer
	// 5 = show reflectivity mask

	if (debugMode > 4.5) {
		gl_FragColor = vec4(reflectivity, reflectivity, reflectivity, 1.0);
		return;
	}

	if (debugMode > 3.5) {
		gl_FragColor = vec4(sceneColor, 1.0);
		return;
	}

	if (debugMode > 2.5) {
		gl_FragColor = vec4(depth, depth, depth, 1.0);
		return;
	}

	if (debugMode > 1.5) {
		gl_FragColor = vec4(ssr.aaa, 1.0);
		return;
	}

	if (debugMode > 0.5) {
		gl_FragColor = vec4(ssr.rgb, 1.0);
		return;
	}

	// Blend reflection with scene using SSR alpha as mask
	vec3 finalColor = mix(sceneColor, ssr.rgb, ssr.a);
	gl_FragColor = vec4(finalColor, 1.0);
}
`;

//============================================================================
// Initialization
//============================================================================

// SSR parameters for reflectivity
let ssrFloorReflectivity = 0.5; // How reflective floors are (0-1)
let ssrWaterReflectivity = 0.8; // How reflective water is (0-1)
let ssrBaseReflectivity = 0.1; // Base reflectivity for all surfaces (0-1)

function createRenderTargets() {

	const width = vid.width;
	const height = vid.height;

	depthRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.FloatType
	} );

	normalRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat
	} );

	colorRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.HalfFloatType
	} );

	reflectivityRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat
	} );

	ssrRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.HalfFloatType
	} );

	ssrBlurRenderTarget = new THREE.WebGLRenderTarget( width, height, {
		minFilter: THREE.LinearFilter,
		magFilter: THREE.LinearFilter,
		format: THREE.RGBAFormat,
		type: THREE.HalfFloatType
	} );

}

function createMaterials() {

	depthMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			cameraNear: { value: 4 },
			cameraFar: { value: 4096 }
		},
		vertexShader: depthVertexShader,
		fragmentShader: depthFragmentShader,
		side: THREE.DoubleSide // Water/lava use DoubleSide
	} );

	normalMaterial = new THREE.ShaderMaterial( {
		vertexShader: normalVertexShader,
		fragmentShader: normalFragmentShader,
		side: THREE.DoubleSide
	} );

	reflectivityMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			baseReflectivity: { value: 0.0 },
			floorReflectivity: { value: ssrFloorReflectivity },
			globalBaseReflectivity: { value: ssrBaseReflectivity }
		},
		vertexShader: reflectivityVertexShader,
		fragmentShader: reflectivityFragmentShader,
		side: THREE.DoubleSide
	} );

	ssrMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tDepth: { value: null },
			tNormal: { value: null },
			tColor: { value: null },
			tReflectivity: { value: null },
			resolution: { value: new THREE.Vector2() },
			cameraNear: { value: 4 },
			cameraFar: { value: 4096 },
			cameraProjectionMatrix: { value: new THREE.Matrix4() },
			cameraInverseProjectionMatrix: { value: new THREE.Matrix4() },
			maxSteps: { value: ssrMaxSteps },
			maxDistance: { value: ssrMaxDistance },
			thickness: { value: ssrThickness },
			intensity: { value: ssrIntensity }
		},
		vertexShader: fullscreenVertexShader,
		fragmentShader: ssrFragmentShader,
		depthTest: false,
		depthWrite: false
	} );

	blurMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tSSR: { value: null },
			tDepth: { value: null },
			resolution: { value: new THREE.Vector2() },
			direction: { value: new THREE.Vector2( 1, 0 ) }
		},
		vertexShader: fullscreenVertexShader,
		fragmentShader: blurFragmentShader,
		depthTest: false,
		depthWrite: false
	} );

	compositeMaterial = new THREE.ShaderMaterial( {
		uniforms: {
			tSSR: { value: null },
			tColor: { value: null },
			tDepth: { value: null },
			tReflectivity: { value: null },
			debugMode: { value: 0.0 }
		},
		vertexShader: fullscreenVertexShader,
		fragmentShader: compositeFragmentShader,
		depthTest: false,
		depthWrite: false,
		blending: THREE.NoBlending
	} );

}

function createScreenQuad() {

	screenScene = new THREE.Scene();
	screenScene.background = null;
	screenCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );

	const geometry = new THREE.PlaneGeometry( 2, 2 );
	screenQuad = new THREE.Mesh( geometry, ssrMaterial );
	screenScene.add( screenQuad );

}

export function SSR_Init() {

	if ( ssrInitialized ) return;

	createRenderTargets();
	createMaterials();
	createScreenQuad();

	VID_AddResizeCallback( SSR_Resize );

	ssrInitialized = true;

}

//============================================================================
// Resize handling
//============================================================================

export function SSR_Resize( width, height ) {

	if ( ! ssrInitialized ) return;

	depthRenderTarget.setSize( width, height );
	normalRenderTarget.setSize( width, height );
	colorRenderTarget.setSize( width, height );
	reflectivityRenderTarget.setSize( width, height );
	ssrRenderTarget.setSize( width, height );
	ssrBlurRenderTarget.setSize( width, height );

}

//============================================================================
// Parameter setters (called from cvar changes)
//============================================================================

export function SSR_SetEnabled( enabled ) {

	ssrEnabled = enabled;
	if ( enabled && ! ssrInitialized ) {

		SSR_Init();

	}

}

export function SSR_SetMaxSteps( value ) {

	ssrMaxSteps = Math.floor( value );
	if ( ssrMaterial ) {

		ssrMaterial.uniforms.maxSteps.value = ssrMaxSteps;

	}

}

export function SSR_SetMaxDistance( value ) {

	ssrMaxDistance = value;
	if ( ssrMaterial ) {

		ssrMaterial.uniforms.maxDistance.value = value;

	}

}

export function SSR_SetThickness( value ) {

	ssrThickness = value;
	if ( ssrMaterial ) {

		ssrMaterial.uniforms.thickness.value = value;

	}

}

export function SSR_SetIntensity( value ) {

	ssrIntensity = value;
	if ( ssrMaterial ) {

		ssrMaterial.uniforms.intensity.value = value;

	}

}

export function SSR_SetDebugMode( value ) {

	if ( compositeMaterial ) {

		compositeMaterial.uniforms.debugMode.value = value;

	}

}

export function SSR_SetFloorReflectivity( value ) {

	ssrFloorReflectivity = value;
	if ( reflectivityMaterial ) {

		reflectivityMaterial.uniforms.floorReflectivity.value = value;

	}

}

export function SSR_SetWaterReflectivity( value ) {

	ssrWaterReflectivity = value;

}

export function SSR_SetBaseReflectivity( value ) {

	ssrBaseReflectivity = value;

}

//============================================================================
// Main render function
//============================================================================

// Output target for HDR pipeline integration
let ssrOutputTarget = null;

function ensureOutputTarget() {

	const width = vid.width;
	const height = vid.height;

	if ( ! ssrOutputTarget ) {

		ssrOutputTarget = new THREE.WebGLRenderTarget( width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType
		} );

	} else if ( ssrOutputTarget.width !== width || ssrOutputTarget.height !== height ) {

		ssrOutputTarget.setSize( width, height );

	}

	return ssrOutputTarget;

}

// Internal function to compute SSR (shared between Apply and ApplyToTarget)
function computeSSR() {

	const width = vid.width;
	const height = vid.height;

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

	// 3. Render reflectivity mask
	// Uses world-space normals to determine floor reflectivity
	// Water meshes get high base reflectivity via userData
	// All surfaces get global base reflectivity (for glass, etc.)
	reflectivityMaterial.uniforms.floorReflectivity.value = ssrFloorReflectivity;
	reflectivityMaterial.uniforms.baseReflectivity.value = 0.0;
	reflectivityMaterial.uniforms.globalBaseReflectivity.value = ssrBaseReflectivity;

	renderer.setRenderTarget( reflectivityRenderTarget );
	renderer.setClearColor( 0x000000, 1 );
	renderer.clear( true, true, false );

	// First pass: render all surfaces with normal-based reflectivity
	scene.overrideMaterial = reflectivityMaterial;
	renderer.render( scene, camera );
	scene.overrideMaterial = null;

	// Second pass: render water/reflective surfaces with high base reflectivity
	// These have userData.reflectivity > 0 set in gl_rsurf.js
	reflectivityMaterial.uniforms.baseReflectivity.value = ssrWaterReflectivity;
	reflectivityMaterial.uniforms.floorReflectivity.value = ssrWaterReflectivity; // Water is always reflective

	const waterMeshes = [];
	scene.traverse( function ( object ) {

		if ( object.isMesh && object.visible && object.userData.reflectivity > 0 ) {

			waterMeshes.push( { mesh: object, originalMaterial: object.material } );
			object.material = reflectivityMaterial;

		}

	} );

	if ( waterMeshes.length > 0 ) {

		renderer.render( scene, camera );

		// Restore original materials
		for ( const item of waterMeshes ) {

			item.mesh.material = item.originalMaterial;

		}

	}

	// 4. Render scene color to HDR buffer
	// Need to explicitly clear and render with proper settings
	renderer.setRenderTarget( colorRenderTarget );
	renderer.setClearColor( 0x000000, 1 );
	renderer.clear( true, true, false );
	renderer.render( scene, camera );

	// 5. Compute SSR
	ssrMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	ssrMaterial.uniforms.tNormal.value = normalRenderTarget.texture;
	ssrMaterial.uniforms.tColor.value = colorRenderTarget.texture;
	ssrMaterial.uniforms.tReflectivity.value = reflectivityRenderTarget.texture;
	ssrMaterial.uniforms.resolution.value.set( width, height );
	ssrMaterial.uniforms.cameraNear.value = camera.near;
	ssrMaterial.uniforms.cameraFar.value = camera.far;
	ssrMaterial.uniforms.cameraProjectionMatrix.value.copy( camera.projectionMatrix );
	ssrMaterial.uniforms.cameraInverseProjectionMatrix.value.copy( camera.projectionMatrixInverse );

	screenQuad.material = ssrMaterial;
	renderer.setRenderTarget( ssrRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 5. Blur SSR - first pass horizontal
	blurMaterial.uniforms.tSSR.value = ssrRenderTarget.texture;
	blurMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	blurMaterial.uniforms.resolution.value.set( width, height );
	blurMaterial.uniforms.direction.value.set( 1, 0 );

	screenQuad.material = blurMaterial;
	renderer.setRenderTarget( ssrBlurRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 6. Blur SSR - first pass vertical
	blurMaterial.uniforms.tSSR.value = ssrBlurRenderTarget.texture;
	blurMaterial.uniforms.direction.value.set( 0, 1 );

	renderer.setRenderTarget( ssrRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 7. Blur SSR - second pass horizontal (reduce moiré further)
	blurMaterial.uniforms.tSSR.value = ssrRenderTarget.texture;
	blurMaterial.uniforms.direction.value.set( 1, 0 );

	renderer.setRenderTarget( ssrBlurRenderTarget );
	renderer.render( screenScene, screenCamera );

	// 8. Blur SSR - second pass vertical
	blurMaterial.uniforms.tSSR.value = ssrBlurRenderTarget.texture;
	blurMaterial.uniforms.direction.value.set( 0, 1 );

	renderer.setRenderTarget( ssrRenderTarget );
	renderer.render( screenScene, screenCamera );

}

export function SSR_Apply() {

	if ( ! ssrEnabled || ! ssrInitialized ) return;
	if ( ! renderer || ! scene || ! camera ) return;

	const currentRenderTarget = renderer.getRenderTarget();

	computeSSR();

	// 7. Composite SSR onto screen
	compositeMaterial.uniforms.tSSR.value = ssrRenderTarget.texture;
	compositeMaterial.uniforms.tColor.value = colorRenderTarget.texture;
	compositeMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	compositeMaterial.uniforms.tReflectivity.value = reflectivityRenderTarget.texture;

	screenQuad.material = compositeMaterial;
	renderer.setRenderTarget( currentRenderTarget );
	renderer.render( screenScene, screenCamera );

}

// Apply SSR and output to HDR target (for bloom/tonemapping pipeline)
export function SSR_ApplyToTarget() {

	if ( ! ssrEnabled || ! ssrInitialized ) return null;
	if ( ! renderer || ! scene || ! camera ) return null;

	const outputTarget = ensureOutputTarget();

	computeSSR();

	// Composite SSR to HDR output target
	compositeMaterial.uniforms.tSSR.value = ssrRenderTarget.texture;
	compositeMaterial.uniforms.tColor.value = colorRenderTarget.texture;
	compositeMaterial.uniforms.tDepth.value = depthRenderTarget.texture;
	compositeMaterial.uniforms.tReflectivity.value = reflectivityRenderTarget.texture;

	screenQuad.material = compositeMaterial;
	renderer.setRenderTarget( outputTarget );
	renderer.render( screenScene, screenCamera );

	return outputTarget;

}

// Get the scene color target (for other effects to use as input)
export function SSR_GetColorTarget() {

	return colorRenderTarget;

}

//============================================================================
// Cleanup
//============================================================================

export function SSR_Dispose() {

	if ( depthRenderTarget ) depthRenderTarget.dispose();
	if ( normalRenderTarget ) normalRenderTarget.dispose();
	if ( colorRenderTarget ) colorRenderTarget.dispose();
	if ( reflectivityRenderTarget ) reflectivityRenderTarget.dispose();
	if ( ssrRenderTarget ) ssrRenderTarget.dispose();
	if ( ssrBlurRenderTarget ) ssrBlurRenderTarget.dispose();
	if ( ssrOutputTarget ) ssrOutputTarget.dispose();

	if ( depthMaterial ) depthMaterial.dispose();
	if ( normalMaterial ) normalMaterial.dispose();
	if ( reflectivityMaterial ) reflectivityMaterial.dispose();
	if ( ssrMaterial ) ssrMaterial.dispose();
	if ( blurMaterial ) blurMaterial.dispose();
	if ( compositeMaterial ) compositeMaterial.dispose();

	ssrInitialized = false;

}
