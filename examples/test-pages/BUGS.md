# Test-page bug index

The pages in this folder use Margo like a real user, through public APIs only. They found the bugs below on
2026-11-09. Each was checked again against main on 2026-11-11. The full review, with the regression test for each
fix, is in [docs/testpage-bugs.md](../../docs/testpage-bugs.md).

Run the pages with `npm run test:pages:browser` (native WebGPU) and `MARGO_COMPAT=1 npm run test:pages:browser`
(the WebGL2 layer). A page fails on an uncaught error, a rejected promise, a console error or a console warning that
says BUG. A bug that is still open is listed in `KNOWN` in [scripts/test-pages-browser.mjs](../../scripts/test-pages-browser.mjs)
with its KB id from [docs/known-bugs.md](../../docs/known-bugs.md). The run reports it as a known failure and fails
when that bug no longer shows, so its entry gets removed.

Open bugs: none. Every entry was fixed, is intended and documented, or was a wrong report.

| Entry | Package | Result |
| --- | --- | --- |
| 1 | road | Fixed: closed roads meet exactly (b9985bd07a) |
| 2 | road | Intended: vertical tangents reject with code `unsupported` (road README) |
| 3 | road | Fixed: `bankedRoad` in `@margoengine/road/banking` |
| 4 | road, core | Intended: core `Geometry` has no UV channel; `uvs` is separate data (road README) |
| 5 | road | Fixed: `junctions` in `@margoengine/road/junctions` |
| 6 | road | Fixed: inside offsets no longer fold at hairpins; a cusp rejects with a coded error (d351cdae1a) |
| 7 | procedural | Fixed: SDF bounds come from the shape tree (6b68b4b603) |
| 8 | procedural | Fixed: SDF meshes have normals (dc82fd487a) |
| 9 | procedural | Fixed: the texture baker runs on WebGL2 when given the engine (fd18e1461f) |
| 10 | procedural | Fixed: `generateCabinMesh` returns `{ floorElevation, parts }` (25e163a3fc) |
| 11 | water | Intended: folding waves reject with code `failed`, never clamped (water README) |
| 12 | core | Fixed: an empty `Geometry` is valid (943a224c64) |
| 13 | wfc | Fixed: `solve` takes `{ signal }` (7de74004a6); it is synchronous, so use the worker to cancel mid solve |
| 14 | voxel-edit | Fixed: `push`, `undo` and `redo` all return the grid (5f0d78af92) |
| 15 | selection | Wrong report: the preview renderer refuses `Selection` at setup with code `unsupported`; the WebGL2 layer draws it |
| 16 | animator | Fixed: foot IK accepts ancestor chains (9aa62906d6); a disconnected chain still rejects by design |
| 17 | gltf/pbr | Wrong report: the preview refuses `PBRModel` at setup; the WebGL2 layer draws it |
| 18 | animation | Fixed: `setMorph(name, weight)` and a morph error that lists the mesh nodes (845652f4f2) |
| 19 | animation | Fixed: the unnamed clip name is documented (16a3a4fb2e) |
| 20 | environment | Fixed: a disposed environment leaves its scene (920e758634, 0e2f1e61cb) |
| 21, 22, 26, 29, 30, 31, 33 | post, shadows, video, vfx, splats, lighting2d, pixel, culling | Intended: the small preview renderer refuses with code `unsupported` at setup; the full WebGL2 layer draws them (webgl2-compat README, "Choosing a tier explicitly") |
| 25 | transitions | Fixed: dispose detaches from the owning scene (1823a741e8) |
| 27 | webgl2-compat | Intended: `install()` keeps WebGPU unless given `{ force: true }` (webgl2-compat README) |
| 28 | core | Intended: `backend: 'webgl2'` needs `fallback: webglRenderer` (webgl2-compat README) |
| 32 | labels | Intended: `Label.position` is getter-only; use `setPosition` (labels README) |
| 34 | netcode | Fixed: joining players count once against `maxPlayers` (b40570dc64) |
| 35, 38 | webgl2-compat, tilemap, viewcube | Wrong report: a stale local build; the package build emits every export |
| 36 | core | Fixed: assigning a transform ref throws code `transform` (1dbb3bec8b) |
| 37 | inspector | Fixed: range inputs start with a value (d4d5841d8e) |
| 39 | tiles | Fixed: a relative tileset URL resolves against the page (1c2b04bcf1) |
| 40 | viewcube | Not reproduced after a rebuild |
| 41 | labels | Fixed: a second renderer of the same name gets a clear error (222c8abdfe) |
| 42 | exporters | Wrong report: the exporters already reject incomplete triangles |
| 43 | exporters | Intended: `exportUSDZ` is the `@margoengine/exporters/usdz` entry (exporters README) |
| 44 | mesh-edit | Fixed: bevel splits warped faces (f4dc6d8e57) |
| 45 | voxel-pathtracer | Fixed: the staged WebGL2 trace route (a920a7fe45); known-bugs "Fixed: test-page 45" |

Entries 23 (`Materials.set` without predefined buffers) and 24 (mask transition name collisions) were lost from this log before it was imported; docs/testpage-bugs.md names them and they still need a repro.
