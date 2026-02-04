//============================================================================
// gl_postprocess.js - Three.js postprocessing system
//
// Uses Three.js EffectComposer with QuakeBloomPass and OutputPass.
//
// cg_hq bitmask:
//   bit 2 (4) = Bloom
//   bit 3 (8) = Tonemapping
//============================================================================

import * as THREE from 'three'; // Uses shimmed three.js via importmap

// Three.js postprocessing
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { QuakeBloomPass } from './gl_bloom_pass.js';

import { renderer, vid, VID_AddResizeCallback } from './vid.js';
import { scene, camera, cg_hq, cg_hq_bloom, cg_hq_tonemapping } from './gl_rmain.js';
import {
	cg_hq_bloom_threshold, cg_hq_bloom_intensity, cg_hq_bloom_radius,
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
// State
//============================================================================

let composer = null;
let renderPass = null;
let bloomPass = null;
let outputPass = null;
let initialized = false;

// Track last cvar values to detect changes requiring reinit
let lastCvarState = null;

//============================================================================
// Cvar state tracking
//============================================================================

function getCvarState() {

	const hq = cg_hq.value | 0;

	return {
		hq,
		// Bloom
		bloom: cg_hq_bloom.value | 0,
		bloomThreshold: parseFloat( cg_hq_bloom_threshold.value ) || 0.5,
		bloomIntensity: parseFloat( cg_hq_bloom_intensity.value ) || 0.5,
		bloomRadius: parseFloat( cg_hq_bloom_radius.value ) || 1.0,
		// Tonemapping
		tonemapping: cg_hq_tonemapping.value | 0,
		tonemappingOperator: cg_hq_tonemapping_operator.value | 0,
		tonemappingExposure: parseFloat( cg_hq_tonemapping_exposure.value ) || 1.0,
		// Computed enabled states
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

	// Structural changes that require rebuilding the pass chain
	const structuralKeys = [ 'bloomEnabled', 'tonemappingEnabled' ];

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

	// Bloom parameters
	if ( bloomPass ) {

		bloomPass.threshold = state.bloomThreshold;
		bloomPass.intensity = state.bloomIntensity;
		bloomPass.radius = state.bloomRadius;

	}

	// Tonemapping parameters
	if ( state.tonemappingEnabled ) {

		renderer.toneMapping = TONE_MAPPING_OPERATORS[ state.tonemappingOperator ] || THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = state.tonemappingExposure;

	}

	lastCvarState = { ...state };

}

//============================================================================
// Initialize postprocessing
//============================================================================

function initPostProcess( state ) {

	if ( ! renderer || ! scene || ! camera ) return;

	// Dispose existing composer if reinitializing
	if ( composer ) {

		composer.dispose();
		composer = null;

	}

	// Clear pass references
	renderPass = null;
	bloomPass = null;
	outputPass = null;

	const width = vid.width || window.innerWidth;
	const height = vid.height || window.innerHeight;

	composer = new EffectComposer( renderer );

	// Render pass - always first
	renderPass = new RenderPass( scene, camera );
	composer.addPass( renderPass );

	// Bloom pass
	if ( state.bloomEnabled ) {

		const resolution = new THREE.Vector2( width, height );
		bloomPass = new QuakeBloomPass( resolution );
		bloomPass.enabled = true;
		bloomPass.threshold = state.bloomThreshold;
		bloomPass.intensity = state.bloomIntensity;
		bloomPass.radius = state.bloomRadius;
		composer.addPass( bloomPass );
		console.log( '[PostProcess] Bloom: enabled' );

	}

	// Output pass (tonemapping) - always last
	outputPass = new OutputPass();
	composer.addPass( outputPass );

	// Apply tonemapping settings to renderer
	if ( state.tonemappingEnabled ) {

		renderer.toneMapping = TONE_MAPPING_OPERATORS[ state.tonemappingOperator ] || THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = state.tonemappingExposure;

	} else {

		renderer.toneMapping = THREE.NoToneMapping;

	}
	console.log( '[PostProcess] Tonemapping:', state.tonemappingEnabled ? 'enabled' : 'disabled' );

	initialized = true;
	lastCvarState = { ...state };
	console.log( '[PostProcess] Initialized' );

}

//============================================================================
// Resize handler
//============================================================================

function PostProcess_Resize( width, height ) {

	if ( composer ) {

		composer.setSize( width, height );
		if ( bloomPass ) bloomPass.setSize( width, height );

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

	// Check if any effect is wanted (for early return)
	if ( ! state.bloomEnabled && ! state.tonemappingEnabled ) {

		return false;

	}

	// Check if structural changes require reinit
	if ( ! initialized || needsReinit( state ) ) {

		initPostProcess( state );

	} else {

		// Apply parameter-only changes without reinit
		applyParameterChanges( state );

	}

	if ( composer ) {

		if ( renderPass ) renderPass.camera = camera;

		composer.render();

		return true;

	}

	return false;

}

//============================================================================
// Cleanup
//============================================================================

export function PostProcess_Dispose() {

	if ( composer ) composer.dispose();
	composer = null;
	initialized = false;
	lastCvarState = null;

}
