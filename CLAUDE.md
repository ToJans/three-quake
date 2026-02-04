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
