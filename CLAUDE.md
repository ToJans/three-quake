# Three-Quake Project Notes

## Testing in Browser

When the game is running in the browser, you can execute console commands programmatically:

```javascript
// Execute a console command
window.Cbuf_AddText("command_name value\n");

// Examples:
window.Cbuf_AddText("cg_hq_ao_debug 4\n");  // Show raw AO buffer
window.Cbuf_AddText("cg_hq_ao_debug 0\n");  // Normal mode
window.Cbuf_AddText("map e1m1\n");          // Load a map
```

## Development Server

```bash
bun run dev  # Starts server on http://localhost:8080
```

## Postprocessing Debug Modes

`cg_hq_ao_debug` values:
- 0 = Normal (blended AO)
- 2 = Show depth buffer
- 3 = Show normal buffer
- 4 = Show raw AO
- 5 = Show denoised AO

## Postprocessing CVars

Enable/disable effects:
- `cg_hq` - Bitmask: 1=SSR, 2=AO, 4=Bloom, 8=Tonemapping (15=all)
- `cg_hq_ssr` - Screen-space reflections (0/1) **CURRENTLY DISABLED**
- `cg_hq_ao` - Ambient occlusion (0/1)
- `cg_hq_bloom` - Bloom effect (0/1)
- `cg_hq_tonemapping` - Tonemapping (0/1)

**Note:** SSR is currently disabled due to incompatibility with Quake's custom camera matrix setup. Both Three.js SSRPass (requires groundReflector) and the custom gl_ssr.js have issues with the non-standard camera configuration.

AO parameters:
- `cg_hq_ao_radius` - Sampling radius in Quake units (default: 80)
- `cg_hq_ao_intensity` - AO strength (default: 1.0)

Bloom parameters:
- `cg_hq_bloom_threshold` - Brightness threshold (default: 0.15)
- `cg_hq_bloom_intensity` - Bloom strength (default: 0.7)
- `cg_hq_bloom_radius` - Blur radius (default: 0.3)

Tonemapping parameters:
- `cg_hq_tonemapping_operator` - 0=ACES, 1=Reinhard, 2=Cineon, 3=AgX, 4=Neutral
- `cg_hq_tonemapping_exposure` - Exposure value (default: 3)
