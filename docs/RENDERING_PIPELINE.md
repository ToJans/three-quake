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
                    ├─► renderer.render(scene, camera)  ◄── Main Three.js render
                    ├─► R_ApplyHQEffects()              ◄── Post-processing (GTAO, etc.)
                    ├─► R_PolyBlend()                   ◄── Screen overlays (damage, etc.)
                    └─► R_CleanupWaterMeshes()
```

---

## Post-Processing Integration Point

Post-processing effects are applied in `R_ApplyHQEffects()` which is called **after** `renderer.render()` but **before** `R_PolyBlend()`.

```javascript
// In gl_rmain.js R_RenderView()
renderer.render(scene, camera);  // Main scene
R_ApplyHQEffects();              // ◄── Post-processing goes here
R_PolyBlend();                   // Screen overlays (must be last)
```

---

## Key Files

| File | Purpose |
|------|---------|
| `src/gl_rmain.js` | Main renderer, camera, scene, cvars, R_RenderView |
| `src/gl_rmisc.js` | R_Init, cvar registration |
| `src/gl_gtao.js` | GTAO ambient occlusion post-process |
| `src/gl_bloom.js` | HDR Bloom post-process |
| `src/gl_tonemapping.js` | HDR Tonemapping post-process |
| `src/vid.js` | WebGLRenderer setup, resize handling |
| `src/cvar.js` | Console variable system |

---

## Three.js Shader Gotchas

### Reserved Uniform Names

**CRITICAL**: Three.js reserves certain uniform names. Using them causes silent shader compilation failures.

**DO NOT USE these names in custom ShaderMaterial uniforms:**
- `projectionMatrix` - Use `cameraProjectionMatrix` instead
- `modelViewMatrix` - Reserved
- `viewMatrix` - Reserved
- `modelMatrix` - Reserved
- `normalMatrix` - Reserved
- `cameraPosition` - Reserved

```javascript
// BAD - will silently fail
gtaoMaterial = new THREE.ShaderMaterial({
    uniforms: {
        projectionMatrix: { value: new THREE.Matrix4() },  // ❌ RESERVED
        inverseProjectionMatrix: { value: new THREE.Matrix4() }
    }
});

// GOOD - use custom names
gtaoMaterial = new THREE.ShaderMaterial({
    uniforms: {
        cameraProjectionMatrix: { value: new THREE.Matrix4() },  // ✓
        cameraInverseProjectionMatrix: { value: new THREE.Matrix4() }  // ✓
    }
});
```

### Shader Errors Are Silent

WebGL shader compilation errors are not thrown as exceptions. Check the browser console for:
- `WebGL: too many errors, no more errors will be reported`
- `Performance warning: clear() called with no buffers in bitmask`

These indicate shader compilation failures.

---

## GTAO Debug Modes

The GTAO composite shader has debug modes controlled by the `cg_hq_ao_debug` console variable:

| Value | Mode | Description |
|-------|------|-------------|
| 0 | Normal | Apply AO with multiply blending |
| 1 | White | Output white (test if blending works) |
| 2 | Show AO | Display raw AO buffer |
| 3 | Show Depth | Display depth buffer |
| 4 | Show Normals | Display normal buffer |

**To enable debug mode**, use the console:
```
cg_hq_ao_debug 3    # Show depth buffer
cg_hq_ao_debug 4    # Show normals
cg_hq_ao_debug 2    # Show raw AO
cg_hq_ao_debug 0    # Normal rendering
```

**Debug workflow:**
1. `cg_hq_ao_debug 3` (depth) - Verify depth buffer is captured correctly
2. `cg_hq_ao_debug 4` (normals) - Verify normals are captured correctly
3. `cg_hq_ao_debug 2` (AO) - See raw AO output
4. `cg_hq_ao_debug 0` (normal) - Final blended result

---

## Bloom Debug Modes

The Bloom composite shader has debug modes controlled by the `cg_hq_bloom_debug` console variable:

| Value | Mode | Description |
|-------|------|-------------|
| 0 | Normal | Apply bloom with additive blending |
| 1 | Show Bloom | Display bloom contribution only |
| 2 | Show Bright Pass | Display pixels above threshold |
| 3 | Show Scene | Display captured scene texture |

**To debug bloom**, use the console:
```
cg_hq_bloom_debug 3    # Show captured scene (verify capture works)
cg_hq_bloom_debug 2    # Show bright pass (what's being extracted)
cg_hq_bloom_debug 1    # Show bloom only (blurred result)
cg_hq_bloom_debug 0    # Normal rendering
```

**Bloom parameters:**
```
cg_hq_bloom 1                # Enable bloom
cg_hq_bloom_threshold 0.0    # Brightness cutoff (0 = no threshold)
cg_hq_bloom_intensity 6.0    # Bloom strength
cg_hq_bloom_radius 2.0       # Blur spread multiplier
```

---

## Tonemapping Debug Modes

The Tonemapping shader has debug modes controlled by the `cg_hq_tonemapping_debug` console variable:

| Value | Mode | Description |
|-------|------|-------------|
| 0 | Normal | Apply tonemapping and gamma correction |
| 1 | No Tonemap | Show exposure-adjusted colors without tonemapping |
| 2 | Luminance | Display luminance values |
| 3 | Raw HDR | Display raw HDR values (clamped to 0-1) |

**To debug tonemapping**, use the console:
```
cg_hq_tonemapping_debug 3    # Show raw HDR values
cg_hq_tonemapping_debug 2    # Show luminance
cg_hq_tonemapping_debug 1    # Exposure only, no tonemapping
cg_hq_tonemapping_debug 0    # Normal rendering
```

**Tonemapping parameters:**
```
cg_hq_tonemapping 1                # Enable tonemapping
cg_hq_tonemapping_operator 0       # 0=ACES, 1=Reinhard, 2=Uncharted2
cg_hq_tonemapping_exposure 1.0     # Scene exposure
cg_hq_tonemapping_gamma 2.2        # Display gamma
```

---

## Render Target Best Practices

### Texture Filtering

Use `LinearFilter` for smooth sampling in post-processing:

```javascript
// GOOD - smooth sampling
depthRenderTarget = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.FloatType
});

// BAD - causes grid/blocky artifacts
depthRenderTarget = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.NearestFilter,  // ❌ Causes grid pattern
    magFilter: THREE.NearestFilter
});
```

### Resolution

For quality, use full resolution. For performance, use half:

```javascript
// Full resolution (better quality)
aoRenderTarget = new THREE.WebGLRenderTarget(width, height, {...});

// Half resolution (better performance, may cause artifacts)
aoRenderTarget = new THREE.WebGLRenderTarget(
    Math.floor(width * 0.5),
    Math.floor(height * 0.5),
    {...}
);
```

---

## Compositing Without Clearing

When compositing post-effects onto the existing framebuffer, you must prevent Three.js from clearing:

```javascript
// Save state
const oldAutoClear = renderer.autoClear;
const oldAutoClearColor = renderer.autoClearColor;
const oldAutoClearDepth = renderer.autoClearDepth;
const oldAutoClearStencil = renderer.autoClearStencil;

// Disable all clearing
renderer.autoClear = false;
renderer.autoClearColor = false;
renderer.autoClearDepth = false;
renderer.autoClearStencil = false;

// Also ensure screenScene has no background
screenScene.background = null;

// Render composite
renderer.setRenderTarget(null);  // Render to screen
renderer.render(screenScene, screenCamera);

// Restore state
renderer.autoClear = oldAutoClear;
renderer.autoClearColor = oldAutoClearColor;
renderer.autoClearDepth = oldAutoClearDepth;
renderer.autoClearStencil = oldAutoClearStencil;
```

---

## Multiply Blending for AO

To darken the scene with AO values:

```javascript
compositeMaterial = new THREE.ShaderMaterial({
    // ...
    transparent: true,
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true  // Required for MultiplyBlending
});
```

The shader outputs the AO value (0-1) which multiplies with the existing framebuffer:
- AO = 1.0 → No change (fully lit)
- AO = 0.5 → 50% darkening
- AO = 0.0 → Full black (fully occluded)

---

## Additive Blending for Bloom

To brighten the scene with bloom glow:

```javascript
compositeMaterial = new THREE.ShaderMaterial({
    // ...
    transparent: true,
    blending: THREE.AdditiveBlending
});
```

The shader outputs bloom color values which add to the existing framebuffer:
- Bloom = (0,0,0) → No change
- Bloom = (0.5,0.3,0.1) → Warm glow added to scene

---

## Circular Dependency Prevention

The module import order matters. Avoid circular dependencies by:

1. **Don't import post-processing modules in vid.js directly**

   Instead, use a callback system:
   ```javascript
   // In vid.js
   const _resizeCallbacks = [];
   export function VID_AddResizeCallback(callback) {
       _resizeCallbacks.push(callback);
   }

   // In resize handler
   for (const cb of _resizeCallbacks) {
       cb(canvas.width, canvas.height);
   }
   ```

2. **Register callbacks during init**
   ```javascript
   // In gl_gtao.js GTAO_Init()
   VID_AddResizeCallback(GTAO_Resize);
   ```

**Problematic chain to avoid:**
```
vid.js → gl_gtao.js → gl_rmain.js → render.js → vid.js  ❌ CIRCULAR
```

---

## Custom Depth/Normal Materials

Three.js built-in `MeshDepthMaterial` and `MeshNormalMaterial` don't output what GTAO expects. Use custom shaders:

### Linear Depth Material

```glsl
// Vertex
varying float vViewZ;
void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewZ = -mvPosition.z;  // Negate because view space Z is negative
    gl_Position = projectionMatrix * mvPosition;
}

// Fragment
varying float vViewZ;
uniform float cameraNear;
uniform float cameraFar;
void main() {
    float linearDepth = (vViewZ - cameraNear) / (cameraFar - cameraNear);
    linearDepth = clamp(linearDepth, 0.0, 1.0);
    gl_FragColor = vec4(linearDepth, linearDepth, linearDepth, 1.0);
}
```

### View-Space Normal Material

```glsl
// Vertex
varying vec3 vViewNormal;
void main() {
    vViewNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}

// Fragment
varying vec3 vViewNormal;
void main() {
    vec3 normal = normalize(vViewNormal);
    gl_FragColor = vec4(normal * 0.5 + 0.5, 1.0);  // Pack to 0-1 range
}
```

---

## Position Reconstruction from Depth

To reconstruct view-space position from linear depth:

```glsl
vec3 getViewPosition(vec2 uv, float linearDepth) {
    // Convert linear depth back to view-space Z
    float viewZ = linearDepth * (cameraFar - cameraNear) + cameraNear;

    // UV (0-1) -> NDC (-1 to 1)
    vec2 ndc = uv * 2.0 - 1.0;

    // Get ray direction using inverse projection
    vec4 clipPos = vec4(ndc, 0.0, 1.0);
    vec4 viewRay = cameraInverseProjectionMatrix * clipPos;
    viewRay.xyz /= viewRay.w;

    // Scale ray by depth
    vec3 viewPos = viewRay.xyz * (viewZ / -viewRay.z);
    return viewPos;
}
```

---

## Console Variables (Cvars)

### Defining

```javascript
// In gl_rmain.js
import { cvar_t } from './cvar.js';

export const cg_hq_ao = new cvar_t('cg_hq_ao', '0', true);  // archived
export const cg_hq_ao_radius = new cvar_t('cg_hq_ao_radius', '2.0', true);
```

### Registering

```javascript
// In gl_rmisc.js R_Init()
import { cg_hq_ao, cg_hq_ao_radius } from './gl_rmain.js';

_Cvar_RegisterVariable(cg_hq_ao);
_Cvar_RegisterVariable(cg_hq_ao_radius);
```

### Using

```javascript
if (cg_hq_ao.value !== 0) {
    GTAO_Apply();
}
```

### Console Commands

```
cg_hq_ao 1              // Enable GTAO
cg_hq_ao_radius 3.0     // Set AO radius
cg_hq_ao_intensity 2.0  // Set AO strength
cg_hq 2                 // Enable via bitmask (bit 1 = AO)
```

---

## TypeScript Checking

Run syntax validation:
```bash
bun run check        # One-time check
bun run check:watch  # Watch mode
```

Note: Many pre-existing type errors exist in the codebase. Focus on errors in files you modified.

---

## Debugging Checklist

When a post-process effect shows black screen:

1. **Check shader compilation** - Look for WebGL errors in console
2. **Check reserved uniform names** - Rename any that conflict with Three.js
3. **Test with solid color output** - Add `gl_FragColor = vec4(0.5, 0.5, 0.5, 1.0); return;`
4. **Check texture sampling** - Use debug mode to visualize depth/normals
5. **Check render target setup** - Verify textures are created and passed correctly
6. **Check autoClear** - Ensure it's disabled when compositing
7. **Check blending mode** - Ensure material has correct blending settings

---

## Performance Tips

1. Render G-buffers (depth, normals) at full resolution for quality
2. AO can be computed at half resolution if needed
3. Use bilateral blur (depth-aware) to smooth AO without losing edges
4. Temporal reprojection can reduce noise (not yet implemented)
5. Skip AO for sky pixels (depth > 0.99)
