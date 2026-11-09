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

`attach` uses plugin name `margoengine-labels` by default. If a subsystem such as
sciviz Axes already attached it, reuse that LabelRenderer from `engine.plugins`,
or attach your annotations with an unused name, for example
`LabelRenderer.attach(engine, {name: 'annotations', layout: callouts})`.
A duplicate name throws linked code `state` and explains these choices before
creating an overlay; the existing renderer, layout and labels are preserved.

## How it works

- **Overlay.** `setup` inserts one `div` right after the canvas (or into `parent`), absolutely positioned over the canvas content box with `pointer-events: none` and `overflow: hidden`. Each frame it measures the canvas and corrects the overlay offset, so it stays aligned inside any containing block, border or padding, and under a CSS `scale()` on the canvas's ancestors (see [Scaled pages](#scaled-pages)).
- **Projection.** A frame pass (order 1000, after the scene) projects every label with `camera.matrix`: reversed-Z WebGPU clip space (z from 0 to w) or WebGL2 clip space (z from -w to w), chosen from `engine.backend`. Labels behind the camera are always hidden; labels outside the frustum are hidden unless `frustumCulling: false`. Mesh labels read `engineRuntime(engine).store.matrices`, so they follow parents, rotation and scale, and hide while the mesh or an ancestor is hidden (`followVisibility`) or once the mesh is disposed.
- **Placement.** `transform: translate(x, y) [scale(s)] translate(-anchorX%, -anchorY%)` with `transform-origin: 0 0`, so the anchor point of the element sits exactly on the projected point, with or without distance scaling.
- **Depth order.** Visible labels are sorted by distance to the camera every frame and get `z-index` 1..n, nearest on top. `sort: false` leaves a label's z-index alone.
- **CSS 3D.** A viewer element gets `perspective: (height / 2) / tan(fov / 2)` and a `preserve-3d` camera element gets `translateZ(perspective) matrix3d(view with Y flipped) translate(width / 2, height / 2)`. Each object gets `translate(-50%, -50%) matrix3d(world * scale(pixelScale) with Y flipped)`. The view matrix is rebuilt from `camera.position` and `camera.target` with the same Y-up look-at the core camera uses. CSS cannot clip at the near plane, so the renderer does: an object partly behind it is cut there with a `clip-path` (see [Depth with CSS 3D objects](#depth-with-css-3d-objects)), and one wholly behind it is hidden.
- **Orthographic cameras.** When `camera.matrix` has a constant clip w (for example with `CameraProjection` from `@margoengine/cameras`, which the package does not depend on), the viewer gets `perspective: none` and the camera element `orthographicCSSTransform(matrix, width, height, backend)`: the clip matrix scaled to CSS pixels around the viewport centre, Y flipped, with Z scaled like Y so CSS depth sorting follows the camera. Objects are cut or hidden at the near plane the same way. 2D labels need nothing special; `distanceScale` uses the distance at which a perspective camera with the same fov shows the same zoom, so labels grow when zooming in and do not change with depth. `isOrthographic(matrix)` is exported.
- **Minimal DOM writes.** Every style property is cached per element and written only when its string changes; `renderer.writes` reports how many writes the last update made (0 on a static frame).
- **Engine views.** `new LabelRenderer({view})` (or `labels.view = {camera, viewport, pixels?}`) places labels through that view's camera inside its rectangle, clipped to it; hook coordinates are then relative to the view's corner. One renderer per view.
- **Occlusion hook.** Depth-buffer occlusion is not built in. `occlude(label, {x, y, depth, distance, world})` on the renderer or a label returns true to hide that label this frame; the per-label hook overrides the renderer one.

## Scaled pages

A CSS scale on an element around the canvas (a zoomed preview, a slide, a fitted dashboard tile) scales what the browser draws but not the `left` and `top` the overlay is placed with. Each update the renderer reads the overlay's drawn width against the width it gave it, converts its correction by that scale, and lands on the canvas content box in the same update at any scale. An overlay in another `parent`, outside the scaled element, is scaled itself (`transform: scale(k)`, origin at its corner) so a CSS pixel of the labels is a CSS pixel of the canvas.

```ts
import {LabelRenderer} from 'margoengine/labels';
import {Engine} from 'margoengine/core';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);

canvas.parentElement!.style.transformOrigin = '0 0';
canvas.parentElement!.style.transform = 'scale(0.75)'; // a zoomed-out preview
const tag = (text: string) => Object.assign(document.createElement('div'), {textContent: text});
const beside = LabelRenderer.attach(engine); // beside the canvas: shares its scale
beside.add(tag('Pump 3'), {position: [0, 1, 0]});
const outside = LabelRenderer.attach(engine, {parent: document.body, name: 'labels-outside'}); // scaled to match
outside.add(tag('Valve'), {position: [1, 0, 0]});
```

- **Beside the canvas** (the default) the overlay shares the canvas's ancestors and needs no scale of its own; no `transform` is written on it.
- **Another parent.** The canvas's scale is its drawn width over `offsetWidth`, which the browser rounds to whole pixels, so a canvas of fractional CSS width is matched to about half a pixel over its width.
- **Not followed.** Rotations and skews on the ancestors, and a transform on the canvas element itself.

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

## Leader lines and callouts

`@margoengine/labels/callouts` draws leader lines, for CAD and product annotations: move a label off its point with `screenOffset` (CSS pixels, x right, y down) and `Callouts` draws a line from the projected point to the nearest point of the label's box, with a dot on the point. It is a `layout`; wrap `Declutter` with its `layout` option to remove overlaps first.

```ts
import {LabelRenderer} from 'margoengine/labels';
import {Callouts} from 'margoengine/labels/callouts';
import {Declutter} from 'margoengine/labels/declutter';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const callouts = new Callouts({layout: new Declutter({padding: 4}), color: '#ffd166', dot: 3});
const labels = LabelRenderer.attach(engine, {layout: callouts});
const notes = [
  ['Inlet flange', [-0.6, 0.4, 0], [-90, -50]],
  ['Bolt M8 x 4', [0.2, 0.55, 0.1], [80, -60]],
  ['Seal face', [0.5, -0.2, 0], [90, 40]],
] as const;
for (const [name, position, screenOffset] of notes) {
  const element = document.createElement('div');
  element.textContent = name;
  labels.add(element, {position, screenOffset});
}
// After a frame: callouts.lines lines are drawn; callouts.svg holds them.
```

- **Which labels.** Every shown label whose box does not cover its projected point: one moved with `screenOffset`, or placed off its point by the wrapped layout. Lines shorter than `minLength` are not drawn, so a label `Declutter` placed at a corner of its point gets none. Labels on their point are not even measured.
- **Wrapped layouts.** `layout` runs first and its decisions stand: a label it hides gets no line, one it places with another anchor gets its line from that box. `Declutter` tests the moved boxes; it does not keep lines from crossing labels or each other.
- **Drawing.** One `<svg>` sits first in the overlay, under every label, with `pointer-events: none`; each callout is a `<line>` and a `<circle>`. Attributes are written only when they change (`callouts.writes` is 0 on a still frame); the lines of hidden labels are hidden and those of removed labels deleted. `className` names the SVG for your own CSS, for example `.leaders line {stroke-dasharray: 4 2}`; `clear()` removes it.

| Callouts option | Default |
| --- | --- |
| `layout` (run first, decisions kept) | none |
| `color` (line and dot, any CSS colour) | `'currentColor'` |
| `width` (line width, CSS px) | 1 |
| `dot` (dot radius, CSS px; 0 for none) | 2 |
| `minLength` (shorter lines are not drawn, CSS px) | 2 |
| `className` (of the SVG) | none |

## Depth with CSS 3D objects

CSS 3D objects are HTML in the overlay, so they sit above the canvas, and CSS perspective draws whatever is behind the camera inverted. The renderer measures each element once (`offsetWidth`, `offsetHeight`), works out how far each of its four corners is in front of the camera's near plane, and then shows it whole, cuts it at the plane with `clip-path: polygon(...)` in the element's own pixels, or hides it when no part is in front. A panel you walk through stays drawn up to the plane instead of vanishing. Scene geometry in front of an object is your `occlude` hook's call, as for labels.

```ts
import {LabelRenderer} from 'margoengine/labels';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const isBlocked = (from: readonly number[], to: readonly number[]) => to[1] < from[1] - 10; // your own ray test

const labels = LabelRenderer.attach(engine);
const sign = document.createElement('div');
sign.textContent = 'Exit';
const panel = labels.add3D(sign, {
  position: [0, 1, 0],
  pixelScale: 0.01,
  // Hide the panel while scene geometry is between it and the camera.
  occlude: (object, info) => isBlocked(engine.camera.position, info.world),
});
// After a frame: panel.clipped is true while part of it is behind the near plane.
sign.textContent = 'Emergency exit';
panel.remeasure(); // its size changed: measure it again at the next update
```

- **Cut, not hidden.** The cut is exact for the element's rectangle: its corners' distances from the plane are affine over the element, so the polygon is the rectangle clipped by one plane (3 to 5 points). Orthographic cameras cut at depth 0.
- **Writes.** `clip-path` is written only while an object is cut, and once more to clear it; a still frame writes nothing.
- **Sizes.** An element is measured once; call `object.remeasure()` after its content changes its size. An element that is not laid out yet measures 0 and is treated as its origin point.
- **Children.** `clip-path` flattens an element's own 3D children while it is cut (CSS grouping property); the object itself stays in the 3D scene.

## API

| Export | Purpose |
| --- | --- |
| `LabelRenderer` | Engine plugin: `add(element, options)`, `add3D(element, options)`, `remove(item)`, `update()`, `occlude`, `layout`, `root`, `writes`, `dispose()` |
| `Label` | `element`, `visible`, `onScreen`, `screen` (x, y, depth, w), `world`, `distance`, `setMesh`, `setPosition`, `setOffset`, `anchor`, `screenOffset`, `distanceScale`, `frustumCulling`, `followVisibility`, `sort`, `priority`, `scale`, `placedAnchor`, `remeasure()`, `occlude`, `remove()` |
| `CSS3DObject` | `element`, `visible`, `onScreen`, `clipped`, `matrix`, `pixelScale`, `occlude`, `remeasure()`, `setMesh`, `setMatrix`, `setPose(position, quaternion)`, `remove()` |
| `projectPoint`, `isOrthographic` (from `@margoengine/math/mat4`) | World point to CSS pixels plus normalized depth and frustum flags, for either backend; the renderer uses math's |
| `Declutter`, `eightPositions`, `fourPositions` (from `@margoengine/labels/declutter`) | Overlap removal by priority, as a `layout` |
| `Callouts` (from `@margoengine/labels/callouts`) | Leader lines from moved labels to their points, as a `layout` that can wrap another |
| `LabelLayout`, `LayoutContext` | Types for your own layout (`context.root` is the overlay, for layouts that draw) |
| `lookAtView`, `cssPerspective`, `cameraCSSTransform`, `objectCSSTransform`, `cssPointToWorld`, `composeMatrix` | The CSS 3D math, exported for custom layouts and tests (`lookAtView(position, target, out?, up?)` takes core's `camera.up`, default +Y, so exact top-down views work) |

## Options

| Option | Applies to | Default |
| --- | --- | --- |
| `parent` | renderer | Canvas parent, inserted right after the canvas |
| `zIndex`, `className` | renderer (overlay root) | 1, none |
| `occlude` | renderer, label, CSS 3D (`(object, info) => boolean`) | none |
| `layout` | renderer | none |
| `priority` | label | 0 |
| `mesh` / `position` | label, CSS 3D | none / origin |
| `offset`, `offsetSpace` | label | [0, 0, 0], `'local'` (or `'world'`) |
| `anchor` | label | [0.5, 0.5] (element center) |
| `screenOffset` | label | [0, 0]; CSS px the element moves from its point, for callouts |
| `pointerEvents` | label, CSS 3D | `'none'` (pass through to the canvas); `'auto'` to interact |
| `frustumCulling` | label | true |
| `followVisibility` | label, CSS 3D | true |
| `distanceScale` | label | none; a number or `{reference, min, max}` gives `reference / distance` |
| `sort` | label | true |
| `matrix`, `quaternion` | CSS 3D | identity |
| `pixelScale` | CSS 3D | 0.01 world units per CSS pixel |

## Limits

- CSS 3D objects are not depth-tested per pixel against WebGL/WebGPU geometry and sit above the canvas; the `occlude` hook hides a whole object. They are cut at the near plane by their rectangle, so content painted outside the element box (shadows, overflow) is cut with it.
- Overlay alignment follows CSS scales on the canvas's ancestors, not rotations, skews or a transform on the canvas itself.
- Occlusion against scene geometry is left to the `occlude` hook.
- Leader lines are straight and drawn under every label; nothing keeps them from crossing labels or each other.
- Decluttering tests the element's box, not its painted shape, and measures it once; a box that changes size needs `remeasure()`.

## Tests

`npm test` in `packages/labels` runs Node checks: `projectPoint` against hand-computed values on both clip spaces (near, far, behind, outside), `lookAtView` against the core camera matrix, a CSS transform-chain evaluator showing CSS 3D element corners land on the projected world corners, and the renderer on a fake DOM (overlay placement, mesh following, local and world offsets, anchors, frustum and visibility hiding, z-order, zero writes on a static frame, distance scaling, occlusion hooks, WebGL2, CSS 3D transforms, dispose), decluttering (priority wins, positions tried in order, padding, `inside`, sticky ties, distance-scaled boxes, sizes measured once, still frames write nothing, and 400 random labels placed exactly as a test of every pair places them), CSS 3D depth (panels through the near plane with the origin on either side shown and cut, every polygon point on or in front of the plane, 60 random poses checked on a 21 x 21 grid of element points against the plane, an orthographic cut at depth 0, `clip-path` written only while cut, the CSS 3D `occlude` hook), scaled ancestors (the overlay on the content box in one update at scales 0.5 to 4 beside the canvas with no scale of its own, an overlay in another parent scaled to the canvas, the scale cleared again, still frames writing nothing), callouts (a line from the point to the nearest corner or edge of the moved box with a dot, none for labels on their point and those not measured, lines that follow, hide with their labels, hide when no label is shown and are deleted with removed ones, a still frame writing nothing, a wrapped `Declutter` whose hidden labels get no line and whose boxes use the offset, anchors placed by a wrapped layout, checked options), plus orthographic cameras from `@margoengine/cameras` (projection on both clip spaces, CSS 3D corners and depth order, `perspective: none`, near-plane hiding, zoom-based `distanceScale`). `npm run test:browser` (a real-GPU script, not in CI) runs a real engine in Chromium on WebGPU and then WebGL2: a label sits over its mesh's projected center within 1 px (with the mesh color read back under it), follows a moving mesh, hides behind the camera, stays within 1 px of its point in one update with the canvas's frame scaled by 0.75 and 2 (and a second overlay in `document.body` too, drawn at the frame's scale), passes pointer events through, z-orders by depth under hit testing and re-sorts when the camera moves, CSS 3D corner markers land within 2 px of the projected world corners, a tilted CSS 3D panel whose origin is behind the near plane is hit in its far half and not in its near half, a callout's line starts within 1 px of the projected point and ends within 1 px of the nearest point of the label's laid-out box, there are zero WebGPU validation errors, and removing the plugin leaves no overlay elements.

Apache-2.0 licensed.
