//============================================================================
// gl_postprocess.js - Three.js postprocessing system
//
// Uses Three.js EffectComposer with GTAOPass and QuakeBloomPass.
// SSR uses custom screen-space ray marching (gl_ssr.js).
//
// cg_hq bitmask:
//   bit 0 (1) = SSR (screen-space reflections) - handled by gl_ssr.js
//   bit 1 (2) = AO (ambient occlusion via GTAO)
//   bit 2 (4) = Bloom
//   bit 3 (8) = Tonemapping
//============================================================================

import * as THREE from 'three'; // Uses shimmed three.js via importmap

// Three.js postprocessing
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { QuakeBloomPass } from './gl_bloom_pass.js';

import { renderer, vid, VID_AddResizeCallback } from './vid.js';
import { scene, camera, cg_hq, cg_hq_ao, cg_hq_bloom, cg_hq_tonemapping } from './gl_rmain.js';
import {
	cg_hq_ao_radius, cg_hq_ao_intensity, cg_hq_ao_debug,
	cg_hq_bloom_threshold, cg_hq_bloom_intensity, cg_hq_bloom_radius,
	cg_hq_tonemapping_operator, cg_hq_tonemapping_exposure
} from './gl_rmain.js';

// SSR is currently disabled due to compatibility issues with Quake camera setup
// The Three.js SSRPass requires a standard camera, and the custom SSR has issues too

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
let threeGtaoPass = null;
let threeBloomPass = null;
let threeOutputPass = null;
let threeInitialized = false;

// Track last cvar values to detect changes requiring reinit
let lastCvarState = null;

//============================================================================
// Cvar state tracking
//============================================================================

function getCvarState() {

	const hq = cg_hq.value | 0;

	return {
		hq,
		// AO
		ao: cg_hq_ao.value | 0,
		aoRadius: parseFloat( cg_hq_ao_radius.value ) || 32,
		aoIntensity: parseFloat( cg_hq_ao_intensity.value ) || 1.0,
		aoDebug: cg_hq_ao_debug.value | 0,
		// Bloom
		bloom: cg_hq_bloom.value | 0,
		bloomThreshold: parseFloat( cg_hq_bloom_threshold.value ) || 0.5,
		bloomIntensity: parseFloat( cg_hq_bloom_intensity.value ) || 0.5,
		bloomRadius: parseFloat( cg_hq_bloom_radius.value ) || 1.0,
		// Tonemapping
		tonemapping: cg_hq_tonemapping.value | 0,
		tonemappingOperator: cg_hq_tonemapping_operator.value | 0,
		tonemappingExposure: parseFloat( cg_hq_tonemapping_exposure.value ) || 1.0,
		// Computed enabled states (used for structural decisions)
		// Note: SSR is disabled due to camera compatibility issues
		aoEnabled: ( hq & 2 ) !== 0 || ( cg_hq_ao.value | 0 ) === 1,
		bloomEnabled: ( hq & 4 ) !== 0 || ( cg_hq_bloom.value | 0 ) === 1,
		tonemappingEnabled: ( hq & 8 ) !== 0 || ( cg_hq_tonemapping.value | 0 ) === 1
	};

}

/**
 * Check if structural changes require reinit (pass chain changes).
 * Parameter-only changes can be applied without reinit.
 */
function needsReinit( newState ) {

	if ( ! lastCvarState ) return true;

	// Structural changes that require rebuilding the pass chain:
	// - aoDebug mode change (different pass chain for debug vs normal)
	// - Any effect being enabled/disabled (except SSR which is handled separately)
	const structuralKeys = [
		'aoDebug', 'aoEnabled', 'bloomEnabled', 'tonemappingEnabled'
	];

	for ( const key of structuralKeys ) {

		if ( newState[ key ] !== lastCvarState[ key ] ) {

			console.log( '[PostProcess] structural change:', key, lastCvarState[ key ], '->', newState[ key ] );
			return true;

		}

	}

	return false;

}

/**
 * Apply parameter changes without reinit.
 */
function applyParameterChanges( state ) {

	// AO parameters
	if ( threeGtaoPass ) {

		threeGtaoPass.updateGtaoMaterial( {
			radius: state.aoRadius,
			scale: state.aoIntensity,
			thickness: 10.0,
			distanceExponent: 2.0,
			distanceFallOff: 1.0,
			screenSpaceRadius: false
		} );

	}

	// Bloom parameters
	if ( threeBloomPass ) {

		threeBloomPass.threshold = state.bloomThreshold;
		threeBloomPass.intensity = state.bloomIntensity;
		threeBloomPass.radius = state.bloomRadius;

	}

	// Tonemapping parameters
	if ( state.tonemappingEnabled ) {

		renderer.toneMapping = TONE_MAPPING_OPERATORS[ state.tonemappingOperator ] || THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = state.tonemappingExposure;

	}

	lastCvarState = { ...state };

}

//============================================================================
// Initialize Three.js postprocessing
//============================================================================

function initThreeJS( state ) {

	if ( ! renderer || ! scene || ! camera ) return;

	// Dispose existing composer if reinitializing
	if ( threeComposer ) {

		threeComposer.dispose();
		threeComposer = null;

	}

	// Clear pass references
	threeRenderPass = null;
	threeGtaoPass = null;
	threeBloomPass = null;
	threeOutputPass = null;

	const width = vid.width || window.innerWidth;
	const height = vid.height || window.innerHeight;

	threeComposer = new EffectComposer( renderer );

	// AO debug mode: 2=Depth, 3=Normal, 4=AO (raw debug visualizations)
	// When in debug mode, we want GTAO to render directly to screen
	const aoDebugMode = state.aoDebug >= 2 && state.aoDebug <= 4;

	// Render pass - always first
	threeRenderPass = new RenderPass( scene, camera );
	threeComposer.addPass( threeRenderPass );

	if ( aoDebugMode ) {

		// DEBUG MODE: Only GTAOPass, renders directly to screen
		// No other passes - debug output goes straight to screen
		threeGtaoPass = new GTAOPass( scene, camera, width, height );
		threeGtaoPass.output = state.aoDebug; // 2=Depth, 3=Normal, 4=AO
		threeGtaoPass.enabled = true;
		threeGtaoPass.renderToScreen = true; // Render directly to screen
		threeGtaoPass.updateGtaoMaterial( {
			radius: state.aoRadius,
			scale: state.aoIntensity,
			thickness: 10.0,
			distanceExponent: 2.0,
			distanceFallOff: 1.0,
			screenSpaceRadius: false
		} );
		threeComposer.addPass( threeGtaoPass );
		console.log( '[PostProcess] DEBUG MODE: GTAO output=', state.aoDebug, '(2=Depth, 3=Normal, 4=AO)' );

	} else {

		// NORMAL MODE: Full pass chain with all enabled effects

		// GTAO pass - blends AO with scene
		if ( state.aoEnabled ) {

			threeGtaoPass = new GTAOPass( scene, camera, width, height );
			// Use Default output for blended AO (0 = scene * AO)
			threeGtaoPass.output = GTAOPass.OUTPUT.Default;
			threeGtaoPass.enabled = true;
			threeGtaoPass.blendIntensity = 1.0;
			threeGtaoPass.updateGtaoMaterial( {
				radius: state.aoRadius,
				scale: state.aoIntensity,
				thickness: 10.0,
				distanceExponent: 2.0,
				distanceFallOff: 1.0,
				screenSpaceRadius: false
			} );
			threeComposer.addPass( threeGtaoPass );
			console.log( '[PostProcess] GTAO: enabled, radius=', state.aoRadius, 'intensity=', state.aoIntensity );

		}

		// Bloom pass
		if ( state.bloomEnabled ) {

			const resolution = new THREE.Vector2( width, height );
			threeBloomPass = new QuakeBloomPass( resolution );
			threeBloomPass.enabled = true;
			threeBloomPass.threshold = state.bloomThreshold;
			threeBloomPass.intensity = state.bloomIntensity;
			threeBloomPass.radius = state.bloomRadius;
			threeComposer.addPass( threeBloomPass );
			console.log( '[PostProcess] Bloom: enabled' );

		}

		// Output pass (tonemapping) - always last in normal mode
		threeOutputPass = new OutputPass();
		threeComposer.addPass( threeOutputPass );

		// Apply tonemapping settings to renderer
		if ( state.tonemappingEnabled ) {

			renderer.toneMapping = TONE_MAPPING_OPERATORS[ state.tonemappingOperator ] || THREE.ACESFilmicToneMapping;
			renderer.toneMappingExposure = state.tonemappingExposure;

		} else {

			renderer.toneMapping = THREE.NoToneMapping;

		}
		console.log( '[PostProcess] Tonemapping:', state.tonemappingEnabled ? 'enabled' : 'disabled' );

	}

	threeInitialized = true;
	lastCvarState = { ...state };
	console.log( '[PostProcess] Initialized (debug mode:', aoDebugMode, ')' );

}

//============================================================================
// Resize handler
//============================================================================

function PostProcess_Resize( width, height ) {

	if ( threeComposer ) {

		threeComposer.setSize( width, height );
		if ( threeGtaoPass ) threeGtaoPass.setSize( width, height );
		if ( threeBloomPass ) threeBloomPass.setSize( width, height );

	}

}

//============================================================================
// Public init
//============================================================================

export function PostProcess_Init() {

	VID_AddResizeCallback( PostProcess_Resize );

}

//============================================================================
// Render
//============================================================================

export function PostProcess_Render() {

	// Get current cvar state
	const state = getCvarState();

	// AO debug mode always needs postprocessing (even if AO itself is disabled)
	const aoDebugMode = state.aoDebug >= 2 && state.aoDebug <= 4;

	// Check if any effect is wanted (for early return)
	if ( ! aoDebugMode && ! state.aoEnabled && ! state.bloomEnabled && ! state.tonemappingEnabled ) {

		return false;

	}

	// Check if structural changes require reinit
	if ( ! threeInitialized || needsReinit( state ) ) {

		initThreeJS( state );

	} else {

		// Apply parameter-only changes without reinit
		applyParameterChanges( state );

	}

	if ( threeComposer ) {

		if ( threeRenderPass ) threeRenderPass.camera = camera;
		if ( threeGtaoPass ) threeGtaoPass.camera = camera;

		// Render entire scene through composer.
		// Transparent objects (water, particles) are rendered by RenderPass normally.
		// GTAOPass only affects opaque pixels since transparent objects don't write depth.
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
	lastCvarState = null;

}
