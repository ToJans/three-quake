//============================================================================
// gl_texture_analysis.js - Derive roughness, normal, and reflectivity maps
//
// Analyzes Quake textures to generate PBR-compatible maps:
// - Roughness: From texture variance (smooth areas = low roughness)
// - Normal: From Sobel edge detection (height to normal conversion)
// - Reflectivity: From specular highlights (bright spots)
//============================================================================

import * as THREE from 'three';

/**
 * Analyze an RGBA texture and derive roughness, normal, and reflectivity maps.
 * @param {Uint8Array} rgba - RGBA pixel data
 * @param {number} width - Texture width
 * @param {number} height - Texture height
 * @returns {Object} Object with roughnessMap, normalMap, reflectivityMap textures
 */
export function analyzeTexture( rgba, width, height ) {

	// Convert to grayscale for analysis
	const gray = new Float32Array( width * height );
	for ( let i = 0; i < width * height; i ++ ) {

		// Luminance formula
		gray[ i ] = (
			rgba[ i * 4 ] * 0.299 +
			rgba[ i * 4 + 1 ] * 0.587 +
			rgba[ i * 4 + 2 ] * 0.114
		) / 255;

	}

	// Generate maps
	const roughnessData = generateRoughnessMap( gray, width, height );
	const normalData = generateNormalMap( gray, width, height );
	const reflectivityData = generateReflectivityMap( rgba, gray, width, height );

	// Create Three.js textures
	const roughnessMap = createGrayscaleTexture( roughnessData, width, height );
	const normalMap = createNormalTexture( normalData, width, height );
	const reflectivityMap = createGrayscaleTexture( reflectivityData, width, height );

	return { roughnessMap, normalMap, reflectivityMap };

}

/**
 * Generate roughness map from local variance.
 * High variance = rough surface, low variance = smooth/shiny.
 */
function generateRoughnessMap( gray, width, height ) {

	const roughness = new Uint8Array( width * height );
	const kernelSize = 3;
	const halfKernel = Math.floor( kernelSize / 2 );

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			// Calculate local variance in a kernel window
			let sum = 0;
			let sumSq = 0;
			let count = 0;

			for ( let ky = - halfKernel; ky <= halfKernel; ky ++ ) {

				for ( let kx = - halfKernel; kx <= halfKernel; kx ++ ) {

					// Wrap around for seamless textures
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

			// Map variance to roughness (0-1)
			// Higher variance = higher roughness
			// Scale factor tuned for Quake textures
			const rough = Math.min( 1, Math.sqrt( variance ) * 4 );
			roughness[ y * width + x ] = Math.floor( rough * 255 );

		}

	}

	return roughness;

}

/**
 * Generate normal map using Sobel edge detection.
 * Treats grayscale as height and computes surface normals.
 */
function generateNormalMap( gray, width, height ) {

	const normals = new Uint8Array( width * height * 4 );
	const strength = 2.0; // Normal map strength

	// Sobel kernels
	const sobelX = [ - 1, 0, 1, - 2, 0, 2, - 1, 0, 1 ];
	const sobelY = [ - 1, - 2, - 1, 0, 0, 0, 1, 2, 1 ];

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			let gx = 0;
			let gy = 0;

			// Apply Sobel kernels
			for ( let ky = - 1; ky <= 1; ky ++ ) {

				for ( let kx = - 1; kx <= 1; kx ++ ) {

					// Wrap around for seamless textures
					const sx = ( x + kx + width ) % width;
					const sy = ( y + ky + height ) % height;
					const val = gray[ sy * width + sx ];

					const ki = ( ky + 1 ) * 3 + ( kx + 1 );
					gx += val * sobelX[ ki ];
					gy += val * sobelY[ ki ];

				}

			}

			// Convert gradients to normal vector
			// Normal = normalize(-gx * strength, -gy * strength, 1)
			const nx = - gx * strength;
			const ny = - gy * strength;
			const nz = 1;
			const len = Math.sqrt( nx * nx + ny * ny + nz * nz );

			// Encode normal to RGB (0-255, where 128 = 0)
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
 * Generate reflectivity map from specular highlights.
 * Bright areas with low saturation = likely specular = reflective.
 */
function generateReflectivityMap( rgba, gray, width, height ) {

	const reflectivity = new Uint8Array( width * height );

	for ( let i = 0; i < width * height; i ++ ) {

		const r = rgba[ i * 4 ] / 255;
		const g = rgba[ i * 4 + 1 ] / 255;
		const b = rgba[ i * 4 + 2 ] / 255;

		// Calculate saturation
		const maxC = Math.max( r, g, b );
		const minC = Math.min( r, g, b );
		const saturation = maxC > 0 ? ( maxC - minC ) / maxC : 0;

		// Luminance
		const luminance = gray[ i ];

		// Reflectivity: high luminance + low saturation = specular highlight
		// Also consider overall brightness as indicator of metal/shiny
		let refl = 0;

		// Bright, desaturated areas are likely specular
		if ( luminance > 0.6 && saturation < 0.3 ) {

			refl = ( luminance - 0.6 ) * 2.5 * ( 1 - saturation );

		}

		// Clamp to 0-1
		refl = Math.min( 1, Math.max( 0, refl ) );
		reflectivity[ i ] = Math.floor( refl * 255 );

	}

	return reflectivity;

}

/**
 * Create a grayscale Three.js texture from Uint8Array data.
 */
function createGrayscaleTexture( data, width, height ) {

	// Convert to RGBA for Three.js compatibility
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
 * Create a normal map Three.js texture from RGBA normal data.
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
