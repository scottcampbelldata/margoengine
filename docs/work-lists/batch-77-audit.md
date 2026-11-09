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

## Job 4: grass chunks and LOD - SKIPPED

The all-packages search found the full composition already present: procedural generateGrassMesh makes crossed
tapered ribbon clumps (7/3/1 blades for three levels), and scatter/tiles streams those meshes as 8-byte records in
page allocations, with distance-selected LOD, fades, heightmaps, wind and blade shading. No new creative/grass
implementation is needed. radialPlacements also exists for clustered anchors, but is unnecessary for mesh clumps.

Evidence: packages/procedural/src/foliage.ts, its foliage.test.js, scatter/src/tiles.ts, scatter/test/tiles.test.js
and the existing lod.browser.mjs pixel/fade tests. A new grass-tiles.browser.mjs composition check on RTX A6000
asserts every selected ring count, tile add/remove and device restoration, compiles all shaders and checks native
WebGL2's coded refusal. Generated fixtures are stand-ins; no huge-area speed or artistic claim is made. Existing
capacity and GPU binding limits apply. The audit found input/alignment defects, fixed in a separate scatter commit
with two parent-failing regressions. Docs: scatter README, limits, known-bugs, operational playbook and this audit;
existing scatter claims/clean-room records own the implementation, with no new public feature claim.

## Job 5: painterly post effects - DONE

An all-packages search for Kuwahara, watercolour/watercolor, painterly, pencil and sketch found no implementation
before coding (6,230 files searched). New optional creative/paint exports Painterly and option/mode types, absent
from the creative root; the generated umbrella aliases it. Classic minimum-variance quadrants, a quantized wash
and Sobel/hatching sketch work in an LDR PostStack. Papers and scope distinctions are recorded in clean-room.md.
Docs: creative README, clean-room, limits, known-bugs, operational section 5, claims LIM-619, reproduce and build-record.
No speed claim, so perf-history and rival-speed files need no change. Physics remains on hold.
