# @margoengine/labels

Import `margoengine/labels` from the `margoengine` package, or `@margoengine/labels` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

HTML labels and CSS 3D objects kept in register with a Margo Engine canvas.

Build from source with `npm run build` in `packages/labels`.

```ts
import {LabelRenderer} from 'margoengine/labels';
import {Engine} from 'margoengine/core';
import {createMesh} from 'margoengine/materials';
import {box} from 'margoengine/core';
const makeButton = () => Object.assign(document.createElement('button'), {textContent: 'Open'});
const isBlocked = (from: readonly number[], to: readonly number[]) => to[1] < from[1] - 10; // your own ray test
const engine = await Engine.create(document.querySelector('canvas')!);
const pump = engine.createMesh().setGeometry(box());
const screen = engine.createMesh().setGeometry(box());

const labels = LabelRenderer.attach(engine);

// A 2D label 0.8 units above a mesh origin (mesh-local offset, like a child object).
const name = document.createElement('div');
name.textContent = 'Pump 3';
const label = labels.add(name, {mesh: pump, offset: [0, 0.8, 0], anchor: [0.5, 1], distanceScale: {reference: 6, min: 0.5, max: 1.5}});

// An interactive label at a world point.
const button = labels.add(makeButton(), {position: [2, 1, 0], pointerEvents: 'auto'});

// A CSS 3D panel that rotates and scales with its mesh: 1 CSS pixel = 0.01 world units.
const panel = labels.add3D(document.querySelector<HTMLElement>('#manual')!, {mesh: screen, pixelScale: 0.005});

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
- **CSS 3D.** A viewer element gets `perspective: (height / 2) / tan(fov / 2)` and a `preserve-3d` camera element gets `translateZ(perspective) matrix3d(view with Y flipped) translate(width / 2, height / 2)`. Each object gets `translate(-50%, -50%) matrix3d(world * scale(pixelScale) with Y flipped)`. The view matrix is rebuilt from `camera.position` and `camera.target` with the same Y-up look-at the core camera uses. Objects whose origin is at or behind the near plane are hidden, since CSS cannot clip them.
- **Orthographic cameras.** When `camera.matrix` has a constant clip w (for example with `CameraProjection` from `@margoengine/cameras`, which the package does not depend on), the viewer gets `perspective: none` and the camera element `orthographicCSSTransform(matrix, width, height, backend)`: the clip matrix scaled to CSS pixels around the viewport centre, Y flipped, with Z scaled like Y so CSS depth sorting follows the camera. Objects in front of the near plane are hidden. 2D labels need nothing special; `distanceScale` uses the distance at which a perspective camera with the same fov shows the same zoom, so labels grow when zooming in and do not change with depth. `isOrthographic(matrix)` is exported.
- **Minimal DOM writes.** Every style property is cached per element and written only when its string changes; `renderer.writes` reports how many writes the last update made (0 on a static frame).
- **Engine views.** `new LabelRenderer({view})` (or `labels.view = {camera, viewport, pixels?}`) places labels through that view's camera inside its rectangle, clipped to it; hook coordinates are then relative to the view's corner. One renderer per view.
- **Occlusion hook.** Depth-buffer occlusion is not built in. `occlude(label, {x, y, depth, distance, world})` on the renderer or a label returns true to hide that label this frame; the per-label hook overrides the renderer one.

## Decluttering

`@margoengine/labels/declutter` hides or moves labels that would overlap, so a dense scene stays readable. Labels are taken by `priority` (higher first), then, among equal priorities, the ones shown at the last update (so they do not swap places as the camera moves), then nearer ones. Each is placed with its own anchor, or the first of `positions` that overlaps no label placed before it, and is hidden when none is free.

```ts
import {LabelRenderer} from 'margoengine/labels';
import {Declutter, eightPositions} from 'margoengine/labels/declutter';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const declutter = new Declutter({positions: eightPositions, padding: 4});
const labels = LabelRenderer.attach(engine, {layout: declutter});
for (const [name, x, priority] of [['Main valve', 0, 2], ['Drain', 0.05, 1], ['Gauge', 0.1, 0]] as const) {
  const element = document.createElement('div');
  element.textContent = name;
  labels.add(element, {position: [x, 1, 0], priority});
}
// After a frame: declutter.hidden labels had no free position, declutter.moved were moved around their point.
```

- **Positions.** `eightPositions` tries above right, above left, below right, below left, right, left, above and below the point, in that order; `fourPositions` the four corners. Without `positions` an overlapping label is hidden.
- **Sizes.** Each element is measured once (`offsetWidth`, `offsetHeight`) and scaled by its `distanceScale`; call `label.remeasure()` after its text or style changes its size.
- **Cost.** The overlap test buckets placed boxes in a grid of `cell` pixels (default 64), so each label tests only its neighbours. A still frame writes nothing to the DOM.
- **Own layouts.** `layout` takes any `{arrange(labels, context)}`: `context.size(label)`, `context.hide(label)` and `context.place(label, anchor)` run before anything is drawn, with `label.screen`, `label.distance` and `label.scale` already set for the update.

| Declutter option | Default |
| --- | --- |
| `padding` (free gap between labels, CSS px) | 2 |
| `positions` (anchors tried after the label's own) | none: hide |
| `inside` (boxes must stay inside the view) | false |
| `sticky` (labels shown last time win ties) | true |
| `cell` (grid cell, CSS px) | 64 |

## API

| Export | Purpose |
| --- | --- |
| `LabelRenderer` | Engine plugin: `add(element, options)`, `add3D(element, options)`, `remove(item)`, `update()`, `occlude`, `layout`, `root`, `writes`, `dispose()` |
| `Label` | `element`, `visible`, `onScreen`, `screen` (x, y, depth, w), `world`, `distance`, `setMesh`, `setPosition`, `setOffset`, `anchor`, `distanceScale`, `frustumCulling`, `followVisibility`, `sort`, `priority`, `scale`, `placedAnchor`, `remeasure()`, `occlude`, `remove()` |
| `CSS3DObject` | `element`, `visible`, `onScreen`, `matrix`, `pixelScale`, `setMesh`, `setMatrix`, `setPose(position, quaternion)`, `remove()` |
| `projectPoint`, `isOrthographic` (from `@margoengine/math/mat4`) | World point to CSS pixels plus normalized depth and frustum flags, for either backend; the renderer uses math's |
| `Declutter`, `eightPositions`, `fourPositions` (from `@margoengine/labels/declutter`) | Overlap removal by priority, as a `layout` |
| `LabelLayout`, `LayoutContext` | Types for your own layout |
| `lookAtView`, `cssPerspective`, `cameraCSSTransform`, `objectCSSTransform`, `cssPointToWorld`, `composeMatrix` | The CSS 3D math, exported for custom layouts and tests (`lookAtView(position, target, out?, up?)` takes core's `camera.up`, default +Y, so exact top-down views work) |

## Options

| Option | Applies to | Default |
| --- | --- | --- |
| `parent` | renderer | Canvas parent, inserted right after the canvas |
| `zIndex`, `className` | renderer (overlay root) | 1, none |
| `occlude` | renderer, label | none |
| `layout` | renderer | none |
| `priority` | label | 0 |
| `mesh` / `position` | label, CSS 3D | none / origin |
| `offset`, `offsetSpace` | label | [0, 0, 0], `'local'` (or `'world'`) |
| `anchor` | label | [0.5, 0.5] (element center) |
| `pointerEvents` | label, CSS 3D | `'none'` (pass through to the canvas); `'auto'` to interact |
| `frustumCulling` | label | true |
| `followVisibility` | label, CSS 3D | true |
| `distanceScale` | label | none; a number or `{reference, min, max}` gives `reference / distance` |
| `sort` | label | true |
| `matrix`, `quaternion` | CSS 3D | identity |
| `pixelScale` | CSS 3D | 0.01 world units per CSS pixel |

## Limits

- CSS 3D objects are not depth-tested against WebGL/WebGPU geometry and sit above the canvas; partly-behind-the-camera objects are hidden as a whole.
- Overlay alignment assumes no CSS scale transform on the canvas's ancestors.
- Occlusion against scene geometry is left to the `occlude` hook.
- Decluttering tests the element's box, not its painted shape, and measures it once; a box that changes size needs `remeasure()`.

## Tests

`npm test` in `packages/labels` runs Node checks: `projectPoint` against hand-computed values on both clip spaces (near, far, behind, outside), `lookAtView` against the core camera matrix, a CSS transform-chain evaluator showing CSS 3D element corners land on the projected world corners, and the renderer on a fake DOM (overlay placement, mesh following, local and world offsets, anchors, frustum and visibility hiding, z-order, zero writes on a static frame, distance scaling, occlusion hooks, WebGL2, CSS 3D transforms, dispose), decluttering (priority wins, positions tried in order, padding, `inside`, sticky ties, distance-scaled boxes, sizes measured once, still frames write nothing, and 400 random labels placed exactly as a test of every pair places them), plus orthographic cameras from `@margoengine/cameras` (projection on both clip spaces, CSS 3D corners and depth order, `perspective: none`, near-plane hiding, zoom-based `distanceScale`). `npm run test:browser` (a real-GPU script, not in CI) runs a real engine in Chromium on WebGPU and then WebGL2: a label sits over its mesh's projected center within 1 px (with the mesh color read back under it), follows a moving mesh, hides behind the camera, passes pointer events through, z-orders by depth under hit testing and re-sorts when the camera moves, CSS 3D corner markers land within 2 px of the projected world corners, there are zero WebGPU validation errors, and removing the plugin leaves no overlay elements.

Apache-2.0 licensed.
