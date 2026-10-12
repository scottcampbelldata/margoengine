# @margoengine/labels

HTML labels and CSS 3D objects kept in register with a Margo Engine canvas. Replaces THREE.CSS2DRenderer/CSS2DObject and THREE.CSS3DRenderer/CSS3DObject.

Build from source with `npm run build` in `packages/labels`.

```ts
import {LabelRenderer} from '@margoengine/labels';

const labels = new LabelRenderer();
engine.use(labels);

// A 2D label 0.8 units above a mesh origin (mesh-local offset, like a THREE child object).
const name = document.createElement('div');
name.textContent = 'Pump 3';
const label = labels.add(name, {mesh: pump, offset: [0, 0.8, 0], anchor: [0.5, 1], distanceScale: {reference: 6, min: 0.5, max: 1.5}});

// An interactive label at a world point.
const button = labels.add(makeButton(), {position: [2, 1, 0], pointerEvents: 'auto'});

// A CSS 3D panel that rotates and scales with its mesh: 1 CSS pixel = 0.01 world units.
const panel = labels.add3D(document.querySelector('#manual'), {mesh: screen, pixelScale: 0.005});

// Custom occlusion, for example a BVH raycast from the camera.
labels.occlude = (label, info) => isBlocked(engine.camera.position, info.world); // your own test

label.remove();
engine.removePlugin(labels.name); // or engine.dispose(): removes every element and the overlay
```

## How it works

- **Overlay.** `setup` inserts one `div` right after the canvas (or into `parent`), absolutely positioned over the canvas content box with `pointer-events: none` and `overflow: hidden`. Each frame it measures the canvas and corrects the overlay offset, so it stays aligned inside any containing block, border or padding.
- **Projection.** A frame pass (order 1000, after the scene) projects every label with `camera.matrix`: reversed-Z WebGPU clip space (z from 0 to w) or WebGL2 clip space (z from -w to w), chosen from `engine.backend`. Labels behind the camera are always hidden; labels outside the frustum are hidden unless `frustumCulling: false`. Mesh labels read `engineRuntime(engine).store.matrices`, so they follow parents, rotation and scale, and hide while the mesh or an ancestor is hidden (`followVisibility`) or once the mesh is disposed.
- **Placement.** `transform: translate(x, y) [scale(s)] translate(-anchorX%, -anchorY%)` with `transform-origin: 0 0`, so the anchor point of the element sits exactly on the projected point, with or without distance scaling.
- **Depth order.** Visible labels are sorted by distance to the camera every frame and get `z-index` 1..n, nearest on top. `sort: false` leaves a label's z-index alone.
- **CSS 3D.** As in CSS3DRenderer, a viewer element gets `perspective: (height / 2) / tan(fov / 2)` and a `preserve-3d` camera element gets `translateZ(perspective) matrix3d(view with Y flipped) translate(width / 2, height / 2)`. Each object gets `translate(-50%, -50%) matrix3d(world * scale(pixelScale) with Y flipped)`. The view matrix is rebuilt from `camera.position` and `camera.target` with the same Y-up look-at the core camera uses. Objects whose origin is at or behind the near plane are hidden, since CSS cannot clip them.
- **Minimal DOM writes.** Every style property is cached per element and written only when its string changes; `renderer.writes` reports how many writes the last update made (0 on a static frame).
- **Occlusion hook.** Depth-buffer occlusion is not built in. `occlude(label, {x, y, depth, distance, world})` on the renderer or a label returns true to hide that label this frame; the per-label hook overrides the renderer one.

## API

| Export | Purpose |
| --- | --- |
| `LabelRenderer` | Engine plugin: `add(element, options)`, `add3D(element, options)`, `remove(item)`, `update()`, `occlude`, `root`, `writes`, `dispose()` |
| `Label` | `element`, `visible`, `onScreen`, `screen` (x, y, depth, w), `world`, `distance`, `setMesh`, `setPosition`, `setOffset`, `anchor`, `distanceScale`, `frustumCulling`, `followVisibility`, `sort`, `occlude`, `remove()` |
| `CSS3DObject` | `element`, `visible`, `onScreen`, `matrix`, `pixelScale`, `setMesh`, `setMatrix`, `setPose(position, quaternion)`, `remove()` |
| `projectPoint` | World point to CSS pixels plus normalized depth and frustum flags, for either backend |
| `lookAtView`, `cssPerspective`, `cameraCSSTransform`, `objectCSSTransform`, `cssPointToWorld`, `composeMatrix` | The CSS 3D math, exported for custom layouts and tests |

## Options

| Option | Applies to | Default |
| --- | --- | --- |
| `parent` | renderer | Canvas parent, inserted right after the canvas |
| `zIndex`, `className` | renderer (overlay root) | 1, none |
| `occlude` | renderer, label | none |
| `mesh` / `position` | label, CSS 3D | none / origin |
| `offset`, `offsetSpace` | label | [0, 0, 0], `'local'` (or `'world'`) |
| `anchor` | label | [0.5, 0.5] (element center) |
| `pointerEvents` | label, CSS 3D | `'none'` (pass through to the canvas); `'auto'` to interact |
| `frustumCulling` | label | true |
| `followVisibility` | label, CSS 3D | true |
| `distanceScale` | label | none; a number or `{reference, min, max}` gives `reference / distance` |
| `sort` | label | true |
| `matrix`, `quaternion` | CSS 3D | identity |
| `pixelScale` | CSS 3D | 0.01 world units per CSS pixel (THREE uses 1) |

## Limits

- CSS 3D objects are not depth-tested against WebGL/WebGPU geometry and sit above the canvas; partly-behind-the-camera objects are hidden as a whole.
- Overlay alignment assumes no CSS scale transform on the canvas's ancestors.
- Occlusion against scene geometry is left to the `occlude` hook.

## Tests

`npm test` in `packages/labels` runs 13 Node checks: `projectPoint` against hand-computed values on both clip spaces (near, far, behind, outside), `lookAtView` against the core camera matrix, a CSS transform-chain evaluator showing CSS 3D element corners land on the projected world corners, and the renderer on a fake DOM (overlay placement, mesh following, local and world offsets, anchors, frustum and visibility hiding, z-order, zero writes on a static frame, distance scaling, occlusion hooks, WebGL2, CSS 3D transforms, dispose). `npm run test:browser` runs a real engine in Chromium on WebGPU and then WebGL2: a label sits over its mesh's projected center within 1 px (with the mesh color read back under it), follows a moving mesh, hides behind the camera, passes pointer events through, z-orders by depth under hit testing and re-sorts when the camera moves, CSS 3D corner markers land within 2 px of the projected world corners, there are zero WebGPU validation errors, and removing the plugin leaves no overlay elements.

MIT licensed.
