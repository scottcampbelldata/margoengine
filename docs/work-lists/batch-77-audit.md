# Batch 77 reuse audit

Job 1 landed as `0fd6733f5` (`@margoengine/creative/targets`). This audit records the remaining jobs in order; the batch stays open until all five are handled.

## Job 2: grass on terrain - SKIPPED

Already provided by `@margoengine/scatter`: `Scatter.attach` accepts a heightmap, densityMap and explicit world bounds, with blade shading and wind. The distribute kernel bilinearly samples height and rejects candidates against the density map. `@margoengine/scatter/paint` supplies editable density textures. Reuse these entries rather than adding a second terrain-grass implementation to creative's flat `GrassField`.

Evidence inspected: `packages/scatter/src/index.ts` (`ScatterOptions`, `scatterCullShader`, `Scatter`), `packages/scatter/README.md` (Density maps), `packages/scatter/test/scatter.test.js`, `packages/scatter/test/lod.browser.mjs` (GPU height interpolation), and `packages/scatter/test/paint.test.js`. Scatter rejects native WebGL2 with a coded `unsupported` error; device restoration rebuilds its resources. Existing limits, claims and clean-room records remain those of scatter; this audit adds no rendering or speed claim, API, shader or size growth.

Docs: this audit only. No package README, operational playbook, limits, known-bugs or whitepaper changes are needed for an existing feature. The final job records the batch in the build record.
