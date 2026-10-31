# Multiple views and scenes

Date: 2026-10-24. Status: **views (part 1), the package work (part 2) and separate scenes (part 3) are in core**,
landed as an accepted exception to the v1.0 core freeze (2026-10-23), and every package is view-aware. The two demos (M7) are on the site; part 4 is optional. The
real-GPU check `npm run check:views` runs in `check:merge`.

## Summary

One engine can draw several views of one scene in a frame (split screen, the four-view layout, picture-in-picture,
a minimap) and separate scenes (a HUD overlay with its own objects and lighting, a 3D item preview in a menu, a portal
rendered to a texture). Effects with history keep it per view.

## Size

`node scripts/measure-size.js`, core + stage gzip:

| State | Gzip | Under 25,000 B |
| --- | ---: | ---: |
| `main` before views (`848555bc`) | 21,343 | 3,657 |
| Views, scenes, 4x target views and the kernel changes below | 22,210 | 2,790 |

The views and scenes code adds about 2.7 KB; a smaller kernel pays for most of it: the transform kernel's snapshot
compares four lanes at once with Wasm SIMD (measured 3.65 to 2.94 ms per frame at 100,000 entities, 1% moving, 3 ticks) and its
redundant slice bounds checks became unchecked accessors under one safety note, which shrinks the embedded Wasm from
7,092 to 4,580 base64 characters.

## API

```ts
engine.views = [
  { camera: top, viewport: [0, 0, 0.5, 0.5], clear: { color: '#20242a' } },
  { camera: front, viewport: [0.5, 0, 0.5, 0.5] },
  { camera: side, viewport: [0, 0.5, 0.5, 0.5] },
  { camera: engine.camera, viewport: [0.5, 0.5, 0.5, 0.5] },
]; // the frame loop draws these instead of the full-canvas view
engine.render({ views, delta }); // or draw them yourself, once per frame
const hit = await engine.pick(x, y); // through the view under the point; pick(x, y, view) for a given one

const hud = engine.createScene('hud');
hud.background = null; // keep the colour below: an overlay
hud.createMesh().setGeometry(box());
engine.views = [{ camera: engine.camera, viewport: [0, 0, 1, 1] }, { camera: hudCamera, viewport: [0, 0, 1, 1], scene: hud }];
```

- **`RenderView`**: `camera`, `viewport` (fractions of the canvas, or of `target`; `pixels: true` for drawing-buffer
  pixels), `scissor`, `clear` (`color` string or false, `depth`), `target` (colour and depth textures; views into one
  target stack like canvas views (core draws them grouped by target): 1-sample colour in any renderable format; with 4x MSAA core draws into its own 4x colour and depth, kept per
  target size and format and resolves colour into the caller's texture; a caller depth must have the scene's depth
  format and sample count, and core draws into it directly (another shape throws TypeError; core does not convert depth)), `layers` (validated 32-bit mask), `id` (stable key for per-view history; default the index), `scene`.
- **`engine.render({views})`** draws the views in order. Canvas views stack: the first clears colour, later ones load
  it, and a partial rectangle clears with a draw inside it (an attachment clear would cover the whole target). Camera
  aspect follows the rectangle. Plugins update once per scene and each camera advances once per call. `render()`
  without views is unchanged.
- **`engine.views`**: the frame loop draws these instead of the full-canvas view; list `engine.camera` to keep it.
- **`PassContext.view`**: `id`, `camera`, `viewport`, `scissor`, `index`, `count`, `clear`, `layers`; absent for a
  plain frame. `draw()` uses its rectangles by default. `packages/shared/view-rect.js` holds the helpers packages use:
  `applyView`, `viewSize`, `viewLoadOp`, `viewKey`, `ViewStates` (per-view state, released when a view is not drawn
  for a frame), `toTarget`/`fromTarget` (matrix remaps for full-target textures), `inView`/`meshLayers` (layer tests).
- **Layers**: one concept, `@margoengine/cameras/layers`. `setRenderLayers(mesh, mask)` (children follow their nearest
  masked ancestor), `setCameraLayers(camera, mask)`; a view draws with its `layers`, else its camera's mask, else every
  layer. Core reads the masks from the registry that module keeps on `globalThis` and filters while collecting
  instances: nothing is hidden. The old `CameraLayers` plugin, `renderView` and `SceneSwitch` (which hid meshes) are
  gone: a camera mask replaces the first two, layers or core scenes the third.
- **Scenes**: `engine.createScene(name)`, `scene.createMesh(parent)`, `scene.use(plugin)`, `scene.removePlugin(name)`,
  `scene.dispose()`, `scene.background`, `scene.lighting`, `engine.sceneOf(plugin)`, stage `MeshOptions.scene`.
  `engine.scene` is the default; while a scene is drawn or set up, `engine.lighting`, `frameGraph`, `plugins`, `stats`
  and `createMesh` are that scene's, so packages work in any scene unchanged. A mesh's parent must be in its scene.
  Batch claims and GPU-culling redirects are kept per scene.
- **Picking**: `engine.pick(x, y, view?)` returns null outside the view, uses its camera, scene and layers, and hands
  plugin pickers (`onPick(x, y, view)`) the view in pixels.
- **Device loss**: views hold no GPU objects; caller-owned `target` textures must be recreated by the caller.

## Which packages are view-aware

| Package | In a view | Notes |
| --- | --- | --- |
| post: PostStack, SSAO, GTAO, SSR, SSGI, Bloom, FXAA, SMAA, lens flare, decals, SceneFade, image passes | Yes | Captures keep earlier views; composites stay in the rectangle |
| post: MotionBlur | Yes | Reprojects full-target velocity with `fromTarget` |
| taa | Yes | History, jitter and captures per view id (`ViewStates`) |
| dof, tonemap | Yes | Circle of confusion from the view height |
| environment: background, ColorOutput, volumetric fog | Yes | Fog keeps a froxel grid and history per view |
| environment: Reflector, Refractor, CubeCamera, probes | Yes | Captures render their own cameras over the default scene |
| water | Yes | Foam history per view |
| culling | Yes | Occluder depth and Hi-Z sized to the view |
| clustered | Yes | Light grid over the view's rectangle |
| shadows | Yes | Cascades fit the camera being drawn (maps re-render per view) |
| points | Yes | Sizes and LOD per view; `pick(x, y, {view})` |
| selection, gltf-pro, materials, oit, voxel, voxel-pathtracer, vat crowds | Yes | Per-view picking, outlines and draws |
| sky, terrain, scatter, creative grass, vfx, lines, text, splats | Yes | Draw inside the rectangle |
| controls (overlay, TransformControls) | Yes | |
| labels, html, viewcube | Yes | `view` option binds a renderer or cube to its view (one per view) |
| webgl (preview) | Yes | Rectangle clears and views; `target` views need WebGPU and throw saying so |
| inspector | Yes | Helpers follow each view's culling and layers; the tree lists its scene; captures report passes per view |
| exporters `capture` | Yes | `capture(engine, {view})` renders a view's camera, scene and layers at its rectangle's size |
| xr | Yes | The headset is its own pair of views |

## Milestones

| # | Milestone | Status |
| --- | --- | --- |
| M0 | Decisions and size | Done: freeze exception approved; size above. |
| M1 | Core views | Done in core and stage; unit tests in `tests/core-views.test.js`, `core-scene-picking.test.js`. Real-GPU check: `npm run check:views` (scenes section). |
| M2 | Shared helpers, post, tonemap, dof | Done; real-GPU check: `check:views` postfx section (four views against one). |
| M3 | Per-view history | Done for TAA, motion blur, volumetric fog, water foam, Hi-Z culling; `check:views` temporal and water sections. |
| M4 | Shadows and lights | Done: cascades follow the drawn camera, clustered grid per view. |
| M5 | Picking and interaction | Done: `engine.pick`, selection, points, controls; labels, html and viewcube bind to a view. |
| M6 | Remaining renderers | Done, including inspector and exporters `capture`. |
| M7 | Multi-view demos | Done: [demos](#demos) on the site, in the visual check and in `check:views` (demos section). |
| M8 | Separate scenes | Done in core and stage (`tests/core-scenes.test.js`); `check:views` draws a HUD scene and a 4x item preview. No site demo of either yet. |
| M9 | Kernel speed-up | Optional: a full kernel tick runs per view. A per-entity scene byte and a cull-only export would remove it. Measured (`npm run bench -- scaling`, `boxes-*-views4`, RTX A6000, 2026-10-24): 100,000 boxes take 1.07 ms CPU and 0.57 ms GPU per frame in one view, 4.44 ms CPU and 2.02 ms GPU in four (10,000: 0.16/0.10 against 0.48/0.24 ms). CPU grows 4.2x for 4 views, so the kernel tick dominates. |

## Demos

Two site demos (`examples/*.html`, built into `site/dist/demos/` by `scripts/build-site.js`, linked from the home
page), using only public APIs. Each view has a labelled box over its rectangle that its controls listen on, and a click
picks through the view under it (`examples/multi-view.ts`). Reduced motion holds each one still for the visual check.

| Demo | What it shows | Frame time |
| --- | --- | ---: |
| [Split-screen two players](../examples/split-screen.html) | Two chase cameras in one arena, side by side (stacked on a tall screen). Each player's marker is on a render layer only that player's view draws. WASD and the arrow keys steer; idle players drive round the pillars. | 3.4 ms |
| [Minimap](../examples/minimap.html) | A chase view of a car going round a town, with a square orthographic map in the corner looking straight down, north up or turning with the car. The car arrow and route dots are on a layer only the map draws. | 3.5 ms |

Frame time: `npm run check:views` (demos section), the median of 60 frames each rendered and awaited until the GPU
finished (CPU and GPU together, no overlap), 1280 x 720 at 4x MSAA, NVIDIA RTX A6000, Edge, 2026-10-24.

Overlapping `engine.pick` calls are answered in order, each for its own point and view (one GPU readback at a time),
so rapid clicks in different views each get their own result.

## Testing

- Unit tests: `tests/core-views.test.js`, `core-scenes.test.js`, `core-scene-picking.test.js`,
  `core-live-view-state.test.js`, `scene-target-view-retention.test.js`, `deep-render-multiview-depth.test.js`, and each
  package's view tests (taa, water, culling, clustered, points, labels, viewcube, dof, volumetric, inspector,
  exporters capture).
- Real GPU: `npm run check:views` under the GPU lock (scenes, post effects, temporal history, water, a 4x item preview
  into 1x textures against a 1x reference) at 1x and 4x MSAA with device restore; then the two demos (picks through
  each view, layers a view leaves out, frame time).
- Visual check: `split-screen` and `minimap` at high, light and phone.
- `npm run proofs -- --current`: without views, core emits what it emitted before.
