# Batch 77 reuse audit

Job 1 landed as `0fd6733f5` (`@margoengine/creative/targets`). This audit records the remaining jobs in order; the batch stays open until all five are handled.

## Job 2: grass on terrain - SKIPPED

Already provided by `@margoengine/scatter`: `Scatter.attach` accepts a heightmap, densityMap and explicit world bounds, with blade shading and wind. The distribute kernel bilinearly samples height and rejects candidates against the density map. `@margoengine/scatter/paint` supplies editable density textures. Reuse these entries rather than adding a second terrain-grass implementation to creative's flat `GrassField`.

Evidence inspected: `packages/scatter/src/index.ts` (`ScatterOptions`, `scatterCullShader`, `Scatter`), `packages/scatter/README.md` (Density maps), `packages/scatter/test/scatter.test.js`, `packages/scatter/test/lod.browser.mjs` (GPU height interpolation), and `packages/scatter/test/paint.test.js`. Scatter rejects native WebGL2 with a coded `unsupported` error; device restoration rebuilds its resources. Existing limits, claims and clean-room records remain those of scatter; this audit adds no rendering or speed claim, API, shader or size growth.

Docs: this audit only. No package README, operational playbook, limits, known-bugs or whitepaper changes are needed for an existing feature. The final job records the batch in the build record.

## Job 3: grass interaction - SKIPPED

Already provided by `@margoengine/scatter/interact`, landed as `67b6324ea`: `TrampledScatter.setInteractors` accepts radial pushes for players and vehicles. A one-frame interactor supplies a radial explosion impulse; remove it on the next frame and the field recovers. Colour, shadow and shadow-cull poses read the same field. Reuse this entry rather than adding a second interaction field to creative.

Evidence inspected: the exports and README, `packages/scatter/src/interact.ts`, `packages/scatter/test/interact.test.js` and `packages/scatter/test/interact.browser.mjs`. The GPU suite asserts every stamped field cell, exponential recovery, camera-follow remapping, changed bent pixels and exact restoration of upright pixels. Limits remain scatter's documented flat XZ field, bounded camera-centred coverage and up to 4,096 interactors; this is a visual radial push, not a physical blast simulation.

Docs: this audit and generated LLMS index only; existing scatter documentation, limits, claims and clean-room records own the implementation. No new API, rendering, performance or backend claim is added.

Audit repair: a separate scatter fix validates GPU float conversion and sparse inputs, keeps a rejected update atomic,
and prevents signed 32-bit camera-shift wrap. Three parent-failing unit regressions and the real-GPU teleport assertion
cover the causes. Its docs are in scatter's README, limits, known-bugs, the operational playbook and claim LIM-604.
