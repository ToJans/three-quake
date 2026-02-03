//============================================================================
// gl_postprocess.js - Three.js postprocessing system
//
// Uses Three.js EffectComposer with GTAOPass, SSRPass, and QuakeBloomPass.
//
// cg_hq bitmask:
//   bit 0 (1) = SSR (screen-space reflections)
//   bit 1 (2) = AO (ambient occlusion via GTAO)
//   bit 2 (4) = Bloom
//   bit 3 (8) = Tonemapping
//============================================================================

import * as THREE from 'three'; // Uses shimmed three.js via importmap

// Three.js postprocessing
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSRPass } from 'three/addons/postprocessing/SSRPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { QuakeBloomPass } from './gl_bloom_pass.js';

import { renderer, vid, VID_AddResizeCallback } from './vid.js';
import { scene, camera, cg_hq, cg_hq_ssr, cg_hq_ao, cg_hq_bloom, cg_hq_tonemapping } from './gl_rmain.js';
import {
	cg_hq_ao_radius, cg_hq_ao_intensity,
	cg_hq_bloom_threshold, cg_hq_bloom_intensity, cg_hq_bloom_radius,
	cg_hq_ssr_maxdistance, cg_hq_ssr_thickness, cg_hq_ssr_intensity,
	cg_hq_tonemapping_operator, cg_hq_tonemapping_exposure
} from './gl_rmain.js';

// Tone mapping operators (matching cg_hq_tonemapping_operator values)
const TONE_MAPPING_OPERATORS = [
	THREE.ACESFilmicToneMapping,  // 0 = ACES (default)
	THREE.ReinhardToneMapping,    // 1 = Reinhard
	THREE.CineonToneMapping,      // 2 = Cineon/Uncharted2-like
	THREE.AgXToneMapping,         // 3 = AgX
	THREE.NeutralToneMapping      // 4 = Neutral
];

//============================================================================
// State - Three.js mode
//============================================================================

let threeComposer = null;
let threeRenderPass = null;
let threeSsrPass = null;
let threeGtaoPass = null;
let threeBloomPass = null;
let threeOutputPass = null;
let threeInitialized = false;


//============================================================================
// Initialize Three.js postprocessing
//============================================================================

function initThreeJS() {

	if ( threeInitialized || ! renderer || ! scene || ! camera ) return;

	const width = vid.width || window.innerWidth;
	const height = vid.height || window.innerHeight;

	threeComposer = new EffectComposer( renderer );

	// Render pass
	threeRenderPass = new RenderPass( scene, camera );
	threeComposer.addPass( threeRenderPass );

	// GTAO pass
	threeGtaoPass = new GTAOPass( scene, camera, width, height );
	threeGtaoPass.output = GTAOPass.OUTPUT.Default;
	threeGtaoPass.enabled = false;
	threeComposer.addPass( threeGtaoPass );

	// SSR pass
	threeSsrPass = new SSRPass( {
		renderer, scene, camera, width, height,
		groundReflector: null,
		selects: null
	} );
	threeSsrPass.enabled = false;
	threeComposer.addPass( threeSsrPass );

	// Custom Quake bloom pass (values will be overridden by cvars in updateThreeParams)
	const resolution = new THREE.Vector2( width, height );
	threeBloomPass = new QuakeBloomPass( resolution );
	threeBloomPass.enabled = false;
	threeComposer.addPass( threeBloomPass );

	// Output pass (tonemapping)
	threeOutputPass = new OutputPass();
	threeComposer.addPass( threeOutputPass );

	threeInitialized = true;
	console.log( '[PostProcess] Three.js mode initialized' );

}


//============================================================================
// Resize handler
//============================================================================

function PostProcess_Resize( width, height ) {

	if ( threeComposer ) {

		threeComposer.setSize( width, height );
		if ( threeGtaoPass ) threeGtaoPass.setSize( width, height );
		if ( threeSsrPass ) threeSsrPass.setSize( width, height );
		if ( threeBloomPass ) threeBloomPass.setSize( width, height );

	}

}

//============================================================================
// Update effect parameters
//============================================================================

function updateThreeParams() {

	const hqValue = cg_hq.value | 0;
	const ssrEnabled = ( hqValue & 1 ) !== 0;
	const aoEnabled = ( hqValue & 2 ) !== 0;
	const bloomEnabled = ( hqValue & 4 ) !== 0;

	const ssrForce = cg_hq_ssr.value | 0;
	const aoForce = cg_hq_ao.value | 0;
	const bloomForce = cg_hq_bloom.value | 0;

	if ( threeSsrPass ) {

		threeSsrPass.enabled = ssrForce === 1 || ( ssrForce === 0 && ssrEnabled );
		threeSsrPass.maxDistance = ( cg_hq_ssr_maxdistance.value | 0 ) / 4000;
		threeSsrPass.thickness = ( cg_hq_ssr_thickness.value | 0 ) / 1000;
		threeSsrPass.opacity = parseFloat( cg_hq_ssr_intensity.value ) || 1.0;

	}

	if ( threeGtaoPass ) {

		threeGtaoPass.enabled = aoForce === 1 || ( aoForce === 0 && aoEnabled );
		threeGtaoPass.updateGtaoMaterial( {
			radius: parseFloat( cg_hq_ao_radius.value ) || 6,
			scale: parseFloat( cg_hq_ao_intensity.value ) || 0.3
		} );

	}

	if ( threeBloomPass ) {

		threeBloomPass.enabled = bloomForce === 1 || ( bloomForce === 0 && bloomEnabled );
		threeBloomPass.threshold = parseFloat( cg_hq_bloom_threshold.value ) || 0.5;
		threeBloomPass.intensity = parseFloat( cg_hq_bloom_intensity.value ) || 0.5;
		threeBloomPass.radius = parseFloat( cg_hq_bloom_radius.value ) || 1.0;

	}

	// Tonemapping - applied via renderer settings (OutputPass reads from renderer)
	const tonemappingEnabled = ( hqValue & 8 ) !== 0;
	const tonemappingForce = cg_hq_tonemapping.value | 0;
	const tonemappingOn = tonemappingForce === 1 || ( tonemappingForce === 0 && tonemappingEnabled );

	if ( renderer ) {

		if ( tonemappingOn ) {

			const operatorIndex = ( cg_hq_tonemapping_operator.value | 0 );
			renderer.toneMapping = TONE_MAPPING_OPERATORS[ operatorIndex ] || THREE.ACESFilmicToneMapping;
			renderer.toneMappingExposure = parseFloat( cg_hq_tonemapping_exposure.value ) || 1.0;

		} else {

			renderer.toneMapping = THREE.NoToneMapping;

		}

	}

}


//============================================================================
// Public init
//============================================================================

export function PostProcess_Init() {

	initThreeJS();
	VID_AddResizeCallback( PostProcess_Resize );

}

//============================================================================
// Render
//============================================================================

export function PostProcess_Render() {

	// Check what's enabled
	const hqValue = cg_hq.value | 0;
	const ssrEnabled = ( hqValue & 1 ) !== 0 || ( cg_hq_ssr.value | 0 ) === 1;
	const aoEnabled = ( hqValue & 2 ) !== 0 || ( cg_hq_ao.value | 0 ) === 1;
	const bloomEnabled = ( hqValue & 4 ) !== 0 || ( cg_hq_bloom.value | 0 ) === 1;

	if ( ! ssrEnabled && ! aoEnabled && ! bloomEnabled ) {

		return false;

	}

	// Use Three.js postprocessing
	if ( ! threeInitialized ) {

		initThreeJS();

	}

	if ( threeComposer ) {

		updateThreeParams();
		if ( threeRenderPass ) threeRenderPass.camera = camera;
		if ( threeSsrPass ) threeSsrPass.camera = camera;
		if ( threeGtaoPass ) threeGtaoPass.camera = camera;
		threeComposer.render();
		return true;

	}

	return false;

}

//============================================================================
// Cleanup
//============================================================================

export function PostProcess_Dispose() {

	if ( threeComposer ) threeComposer.dispose();
	threeComposer = null;
	threeInitialized = false;

}
