# Three-Quake Rendering Pipeline

This document describes the rendering architecture and lessons learned during implementation.

---

## Render Loop Overview

```
Host_Frame()
  └─► V_RenderView()
        └─► SCR_UpdateScreen()
              └─► R_RenderView()           [gl_rmain.js]
                    ├─► R_Clear()
                    ├─► R_RenderScene()
                    │     ├─► R_SetupFrame()
                    │     ├─► R_SetFrustum()
                    │     ├─► R_SetupGL()
                    │     ├─► R_MarkLeaves()
                    │     ├─► R_DrawWorld()
                    │     ├─► R_DrawEntitiesOnList()
                    │     ├─► R_RenderDlights()
                    │     └─► R_DrawParticles()
                    ├─► R_DrawViewModel()
                    ├─► R_DrawWaterSurfaces()
                    ├─► R_Mirror()
                    ├─► PostProcess_Render()           ◄── EffectComposer pipeline
                    │     └─► (or renderer.render if disabled)
                    ├─► R_PolyBlend()                   ◄── Screen overlays (damage, etc.)
                    └─► R_CleanupWaterMeshes()
```

---

## Post-Processing Architecture

The postprocessing system uses Three.js EffectComposer with a dynamic pass chain.

### Files

| File | Purpose |
|------|---------|
| `src/gl_postprocess.js` | EffectComposer setup, pass chain management |
| `src/gl_ssr.js` | Custom SSR (screen-space reflections) system |
| `src/gl_bloom_pass.js` | QuakeBloomPass for bloom effect |
| `src/gl_texture_analysis.js` | Derive roughness/normal/reflectivity from textures |

### Pass Chain

**Normal Mode** (all effects enabled):
```
RenderPass → GTAOPass → SSRPass → BloomPass → OutputPass
     │            │          │         │           │
  Scene      Ambient    Reflections  Glow    Tonemapping
  render     occlusion
```

**Debug Mode** (aoDebug 2-4):
```
RenderPass → GTAOPass (renderToScreen=true)
                │
         Debug output (depth/normal/AO buffer)
```

### Structural vs Parameter Changes

The system optimizes cvar changes:

- **Structural changes** (require reinit): enabling/disabling effects, debug mode changes
- **Parameter changes** (applied without reinit): radius, intensity, threshold, etc.

```javascript
// Structural changes trigger full pipeline rebuild
const structuralKeys = ['aoDebug', 'ssrEnabled', 'aoEnabled', 'bloomEnabled', 'tonemappingEnabled'];

// Parameter changes just update uniforms
applyParameterChanges(state);
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/gl_rmain.js` | Main renderer, camera, scene, cvars, R_RenderView |
| `src/gl_rmisc.js` | R_Init, cvar registration |
| `src/gl_postprocess.js` | EffectComposer and pass chain management |
| `src/gl_ssr.js` | Screen-space reflections |
| `src/gl_rsurf.js` | Surface rendering, texture reflectivity tagging |
| `src/vid.js` | WebGLRenderer setup, resize handling |
| `src/cvar.js` | Console variable system |

---

## SSR (Screen-Space Reflections)

### Reflectivity System

Reflectivity is determined per-mesh based on texture names and surface type:

| Surface Type | Reflectivity | Source |
|--------------|--------------|--------|
| Water/Slime/Lava | 0.8 | `_getWaterMesh()` in gl_rsurf.js |
| Metal textures (tech*, tlight*, metal*, etc.) | 0.4 | `getTextureReflectivity()` |
| Glass/Window textures | 0.6 | `getTextureReflectivity()` |
| Other surfaces | 0 | Not rendered in reflectivity pass |

### SSR Render Passes

1. **Depth pass** - Linear depth buffer
2. **Normal pass** - View-space normals
3. **Reflectivity pass** - Only reflective surfaces (userData.reflectivity > 0)
4. **Color pass** - Full scene color
5. **SSR pass** - Ray marching for reflections
6. **Blur pass** - Smooth SSR output
7. **Composite pass** - Blend SSR with scene

### SSR Debug Modes

```
Note: SSR debug modes were removed as they used a separate custom SSR
implementation that didn't reflect the actual Three.js SSRPass behavior.
```

---

## GTAO Debug Modes

Controlled by `cg_hq_ao_debug` console variable:

| Value | Mode | Description |
|-------|------|-------------|
| 0 | Normal | Blended AO output |
| 2 | Depth | Display depth buffer |
| 3 | Normal | Display normal buffer |
| 4 | AO | Display raw AO buffer |
| 5 | Denoise | Display denoised AO |

**Debug mode architecture:**
- Debug modes 2-4 rebuild the pass chain with only GTAOPass
- GTAOPass.renderToScreen = true skips other passes
- Output goes directly to screen without tonemapping

```javascript
if (aoDebugMode) {
    // Only GTAOPass, renders directly to screen
    threeGtaoPass.output = state.aoDebug;
    threeGtaoPass.renderToScreen = true;
} else {
    // Full pass chain
    // GTAOPass → SSRPass → BloomPass → OutputPass
}
```

---

## Bloom

Controlled by `cg_hq_bloom` and parameters:

```
cg_hq_bloom 1                 # Enable bloom
cg_hq_bloom_threshold 0.15    # Brightness cutoff
cg_hq_bloom_intensity 0.7     # Bloom strength
cg_hq_bloom_radius 0.3        # Blur spread
```

Uses QuakeBloomPass (custom pass in gl_bloom_pass.js).

---

## Tonemapping

Controlled by `cg_hq_tonemapping` and parameters:

```
cg_hq_tonemapping 1              # Enable
cg_hq_tonemapping_operator 3     # 0=ACES, 1=Reinhard, 2=Cineon, 3=AgX, 4=Neutral
cg_hq_tonemapping_exposure 3     # Exposure value
```

Uses Three.js OutputPass which applies renderer.toneMapping.

---

## Texture Analysis (Derived Maps)

The `gl_texture_analysis.js` module generates PBR-compatible maps from Quake textures:

### Roughness Map
- Analyzes local variance in 3x3 kernel
- High variance = rough, low variance = smooth
- Stored in `texture.userData.roughnessMap`

### Normal Map
- Uses Sobel edge detection
- Converts heightfield to surface normals
- Stored in `texture.userData.normalMap`

### Reflectivity Map
- Detects specular highlights (high luminance, low saturation)
- Stored in `texture.userData.reflectivityMap`

---

## Three.js Shader Gotchas

### Reserved Uniform Names

**DO NOT USE these names in custom ShaderMaterial uniforms:**
- `projectionMatrix` - Use `cameraProjectionMatrix` instead
- `modelViewMatrix` - Reserved
- `viewMatrix` - Reserved
- `modelMatrix` - Reserved
- `normalMatrix` - Reserved
- `cameraPosition` - Reserved

### Shader Errors Are Silent

WebGL shader compilation errors are not thrown as exceptions. Check the browser console for:
- `WebGL: too many errors, no more errors will be reported`
- `Performance warning: clear() called with no buffers in bitmask`

---

## Console Variables (Cvars)

### HQ Effects Bitmask

`cg_hq` is a bitmask that enables multiple effects:
- Bit 0 (1) = SSR
- Bit 1 (2) = AO
- Bit 2 (4) = Bloom
- Bit 3 (8) = Tonemapping

```
cg_hq 15    # All effects enabled (1+2+4+8)
cg_hq 0     # All effects disabled
```

### Individual Effect Cvars

Individual cvars override the bitmask (OR logic):

```
cg_hq_ssr 1           # Enable SSR
cg_hq_ao 1            # Enable AO
cg_hq_bloom 1         # Enable Bloom
cg_hq_tonemapping 1   # Enable Tonemapping
```

### Default Values

All effects are enabled by default:
- `cg_hq = 15`
- `cg_hq_ssr = 1`
- `cg_hq_ao = 1`
- `cg_hq_bloom = 1`
- `cg_hq_tonemapping = 1`

---

## Browser Testing

Execute console commands programmatically:

```javascript
window.Cbuf_AddText("cg_hq_ao_debug 4\n");  // Show raw AO buffer
window.Cbuf_AddText("map e1m1\n");          // Load a map
```

---

## Debugging Checklist

When a post-process effect shows black screen:

1. **Check console for errors** - Look for WebGL/shader errors
2. **Check reserved uniform names** - Rename conflicts with Three.js
3. **Test with solid color output** - Add `gl_FragColor = vec4(0.5, 0.5, 0.5, 1.0); return;`
4. **Check debug modes** - Use debug cvars to visualize intermediate buffers
5. **Check pass chain** - Verify passes are added in correct order
6. **Check structural changes** - Ensure reinit happens when needed
7. **Check render targets** - Verify textures are created and sized correctly

---

## Performance Tips

1. Render G-buffers (depth, normals) at full resolution for quality
2. AO can be computed at half resolution if needed
3. Use bilateral blur (depth-aware) to smooth AO without losing edges
4. Skip AO for sky pixels (depth > 0.99)
5. Group reflective meshes by reflectivity value to minimize render calls
6. Only reinit pass chain on structural changes, not parameter changes
