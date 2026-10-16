# Large coordinates: precision far from the origin

Plant layouts, BIM and GIS scenes put parts kilometres (or, in Earth-centred coordinates, 6,000 km) from the world
origin. Core and its Rust/Wasm transform kernel store positions and matrices in float32, whose spacing is 61 µm at
1 km, 7.8 mm at 100 km and 0.5 m at 6,000 km. At millimetre zoom that shows as parts shaking while the camera moves,
small features collapsing, and lighting going wrong. This page measures where precision is lost, and what
`FloatingOrigin` (`@margoengine/cameras/origin`, 0 core bytes) fixes.

## Test scene

`examples/package-benchmarks/large-coordinates-scene.js`: a 10 mm flange (annulus R 5 mm / r 2 mm, 2 mm thick, rotated)
with four 1 mm bolt heads as child meshes, placed at `distance × [0.48, 0.6, 0.64] + [0.123456, 0.654321, 0.314159]`
metres (the sub-metre part keeps coordinates from being float32-exact round numbers, as real survey coordinates are
not). The camera starts 50 mm away (fov 50°, near 1 mm) and for 40 frames orbits 0.25° and dollies 0.2% per frame. At
50 mm one pixel of the 640×360 view is 0.13 mm, so a 1 mm bolt is ~8 px wide.

## Where precision is lost (CPU, Node)

`node examples/package-benchmarks/large-coordinates.mjs` runs the real core (kernel world matrices, `Camera.matrix`) on
a fake WebGPU device, emulates the vertex shader in float32 (`Math.fround` after every operation) and compares each
vertex with a float64 projection. Each stage is also rounded on its own with everything else in float64. Max error
over all vertices and frames, in pixels; jitter is the largest frame-to-frame change of a vertex's error (what the
eye sees as shaking). Results: `examples/package-benchmarks/results/large-coordinates.json`.

| Distance | Kernel world matrix | View-projection matrix | Vertex world position | Clip arithmetic | All (GPU path) | Jitter | Eye (lighting) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ~0 m | 0.0003 | 0.0003 | 0.0002 | 0.000003 | 0.001 | 0.0008 | 0.00004° |
| 1 km | 0.37 | 0.31 | 0.33 | 0.000003 | 0.88 | 0.71 | 0.05° |
| 100 km | 43 | 29 | 21 | 0.000003 | 99 | 60 | 2.8° |
| 6,000 km | 545 | 6×10⁸ | 1,620 | 0.000003 | collapsed | collapsed | 72° |

- **Kernel world matrix** (`store.matrices`, the per-instance model matrix): the root translation is rounded to the
  float32 grid, and child matrices are composed in float64 but stored in float32, so the 1 mm bolts snap to the grid
  (at 6,000 km the two bolts 7 mm apart land on the same grid point, 0 mm apart in world space; machinery `measureDistance` composes the hierarchy in float64 below the common ancestor since HANDOFF 5l.d and still reads 7 mm; `packages/cameras/test/origin.test.js`). Mostly a
  static misplacement, not jitter.
- **View-projection matrix** (`camera.matrix`, float64 in `Camera.update`, stored float32): its translation column holds
  eye-distance terms of the size of the coordinates, so rounding changes every frame as the camera moves. This is the
  main source of jitter and, at 6,000 km, of total failure (vertices end up behind the eye, w ≤ 0).
- **Vertex world position** (`model * position` in the vertex shader): rounding the sum of a huge translation and a
  millimetre offset; the shape distorts.
- **Clip arithmetic** (`camera * p` once both are given): negligible.
- **Eye** (`frame.eye`, the float32 camera position used for specular): the view direction from the part is off by
  that angle (72° at 6,000 km: highlights are random).

The camera position itself is float64 in JS; precision is lost where it reaches float32 (the view-projection matrix
and `frame.eye`).

## The plugin

`FloatingOrigin` keeps float64 world positions of root meshes (and gltf-pro `model.root`) on the CPU and writes them to
core relative to an origin near the camera. When the camera is farther from the origin than `ratio` × its distance to
the target (default 1000, so 50 m at 50 mm zoom), the origin moves to the camera: camera, placed roots and any running
`fitToBoundingBox` animation shift by the same float64 amount, so nothing moves on screen. API and usage:
`packages/cameras/README.md`.

With it, every float32 value core sees is at most ~ratio × view distance in size. Same measurement, with the plugin
(`origin`), and with the origin deliberately put 49.5 m away, just inside the default threshold (`origin-edge`, the
worst case before a rebase):

| Distance | Core alone: all / jitter (px) | Plugin: all / jitter (px) | Plugin, worst case: all / jitter (px) | Eye, worst case |
| --- | --- | --- | --- | --- |
| ~0 m | 0.001 / 0.0008 | 0.001 / 0.0008 | 0.055 / 0.048 | 0.002° |
| 1 km | 0.88 / 0.71 | 0.00004 / 0.00004 | 0.055 / 0.048 | 0.002° |
| 100 km | 99 / 60 | 0.00004 / 0.00004 | 0.055 / 0.048 | 0.002° |
| 6,000 km | collapsed | 0.00004 / 0.00003 | 0.055 / 0.049 | 0.002° |

The worst case does not depend on the distance from the world origin, only on `ratio`: jitter ≈ 0.05 px × ratio /
1000. A smaller ratio rebases more often for the same view.

## Real GPU

`node examples/package-benchmarks/large-coordinates-gpu.mjs` (Intel Xe2 / Arc 140V, Edge 155, 640×360, 4× MSAA; AC
before and after, GPU lock held) renders the same 40-frame orbit + dolly for the flange as core meshes and as a gltf-pro
model (gltf-pro PBR shading), at each distance, with and without the plugin. Every frame is compared with the same
kind rendered by core near the origin: silhouette centroid offset (sub-pixel), pixels whose coverage differs (XOR of
the masks) and mean colour difference (0-255). Jitter = largest frame-to-frame change of the centroid offset. The pick
is `engine.pick` on a pixel inside the reference silhouette (core meshes: plain `engine.pick`; gltf-pro: selection's
`Picking` plugin). Results: `examples/package-benchmarks/results/large-coordinates-gpu.json`; frame 0 images in
`test-results/large-coordinates-*.png`.

| Distance | Core alone: offset / jitter (px) | XOR px (of ~3,940) | Colour | Pick | Plugin: offset / jitter (px) | XOR px | Colour | Pick |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ~0 m | 0 / 0 | 0 | 0 | flange | 0 / 0 | 0 | 0 | flange |
| 1 km | 0.25 / 0.38 | 55 | 0.03 | flange | 0.009 / 0.019 | 1 | 0 | flange |
| 100 km | 58 / 42 | 8,350 (smeared to 6,507 px) | 3.1 | flange | 0.009 / 0.019 | 1 | 0 | flange |
| 6,000 km | flange gone (0 px drawn) | 3,941 | 1.4 | none | 0.009 / 0.019 | 1 | 0 | flange |

The gltf-pro model gives the same numbers to within 0.02 px (1 km: 0.248 / 0.359; 100 km: 57.6 / 42.5; colour
difference up to 4.3 at 100 km from its specular). With the plugin the residual is one pixel of edge coverage and
0.02 px of centroid movement, the same at 1 km and 6,000 km, because after the first rebase the scene core sees is
identical. The GPU agrees with the CPU emulation: ~0.4 px of jitter at 1 km (CPU: 0.7 px for the worst single vertex),
tens of pixels at 100 km, nothing usable at 6,000 km.

## Rebase cost

A rebase rewrites every placed root's position (one pass over a Map, float64 → float32). The kernel then sees every
root as changed (its dirty-skip compares input bits) and recomputes all of them and their descendants. Core patches the
moved matrices of the visible instances and uploads that range once. The next frames are static again. Parts are
0.5 m boxes on a 2 km grid 100 km out, camera 50 m from the centre (675 / 3,500 visible).

Node (`large-coordinates.mjs --cost`: real kernel and engine, fake GPU device; `scripts/quiet-gate.mjs` passed first),
median of 15:

| Placed roots | Static frame | `rebase()` call | Frame after the rebase | Upload | For comparison: every root moved via `mesh.position` + frame |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 0.35 ms | 0.77 ms | 1.47 ms | 65 kB | 1.98 ms |
| 50,000 | 1.62 ms | 4.26 ms | 7.13 ms | 336 kB | 11.1 ms |

Real GPU (`large-coordinates-gpu.mjs --cost`, Arc 140V; wall time of `engine.render()` + `onSubmittedWorkDone`,
browser timer ~0.1 ms). The quiet gate passed before the run waited for the GPU lock, so treat these as
semi-diagnostic:

| Placed roots | Static frame | `rebase()` call | Frame after the rebase |
| --- | --- | --- | --- |
| 10,000 | 4.7 ms | 0.6 ms | 6.1 ms |
| 50,000 | 5.4 ms | 4.4 ms | 11 ms |

So a rebase at 50k parts is a single ~10 ms hitch. Rebases are rare: with the default ratio the camera has to travel
1,000 × its view distance (50 m at 50 mm zoom; 50 km when viewing from 50 m). Orbiting and panning around a
target almost never rebase; zooming in on a spot far from the current origin triggers one.

## What works, what doesn't

Works (unit-tested in `packages/cameras/test/origin.test.js` on the real kernel, or on the GPU above):

- Core meshes and their children; gltf-pro models (`origin.place(model.root, world)`), and so materials meshes and
  anything else parented to a placed root.
- `CADCameraControls`, `OrbitControls` (and every control that reads `camera.position`/`target` each update): rebases
  happen between frames and shift the camera, so orbit, pan and dolly continue seamlessly.
- `engine.pick` (GPU run above) and bvh `Raycaster` hits (unit test): computed in local coordinates;
  `origin.toWorld(hit.point)` gives float64 world (within 1 µm at 6,000 km in the test). The selection `Picking`
  plugin reads the same matrices (not separately tested).
- machinery measurements (`measureDistance` and anchors): differences of local points, exact (7 mm bolt spacing at
  6,000 km: 7.0000002 mm with the plugin, 0 mm without).
- Section planes: pass `origin.toLocalPlane(worldPlane)` and refresh it in `onRebase`.
- Parts moved through `mesh.position` (drag/transform gizmos, physics): read back on the next rebase.

Doesn't (or needs app code):

- **Huge geometry or child offsets.** Vertex positions and child (node) translations that are themselves kilometres
  from their root are float32 in core when loaded; the plugin cannot recover precision lost at load. Re-centre the
  asset (most IFC/glTF exporters have a local-origin or RTC option) or load far parts as separate roots. A gltf-pro or
  loader option that subtracts an offset at parse time would fix it without core.
- **State held in local coordinates by other code**: OrbitControls `saveState()`/`reset()`, an orthographic
  `CameraProjection.fit` animation in flight, your own saved views or section planes. Shift them in `onRebase` (or
  re-derive them from world values with `toLocal`/`toLocalPlane`).
- **Very large views of very far scenes.** Precision is relative to the view distance, so zoomed-out views are fine;
  but a single frame that shows millimetre detail next to a part 1,000 × the view distance away renders that far part
  with float32 error proportional to its distance (as any renderer does).
- `dispose()` stops tracking and leaves the scene in local coordinates.

## Does core need a change?

No. With the plugin the whole path stays under 0.06 px (jitter under 0.05 px), even in the worst case just before a rebase, and core does not
change (core + stage stays 19,577 B gzip). The plugin uses only existing core surface: `onPreUpdate` (runs before the
camera matrix and kernel tick) and the kernel's position columns (`store.transforms.x/y/z`, written the way
`mesh.position` writes them; the kernel's dirty check picks up the change). One fragile point: a running
`fitToBoundingBox` animation is private core state, which the plugin finds by its keys (`fromTarget`), since property
names are mangled in `dist`. A unit test fails if that ever stops working.

What core alone could do, and why it is not needed here. Relative-to-eye rendering in core (subtract the eye in
float64 before writing each instance's translation, and build the view-projection with a zero eye) would remove the
view-projection and vertex world-position errors with no app code. But it cannot fix the kernel stage: positions are
already float32 in `store.transforms` (0.5 m grid at 6,000 km; the 7 mm bolts still share one world position). It would also
need float64 position columns in the Rust/Wasm kernel, which changes the memory layout and the `store.transforms`
types. And `store.matrices` would become eye-relative, which breaks every package that reads world matrices from it
(gltf-pro, bvh, selection, shadows, machinery, staging, taa and others). Byte cost was not measured on a scratch
branch, because nothing remains that only core can fix. The one thing left (km-scale vertices or child translations
inside a single asset) is not fixed by that core change either; a loader that re-centres at parse time fixes it.
