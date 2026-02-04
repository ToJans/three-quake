# Three-Quake Project Notes

## Testing in Browser

When the game is running in the browser, you can execute console commands programmatically:

```javascript
// Execute a console command
window.Cbuf_AddText("command_name value\n");

// Examples:
window.Cbuf_AddText("cg_hq_bloom 1\n");  // Enable bloom
window.Cbuf_AddText("map e1m1\n");       // Load a map
```

## Development Server

```bash
bun run dev  # Starts server on http://localhost:8080
```

## Postprocessing CVars

Enable/disable effects:
- `cg_hq` - Bitmask: 4=Bloom, 8=Tonemapping (12=both, default)
- `cg_hq_bloom` - Bloom effect (0/1)
- `cg_hq_tonemapping` - Tonemapping (0/1)

Bloom parameters:
- `cg_hq_bloom_threshold` - Brightness threshold (default: 0.15)
- `cg_hq_bloom_intensity` - Bloom strength (default: 0.7)
- `cg_hq_bloom_radius` - Blur radius (default: 0.3)

Tonemapping parameters:
- `cg_hq_tonemapping_operator` - 0=ACES, 1=Reinhard, 2=Cineon, 3=AgX, 4=Neutral
- `cg_hq_tonemapping_exposure` - Exposure value (default: 3)

## Light Probe System

Entity lighting uses spherical harmonics (L1 SH) probes placed at BSP leaf centroids.
Probes capture colored directional lighting from the world and apply it to entities.

### CVars

| CVar | Default | Description |
|------|---------|-------------|
| `r_lightprobes` | 1 | Enable/disable light probe system (0/1) |
| `r_lightprobes_quality` | 2 | Ray quality: 0=low (6 rays), 1=medium (26 rays), 2=high (66 rays) |
| `r_lightprobes_samples` | 4 | Sample positions per probe (1-8, higher=smoother but slower bake) |

### Features

- **One probe per BSP leaf** - O(1) lookup via Mod_PointInLeaf
- **L1 Spherical Harmonics** - 4 coefficients per RGB channel = 12 floats per probe
- **Multi-sample baking** - Samples from multiple positions within each leaf for smoother results
- **High-quality ray sampling** - Up to 66 uniformly distributed directions (icosphere-based)
- **Animated lightstyle support** - Flickering lights affect entities in real-time
- **Colored lighting from liquids**:
  - **Lava**: Orange-red glow (RGB: 1.0, 0.4, 0.1)
  - **Slime**: Bright green glow (RGB: 0.2, 0.9, 0.3)
  - **Water**: Subtle blue tint (RGB: 0.3, 0.5, 0.8)
  - **Teleporter**: Purple glow (RGB: 0.8, 0.4, 1.0)
- **Viewmodel lighting** - Weapon uses player's view origin for consistent lighting

### Testing Colored Lighting

Maps with lava/slime for testing:
- `e1m1` - Has slime pool near the start
- `e1m5` - "Gloom Keep" has lava areas
- `e2m6` - "The Dismal Oubliette" has slime
- `e3m5` - "Wind Tunnels" has lava
- `e4m1` - "The Sewage System" has slime

Stand near lava or slime and watch your weapon tint orange/green.

### Performance Tuning

For faster map loads, reduce quality:
```
r_lightprobes_quality 0   // Fast: 6 rays per sample
r_lightprobes_samples 1   // Fast: single sample per probe
```

For best quality:
```
r_lightprobes_quality 2   // Best: 66 rays per sample
r_lightprobes_samples 8   // Best: 8 samples per probe
```

## Texture Enhancement System

xBRZ pixel art upscaling with 5x5 kernel and optional PBR map generation.

**Full documentation with comparison screenshots:** [docs/texture-enhancement.md](docs/texture-enhancement.md)

### CVars

| CVar | Default | Description |
|------|---------|-------------|
| `r_tex_upscale` | 0 | Texture upscaling: 0=off, 1=2x, 2=4x |
| `r_tex_pbr` | 0 | PBR maps (normal/roughness): 0=off, 1=on |

### Quick Start

```
r_tex_upscale 2    // 4x upscale for best quality
map e1m1           // Reload map
```

### Memory Usage

| Setting | Memory | Description |
|---------|--------|-------------|
| Off | ~2 MB | Original textures |
| 2x | ~8 MB | Smoother edges |
| 4x | ~32 MB | Maximum smoothness |
| 4x + PBR | ~96 MB | Full enhancement |

Check usage: `window.getTextureMemoryStats()`
