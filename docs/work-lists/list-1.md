# Work list 1

Stays with the first account, the manager session. Listed so the other accounts know what not to touch.

**Stream P, own physics:** batches 122 to 131, then the physics parity batches 138 to 146 and the physics beyond batches 147 to 158 (Scott, 2026-11-07; tracking file `docs/rapier-parity.md`). Done: 122 to 126. Order: 127, 128, 138 to 143, 129, 130, 131, 144 to 146, 147 to 158. Owns `packages/physics`, `packages/physics2d` and their kernels.

**Stream G, gaps:** the open gap list and the ragdoll items. Owns `packages/ragdoll` until they finish.

**Stream C, game logic and links:** finish batch 88, then 89, 93, 94 (fsm, navmesh, behavior), 113, 114, 115 (net, netcode, save), 116 to 119 (xr, react, sciviz, mcp).

**Taken from list 2 (Scott, 2026-11-08):** batches 78 and 79 (vfx) and 100 to 103 (sprites, tilemap, pixel, text). Mark each `done` in `list-2.md` in the same push as its last job.

**Finishing batches 44 and 49:** usdz and shadows, already running here.

**Best-packages program (Scott, 2026-11-08):** measure each package against its best rival, list every loss, then fix the losses. 159 refresh the speed matrix and diagnose the undiagnosed rows. 160 rendering correctness against black-box reference renders. 167 rival measurements for behavior, navmesh, ecs, fsm, tween, netcode, save, compute and sciviz. 168 splats, tiles, points, lightmap, oit, sky and staging. 169 ui, text, mesh-edit, splines, terrain, wfc and procedural. 161 animation CPU losses. 162 geometry, math and raycast. 163 points, lines, sprites and data textures. 166 the GPU-driven instancing gap. 164 post and tone map pass structure, after batches 70 to 73. 165 loaders, decoders and exporters, after batches 133 to 137. 170 controls, audio, react, worker, stats, cache, blender and vfx. Order: 159, 160, 167, 168, 169, 161, 162, 163, 166, 164, 165, 170, then 132.

**After every list is done, in this order:** batch 120 kit packages, AVIF decoder, app origin check, batches 133, 134, 136, 137 clean-room codecs, batch 121 second pass, batch 132 research and quality audit, leftovers of batches 19 and 21, then npm and PyPI only on Scott's word.
