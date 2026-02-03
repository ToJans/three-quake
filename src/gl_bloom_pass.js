//============================================================================
// QuakeBloomPass - Custom Three.js Pass using the original Quake bloom shaders
//
// Integrates the custom mip-chain bloom with Three.js EffectComposer
//============================================================================

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const MIP_LEVELS = 5;

//============================================================================
// Shaders (from gl_bloom.js)
//============================================================================

// Bright pass - extracts pixels above threshold
const brightPassShader = {
	uniforms: {
		tDiffuse: { value: null },
		threshold: { value: 0.5 },
		smoothWidth: { value: 0.2 }
	},
	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}
	`,
	fragmentShader: /* glsl */`
		precision highp float;
		varying vec2 vUv;
		uniform sampler2D tDiffuse;
		uniform float threshold;
		uniform float smoothWidth;

		void main() {
			vec4 color = texture2D(tDiffuse, vUv);

			// Calculate luminance
			float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));

			// Boost warm colors (fire, lava, torches) - they should bloom more
			float warmth = max(0.0, color.r - max(color.g, color.b) * 0.5);
			luminance += warmth * 0.5;

			// Boost saturated colors (stained glass, colored lights)
			float maxC = max(color.r, max(color.g, color.b));
			float minC = min(color.r, min(color.g, color.b));
			float saturation = maxC - minC;
			luminance += saturation * maxC * 0.5;

			// Apply threshold with smooth falloff
			float brightness = smoothstep(threshold, threshold + smoothWidth, luminance);

			gl_FragColor = vec4(color.rgb * brightness, 1.0);
		}
	`
};

// Gaussian blur - separable (run twice: H then V)
const blurShader = {
	uniforms: {
		tDiffuse: { value: null },
		direction: { value: new THREE.Vector2( 1, 0 ) },
		resolution: { value: new THREE.Vector2() },
		radius: { value: 1.0 }
	},
	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}
	`,
	fragmentShader: /* glsl */`
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
				vec2 offset = direction * texelSize * float(i) * radius;
				result += texture2D(tDiffuse, vUv + offset).rgb * weights[i];
				result += texture2D(tDiffuse, vUv - offset).rgb * weights[i];
			}

			gl_FragColor = vec4(result, 1.0);
		}
	`
};

// Composite - combines all blur levels
const compositeShader = {
	uniforms: {
		tDiffuse: { value: null }, // Scene input from previous pass
		tBlur0: { value: null },
		tBlur1: { value: null },
		tBlur2: { value: null },
		tBlur3: { value: null },
		tBlur4: { value: null },
		intensity: { value: 0.5 }
	},
	vertexShader: /* glsl */`
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
		}
	`,
	fragmentShader: /* glsl */`
		precision highp float;
		varying vec2 vUv;
		uniform sampler2D tDiffuse;
		uniform sampler2D tBlur0;
		uniform sampler2D tBlur1;
		uniform sampler2D tBlur2;
		uniform sampler2D tBlur3;
		uniform sampler2D tBlur4;
		uniform float intensity;

		void main() {
			vec3 scene = texture2D(tDiffuse, vUv).rgb;

			// Sample all blur levels with increasing weights for wider blur
			vec3 bloom = vec3(0.0);
			bloom += texture2D(tBlur0, vUv).rgb * 1.0;
			bloom += texture2D(tBlur1, vUv).rgb * 1.2;
			bloom += texture2D(tBlur2, vUv).rgb * 1.4;
			bloom += texture2D(tBlur3, vUv).rgb * 1.6;
			bloom += texture2D(tBlur4, vUv).rgb * 1.8;

			// Normalize and apply intensity
			bloom = bloom / 7.0 * intensity;

			// Additive blend
			gl_FragColor = vec4(scene + bloom, 1.0);
		}
	`
};

//============================================================================
// QuakeBloomPass
//============================================================================

class QuakeBloomPass extends Pass {

	constructor( resolution, threshold = 0.15, intensity = 0.7, radius = 0.3 ) {

		super();

		this.resolution = resolution || new THREE.Vector2( 256, 256 );
		this.threshold = threshold;
		this.intensity = intensity;
		this.radius = radius;

		// Render targets
		this.brightPassTarget = null;
		this.blurTargetsH = [];
		this.blurTargetsV = [];

		// Materials
		this.brightPassMaterial = new THREE.ShaderMaterial( {
			uniforms: THREE.UniformsUtils.clone( brightPassShader.uniforms ),
			vertexShader: brightPassShader.vertexShader,
			fragmentShader: brightPassShader.fragmentShader
		} );

		this.blurMaterial = new THREE.ShaderMaterial( {
			uniforms: THREE.UniformsUtils.clone( blurShader.uniforms ),
			vertexShader: blurShader.vertexShader,
			fragmentShader: blurShader.fragmentShader
		} );

		this.compositeMaterial = new THREE.ShaderMaterial( {
			uniforms: THREE.UniformsUtils.clone( compositeShader.uniforms ),
			vertexShader: compositeShader.vertexShader,
			fragmentShader: compositeShader.fragmentShader
		} );

		// Fullscreen quad
		this.fsQuad = new FullScreenQuad( null );

		// Create render targets
		this._createRenderTargets();

	}

	_createRenderTargets() {

		const width = this.resolution.x;
		const height = this.resolution.y;

		// Dispose old targets
		if ( this.brightPassTarget ) this.brightPassTarget.dispose();
		this.blurTargetsH.forEach( t => t.dispose() );
		this.blurTargetsV.forEach( t => t.dispose() );

		// Bright pass at full resolution
		this.brightPassTarget = new THREE.WebGLRenderTarget( width, height, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			format: THREE.RGBAFormat,
			type: THREE.HalfFloatType
		} );

		// Mip chain for progressive blur
		this.blurTargetsH = [];
		this.blurTargetsV = [];

		for ( let i = 0; i < MIP_LEVELS; i ++ ) {

			const mipWidth = Math.max( 1, Math.floor( width / Math.pow( 2, i + 1 ) ) );
			const mipHeight = Math.max( 1, Math.floor( height / Math.pow( 2, i + 1 ) ) );

			this.blurTargetsH[ i ] = new THREE.WebGLRenderTarget( mipWidth, mipHeight, {
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
				format: THREE.RGBAFormat,
				type: THREE.HalfFloatType
			} );

			this.blurTargetsV[ i ] = new THREE.WebGLRenderTarget( mipWidth, mipHeight, {
				minFilter: THREE.LinearFilter,
				magFilter: THREE.LinearFilter,
				format: THREE.RGBAFormat,
				type: THREE.HalfFloatType
			} );

		}

	}

	setSize( width, height ) {

		this.resolution.set( width, height );
		this._createRenderTargets();

	}

	render( renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */ ) {

		// 1. Bright pass - extract bright pixels
		this.brightPassMaterial.uniforms.tDiffuse.value = readBuffer.texture;
		this.brightPassMaterial.uniforms.threshold.value = this.threshold;

		this.fsQuad.material = this.brightPassMaterial;
		renderer.setRenderTarget( this.brightPassTarget );
		this.fsQuad.render( renderer );

		// 2. Progressive blur through mip chain
		let inputTexture = this.brightPassTarget.texture;

		for ( let i = 0; i < MIP_LEVELS; i ++ ) {

			const mipWidth = this.blurTargetsH[ i ].width;
			const mipHeight = this.blurTargetsH[ i ].height;

			// Horizontal blur
			this.blurMaterial.uniforms.tDiffuse.value = inputTexture;
			this.blurMaterial.uniforms.direction.value.set( 1, 0 );
			this.blurMaterial.uniforms.resolution.value.set( mipWidth, mipHeight );
			this.blurMaterial.uniforms.radius.value = this.radius;

			this.fsQuad.material = this.blurMaterial;
			renderer.setRenderTarget( this.blurTargetsH[ i ] );
			this.fsQuad.render( renderer );

			// Vertical blur
			this.blurMaterial.uniforms.tDiffuse.value = this.blurTargetsH[ i ].texture;
			this.blurMaterial.uniforms.direction.value.set( 0, 1 );

			renderer.setRenderTarget( this.blurTargetsV[ i ] );
			this.fsQuad.render( renderer );

			// Use this level's output as input for next level
			inputTexture = this.blurTargetsV[ i ].texture;

		}

		// 3. Composite: scene + bloom
		this.compositeMaterial.uniforms.tDiffuse.value = readBuffer.texture;
		this.compositeMaterial.uniforms.tBlur0.value = this.blurTargetsV[ 0 ].texture;
		this.compositeMaterial.uniforms.tBlur1.value = this.blurTargetsV[ 1 ].texture;
		this.compositeMaterial.uniforms.tBlur2.value = this.blurTargetsV[ 2 ].texture;
		this.compositeMaterial.uniforms.tBlur3.value = this.blurTargetsV[ 3 ].texture;
		this.compositeMaterial.uniforms.tBlur4.value = this.blurTargetsV[ 4 ].texture;
		this.compositeMaterial.uniforms.intensity.value = this.intensity;

		this.fsQuad.material = this.compositeMaterial;

		if ( this.renderToScreen ) {

			renderer.setRenderTarget( null );
			this.fsQuad.render( renderer );

		} else {

			renderer.setRenderTarget( writeBuffer );
			if ( this.clear ) renderer.clear();
			this.fsQuad.render( renderer );

		}

	}

	dispose() {

		if ( this.brightPassTarget ) this.brightPassTarget.dispose();
		this.blurTargetsH.forEach( t => t.dispose() );
		this.blurTargetsV.forEach( t => t.dispose() );

		this.brightPassMaterial.dispose();
		this.blurMaterial.dispose();
		this.compositeMaterial.dispose();

		this.fsQuad.dispose();

	}

}

export { QuakeBloomPass };
