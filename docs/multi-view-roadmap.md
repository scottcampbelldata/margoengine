# Multiple views and scenes: plan

Date: 2026-10-21. Status: **the next work after the visual-parity pass** (Scott, 2026-10-21: "that needs to
be the very next thing we do"). Nothing here is implemented on `main`. It changes frozen core, so it starts only after
Scott decides how it lands (see [Decisions](#decisions-for-scott)).

## Summary

Today one engine draws one scene through one camera into the whole canvas. `Engine.render({camera})` can draw a second
camera, and core draws accept a viewport rectangle, but the optional packages (post effects, TAA, shadows, picking) all
assume one full-canvas view. A second view either looks wrong or wipes the first.

The plan has two parts, in this order:

1. **Several views of one scene.** Split screen, the four-view CAD layout (top, front, side, 3D), picture-in-picture
   and a minimap, each view with its own camera and rectangle, and every effect working in every view.
2. **Separate scenes.** A HUD overlay with its own objects and lighting, a 3D item preview inside a menu, a portal
   rendered to a texture.

Views come first because they serve the CAD focus directly. Separate scenes follow once views work everywhere.

## What was measured

A throwaway prototype of the full design (views and scenes) was built on `685c4de9` on 2026-10-21 and measured with
`node scripts/measure-size.js`. Its diff is kept outside the repository on the development PC at
`C:\Development\Projects\margoengine-backups\multi-scene-prototype-2026-10-21.diff` (8 files, +508 / -224 lines).

| State | Core + stage raw | Core + stage gzip | Added gzip | Room under 25,000 B |
| --- | --- | --- | --- | --- |
| `685c4de9` | 50,814 | 21,343 | - | 3,657 |
| Full design (views and scenes) | 54,138 | 22,550 | +1,207 | 2,450 |
| Full design minus the four parts below | 52,872 | 22,121 | +778 | 2,879 |

Removing each part from the full design saved: clearing inside a viewport rectangle 228 B, rendering into a texture
(`target`) 92 B, the `engine.views` list 64 B, picking inside a view 42 B. The scene model itself is about 780 B. A
views-only core (part 1 without the `Scene` class) was not measured; milestone M0 measures it.

Prototype checks: strict typecheck of core and stage; core tests 57/57; `tests/core-*.test.js` 54/54;
`tests/modern*.test.js` 345/346 (a stage test's fake engine needs a `scene` field). Nothing ran on a real GPU. The Rust
kernel did not need to change for correct results.

## Design

### Part 1: views (core)

```ts
// A view: which camera, where on the canvas, what to clear, optionally into a texture.
engine.render({ camera: top, viewport: [0, 0, 0.5, 0.5], clear: { color: '#20242a', depth: true } });
engine.render({ camera: front, viewport: [0.5, 0, 0.5, 0.5] });

// Or let the frame loop draw them after the main view, every frame:
engine.views = [
  { camera: top, viewport: [0, 0, 0.5, 0.5] },
  { camera: front, viewport: [0.5, 0, 0.5, 0.5] },
  { camera: side, viewport: [0, 0.5, 0.5, 0.5] },
];
const hit = await engine.pick(x, y, { camera: top, viewport: [0, 0, 0.5, 0.5] });
```

- **`RenderView`**: `camera`, `viewport`, `scissor`, `clear` (colour, depth, or neither), optional `target` (colour
  and depth textures), optional layer mask. Viewports are fractions of the canvas by default (the prototype used
  drawing-buffer pixels, which break on resize), with pixels as an option.
- **`engine.render(view)`** may run several times per frame; views stack in call order. Camera aspect follows the
  viewport or the target. After an extra view, the primary camera, culling and statistics are restored, as
  `render({camera})` already does.
- **`engine.views`**: views the frame loop draws after the main one each frame. Per-frame plugin updates run once per
  frame, not once per view.
- **`PassContext.view`**: a stable view id, its camera, viewport and scissor. `draw()` uses the view's rectangles by
  default. This is what lets packages keep per-view state.
- **Culling**: each view runs the existing kernel tick with its own frustum. World matrices are recomputed only for
  meshes that moved.
- **MSAA**: the 4x buffers stay alive across stacked views instead of being discarded per view. The prototype could
  show one frame of garbage when views first stack and no plugin pass exists; the fix is a flag set on the first view.
- **Rectangle clears** use a small clear draw; a pass with extra colour attachments (such as selection's ID pass) must
  use `clear: false` in rectangle views, or the clear draw covers every attachment.
- **Picking**: `engine.pick(x, y, view)` returns null outside the viewport and uses that view's camera.
- **Device loss**: views hold no GPU objects; caller-owned `target` textures must be recreated by the caller.

### Part 2: packages learn about views

Two shared helpers fix many packages at once: `packages/shared/gpu.js` `acquireDepth` and `packages/shared/msaa.js`
`SceneTarget` become per view and limited to the viewport. Sizes are the prototype's estimates: S under 50 lines,
M 50 to 200, L over 200.

| Package | Change | Size | Wrong until done |
| --- | --- | --- | --- |
| post (PostStack, SSAO, GTAO, SSR, SSGI, Bloom, FXAA, SMAA, motion blur, lens flare, decals, SceneFade) | Per-view capture targets sized to the viewport; composite only inside the rectangle | L | Clears the whole canvas, erasing earlier views; aspect from the full canvas |
| taa | History per view id | L | History thrashes between views (ghosting) |
| dof, tonemap | Viewport-sized targets and composite | S-M, S | As post |
| environment volumetric fog, water foam, culling Hi-Z, voxel-pathtracer | Per-view history or per-view pyramid | M each | History reset every frame with two views |
| shadows | Cascades fitted per view camera, cached per view | M | Cascades fit whichever camera drew last |
| clustered | Light grid per viewport | S | Wrong tiles in an offset viewport |
| selection, points picking | Per-view pick and outline | L, M | Picks through the main camera |
| controls, gizmo (TransformControls), labels, html, viewcube | Bind to a view (camera + rectangle) | M, M, M, S | Use the main camera and full canvas |
| sky, lens flare, gltf-pro, terrain, scatter, creative grass, VAT crowds | Read the view's camera, not the engine's | S-M each | Ignore the viewport |
| vfx, lines, text, splats, voxel, oit, transitions | Respect the view's rectangle | S each | Draw across the full canvas |
| inspector, exporters `capture` | Per-view listing and capture | M, S | Main view only |
| webgl (preview) | Rectangle clears and views | M | Clears the whole canvas |
| xr | Unchanged: the headset is its own pair of views | - | - |

No change: toon, environment's shader-only lights (EnvironmentLighting, Fog, HemisphereLight, AmbientLight),
clustered's other light types, animation's skinning and keyframes.

### Part 3: separate scenes (core)

- **`Scene`** owns its meshes, lighting (sun and ambient), `background` (`null` clears depth only, for overlays),
  plugins and passes, statistics and instance batches. `engine.scene` is the default scene; `engine.lighting`,
  `frameGraph`, `plugins` and `stats` point at it, so every existing app and package keeps working.
- **`engine.createScene()`**, `scene.createMesh()`, `scene.use(plugin)`; a view takes `scene`. A mesh's scene is fixed
  at creation and a parent must be in the same scene. Plugins find their scene with `engine.sceneOf(plugin)` (the
  prototype first passed it as a second `setup` argument, which gltf-pro and animation already use).
- **Stage**: `MeshOptions.scene`; `fit()` and `shadows()` use the default scene's meshes.
- **Packages** that read the default scene today (materials' draw queue, environment's probe bake and `ColorOutput`,
  inspector, exporters, react) take the plugin's scene. About 60 files call `engine.use`, `hasPlugin` or
  `removePlugin`; those act on the default scene, so same-named plugins in two scenes must not collide.
- If the `@margoengine/cameras` layer masks land (in progress 2026-10-21), a view's layer mask uses them, and a "scene
  switch" built on layers stays the zero-core-byte option for apps that only toggle object sets.

### Part 4: kernel speed-up (optional)

Each extra view currently runs a full tick over every entity. A per-entity scene byte, a tick limited to one scene and
a `kernel_cull` export that redoes visibility without matrix work would remove that cost. Estimate, not measured:
150-300 B more Wasm, about +50 to +130 B gzip net. Measure the tick cost with four views at 100,000 entities before
deciding.

## Milestones

| # | Milestone | Done when |
| --- | --- | --- |
| M0 | Decisions and views-only size | Scott has decided the landing (below); the views-only core variant is built from the prototype diff and measured with `npm run measure:size`. |
| M1 | Core views | Part 1 in core and stage; strict typecheck; core and modern tests pass; a real-GPU check draws four views of one scene and each view's pixels equal a single-view render of its camera (within the visual-check tolerance) at 1x and 4x MSAA; one view equals today's output exactly; device restore redraws the same pixels; size recorded in README, `site/index.html` and `docs/limits.md`. |
| M2 | Shared helpers, post, tonemap, dof | Every PostStack effect works per view; a four-view frame with SSAO, Bloom, SMAA and Tonemap matches four single-view renders. |
| M3 | Per-view history | TAA, motion blur, volumetric fog, water foam and Hi-Z culling keep separate histories; two moving views show no ghosting (measured against single-view runs). |
| M4 | Shadows and lights | Directional cascades and clustered grids per view; shadowed points read the same in every view. |
| M5 | Picking and interaction | `engine.pick`, selection, points, controls, TransformControls, labels, html and viewcube work in any view. |
| M6 | Remaining renderers | vfx, lines, text, splats, voxel, oit, transitions, sky and lens flare respect the rectangle. |
| M7 | CAD demos | A four-view CAD layout demo (a STEP assembly with section planes and selection), a split-screen demo and a minimap demo on the site, with visual baselines. |
| M8 | Separate scenes | Part 3 in core; a HUD overlay demo and a menu item-preview demo; packages that read the default scene take the plugin's scene. |
| M9 | Kernel speed-up | Only if the M0-M8 measurements show the extra ticks matter. |

## Testing

- Real-GPU checks per milestone under `node scripts/gpu-lock.mjs`, in the style of the existing package checks: each
  view compared with a single-view render of the same camera, at 1x and 4x MSAA, plus device restore.
- `npm run proofs -- --current`: views off must emit what today's core emits; any proof that changes on purpose gets
  its reference advanced with the reason in `docs/whitepaper/claims.md`.
- `npm run check:merge` before each push (shaders and demos change).
- The WebGL2 compatibility layer ([roadmap](webgl2-compat-roadmap.md)) emulates WebGPU, so views work there once its
  M2 lands; the current `@margoengine/webgl` preview needs its own rectangle clears (Part 2 table).

## Risks

| Risk | Mitigation |
| --- | --- |
| Core budget: the full design leaves 2,450 B under the gate | Land views first; measure views-only in M0; agree a reserve before M8. |
| Half-working feature if core lands before packages | Core views ship together with M2 (post) at minimum; the docs list which packages are view-aware until M6 is done. |
| `engine.store.visible` and `engine.meshes` span all scenes | Packages that scan them filter by scene in M8. |
| Plugin name collisions across scenes | Scene-qualified plugin names in M8. |
| Rectangle clear with extra attachments | `clear: false` rule above, checked by a validation test. |

## Decisions for Scott

1. **How it lands.** Either an explicit exception to the v1.0 core freeze, as for the three hooks in
   [core-parity-hooks-verification.md](core-parity-hooks-verification.md), or the first item of the next version.
2. **Reserve.** How many bytes must stay free under 25,000 after it lands (2,450 B with the full design as measured).
3. **Scope of the first release.** Views only (Parts 1 and 2), or views and separate scenes together.
4. **Viewport units.** Fractions of the canvas by default (proposed), or CSS pixels.
