# Everything integration test pages

J6 composes public calls from package READMEs in `examples/integration/`, with entry pages under
`examples/test-pages/`. These are test pages. No package implementation or private CAD API is imported.
The build phase defers README edits and Works with lines to `docs/work-lists/readme-owed.md`.

Run `npm run build:packages`, then `npm run test:integration:browser -- --scene=game`.
The runner takes one shared GPU slot, with a 150 second limit per scene and a 60 second pipeline readiness limit.
`check:gpu-packages` includes it, so check:merge selects it from each page's import footprint.
`npm run check:examples-types -- --projects=integration-game` checks its own TypeScript project.
Results go to `test-results/integration-game.json`. This suite has no speed assertion.

The game composes gltf, gltf-pro, animation, physics, navmesh, shadows, post, audio, input, controls, ui and save.
It uses the Margo-authored tentacle rig, a clean-room static triangle, a falling rigid body, a moving crowd agent,
positional audio, a health meter and a save round trip. The calls are from the first examples in those READMEs
(post uses its PostStack example, ui its meter API). The harness supplies deterministic frame deltas and teardown.
The rig is sought to half a second and paused so device restoration can compare identical scene state.
Pixels are sampled at four named coordinates before and after a destroyed device is replaced, requiring exact
RGBA equality and the same nonzero draw count. Feature assertions are rerun after loss. The resource ledger counts
buffers, textures and query sets on every created device. Explicit resource destruction or owning-device destruction
releases them; it checks zero live allocations, engine meshes and plugins after disposal. This does not claim
JavaScript heap collection or browser-internal memory accounting.

## Clean-room sources

- W3C GPU for the Web Working Group, *WebGPU*, 2026, sections on device loss and resource destruction:
  https://www.w3.org/TR/webgpu/ . Device loss requires replacement; destroy predictably releases device resources.
- Khronos WebGL Working Group, *WebGL Specification*, 2026 living specification:
  https://registry.khronos.org/webgl/specs/latest/1.0/ . Context restoration requires recreating graphics state.
- Khronos WebGL Working Group, *WEBGL_lose_context*, 2018 ratified extension:
  https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/ . Distinguishes loss and restoration events.
- Khronos 3D Formats Working Group, *glTF 2.0 Specification*, 2017, updated 2026:
  https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html . Fixtures use glTF units, +Y up and accessor layout.

These standards inform the shared loss/lifetime test rather than introducing another renderer or animation algorithm.
No companion implementation was consulted. README snippets are composed within this repository only.

The existing example-selection regression used cameras as a narrow fixture after its affected workspace count
grew to 14, above the existing 12-package safety threshold. It now proves the same narrow selection with sciviz
and additionally asserts the correct full selection for cameras; the threshold and selection code are unchanged.

The scientific dashboard scene is documented in [integration-sciviz.md](integration-sciviz.md); run with --scene=sciviz. It composes sciviz, points, lines, labels, compute, loaders, video and html on the same engine.
