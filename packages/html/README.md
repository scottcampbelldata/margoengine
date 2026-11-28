# @margoengine/html

World-space DOM anchors, CSS3D placement and scene-depth occlusion.

Import `margoengine/html` from the `margoengine` package, or `@margoengine/html` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

World-space DOM anchors reuse labels' projection, frustum clipping, inherited visibility and CSS3D placement. 2D anchors additionally use asynchronous scene-depth occlusion.

```ts
import {HTML} from 'margoengine/html';
import {Engine} from 'margoengine/core';
import {createMesh} from 'margoengine/materials';
import {box} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const mesh = engine.createMesh().setGeometry(box());
const element = document.createElement('div');
const html = HTML.attach(engine);
html.add(element, {mesh, offset: [0,1,0]});
```

WebGPU defaults to a shared sampleable depth target, also used by water. Pass depth: () => effect.depthTexture with SSAO/DOF, or depth: false to disable GPU occlusion. On the WebGL2 preview backend (`@margoengine/webgl2-compat/preview`), whose canvas depth cannot be sampled, the same tests run as occlusion queries: after the scene, one point a test is drawn at the anchor with colour and depth writes off inside an `ANY_SAMPLES_PASSED` query, and the result is read when the browser makes it available, a frame or more later. A round of queries is in flight per anchor at a time; `fade` there costs `samples` x `samples` points and queries an anchor, so keep it small (`samples: 2`) with many anchors. Capacity defaults to 1024 anchors, maximum 1,048,576 (`capacity`); storage starts at 64 slots and doubles as anchors are added, and each frame's depth work runs to the highest slot in use, not to the capacity. Depth results arrive asynchronously and stale results after substantial motion are ignored; there can be a frame of visibility latency. depthBias is reversed-Z depth, not world units. CSS3D objects are projected but not sampled for depth. dispose removes the overlay and owned elements.

## Smooth partial occlusion

`fade` fades an anchor as geometry slides over it instead of hiding it at once. Each frame the depth pass tests an `samples` x `samples` grid over a square `radius` CSS pixels around the anchor (4 x 4 over 8 px by default) and the element's `style.opacity` moves toward the share of tests the scene leaves clear, at most from 1 to 0 in `duration` seconds (default 0.15; 0 follows each result at once). At opacity 0 the element is hidden (`display: none`); at 1 its inline opacity is removed again. Both backends; style the element's own opacity on a child, since fade writes the element's.

```ts
import {HTML} from 'margoengine/html';
import {Engine, box} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box());
const html = HTML.attach(engine, {fade: {radius: 8, samples: 4, duration: 0.15}});
const tip = document.createElement('div');
tip.textContent = 'Behind the box';
html.add(tip, {position: [0.6, 0, -1]});
```

Results arrive a frame or two late, like the hard test's. A result taken before the anchor moved more than `radius` (at least 4) CSS pixels is not applied and the anchor's target opacity goes back to 1, as a moving anchor is never hidden by where it was.

## DOM drawn into the scene

`margoengine/html/texture` (`@margoengine/html/texture`) draws HTML elements as textures on quads in the scene. A quad is depth-tested and writes depth like scene geometry, so a mesh in front of it hides its part, and the page's pointer reaches the element where it hits the quad: hover, focus, clicks and typing go to the element itself, through the browser's own hit test. WebGPU only.

```ts
import {HTMLTexture} from 'margoengine/html/texture';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const panel = document.createElement('div');
panel.style.cssText = 'width:200px;height:100px;background:#0af';
const button = document.createElement('button');
button.textContent = 'Press';
button.addEventListener('click', () => (button.textContent = 'Pressed'));
panel.append(button);
const textures = HTMLTexture.attach(engine);
// 2 x 1 world units at the origin, facing +Z; pass {mesh} to follow a mesh, or {matrix} for any pose.
const surface = textures.add(panel, {width: 2, height: 1});
```

`add` moves the element into an invisible holder at the top left of the page (opacity 0, no pointer events), where it keeps its layout, focus and events. The size defaults to the element's CSS size at 100 CSS pixels a world unit, the texture to `devicePixelRatio` texture pixels a CSS pixel (`pixelRatio`, 0.25 to 4). Two rasterizers draw the element: `'element-image'`, the HTML-in-canvas `drawElementImage` where the browser has it (the default there), and `'foreign-object'`, the element's tree with its computed styles inlined into an SVG `foreignObject` image, everywhere else. The texture is drawn again when the element changes (a mutation, input, focus or hover, or an HTML-in-canvas paint event); call `surface.invalidate()` after a change none of these shows, such as a loaded font. While the pointer is over a quad, the holder moves so that the element's point under the pointer is the hit point on the quad; off every quad it moves back out of the way. A raster that fails (a `prepare` that rejects, a tainting or broken image) reaches `engine.onError` as a `MargoError` with code `failed` and the original error as `cause`; the surface keeps its last texture until `surface.invalidate()` draws it again.

With `'foreign-object'`, fonts and images the element uses must be same-origin data the SVG image can embed (data URLs); the browser loads nothing from inside it. Scene geometry in front of a quad hides it on screen but does not stop the pointer reaching the element. On a linear HDR target (rgba16float, as post-processing uses) the element's sRGB colour is decoded to linear light (the CSS Color 4 sRGB curve), as `ColorBackground` does, so the post chain's tone map and encode apply to it like any unlit surface; on a display target the bytes are drawn as they are. Pointer routing maps the whole canvas: with a view rectangle or several views it does not follow the view's camera. `textures.dispose()` removes the holders and the elements in them.

## DOM textures on the WebGL2 preview (`@margoengine/html/texture-gl`)

`margoengine/html/texture-gl` (`@margoengine/html/texture-gl`) is `HTMLTexture` with a WebGL2 route, so the same panels
draw on the small WebGL2 preview (`@margoengine/webgl2-compat/preview`) as on WebGPU and the full compatibility layer.
Options, rasterizers, `prepare`, pointer routing and errors are `HTMLTexture`'s; only the draw differs.

```ts
import {HTMLTextureGL} from 'margoengine/html/texture-gl';
import {Engine} from 'margoengine/core';
import {webglRenderer} from 'margoengine/webgl2-compat/preview';
// WebGPU where the browser has it, the WebGL2 preview where it does not; the panel draws on both.
const engine = await Engine.create(document.querySelector('canvas')!, {backend: 'auto', fallback: webglRenderer});
const panel = document.createElement('div');
panel.style.cssText = 'width:200px;height:100px;background:#fa0';
panel.textContent = 'Hello';
const textures = HTMLTextureGL.attach(engine);
const surface = textures.add(panel, {width: 2, height: 1});
```

- On WebGPU and the full layer the `HTMLTexture` pass draws and the WebGL2 route does nothing. On the preview a WebGL2
  pass after the scene draws each quad into the frame's view viewport, depth-tested against the canvas depth
  (`LESS`, depth writes on, so later overlays see it), blended premultiplied over (`ONE`, `ONE_MINUS_SRC_ALPHA`), with
  texels under 0.4 percent alpha discarded. The preview draws to the display, so the element's bytes are drawn as they
  are.
- Both rasterizers are shared: `'element-image'` where the browser has HTML-in-canvas, `'foreign-object'` elsewhere.
  Each surface uploads its raster once per redraw to a texture of its own (RGBA8, premultiplied on upload, linear
  filtering, clamped edges); the GL unpack settings and bindings the upload touches are put back after it.
- Pointer input is `HTMLTexture`'s: the page's own hit test reaches the element through the quad under the pointer.
- `textures.remove(surface)` deletes that surface's texture. `textures.dispose()` deletes every texture, the program
  and the vertex array, then removes the holders and their elements. While the context is lost an upload is skipped
  and the surface is drawn again later; after a restore the GL objects are made again on the next frame.

## CSS3D panels behind the scene (`@margoengine/html/blend`)

`margoengine/html/blend` (`@margoengine/html/blend`) places real DOM elements in the scene and lets the scene hide them.
`HTMLBlend` puts CSS3D panels (as `@margoengine/labels` places them) under the canvas and, each frame, cuts a
depth-tested window in the canvas for each one: where scene geometry is in front of a panel the scene draws, and where
the panel is in front the canvas is clear and the page shows the element itself, live and interactive (a form, a video,
an iframe).

```ts
import {HTMLBlend} from 'margoengine/html/blend';
import {Engine, box} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
engine.createMesh().setGeometry(box()); // in front of the panel's middle, so it hides that part
const blend = HTMLBlend.attach(engine);
const form = document.createElement('div');
form.style.cssText = 'width:300px;height:200px;background:#fff';
form.innerHTML = '<input placeholder="Type here">';
const panel = blend.add3D(form, {position: [0, 0, -2]}); // 300 x 200 CSS px at 0.01 world units a pixel
```

- The window is the panel's rectangle (its CSS size times `pixelScale`, at the panel's matrix) drawn in transparent
  black with a `less` depth test and depth writes, after the scene. On WebGPU the canvas is configured with
  `alphaMode: 'premultiplied'`. Panels are rectangles: a transparent part of an element shows the page behind the
  canvas, not the scene.
- Canvas alpha: the small preview must be created with `webglRenderer(canvas, {transparent: true})`. Without alpha,
  `attach` throws a `MargoError` with code `'unsupported'`. WebGPU and the full compatibility layer need nothing.
- Input: the canvas gets `z-index: 1` and `pointer-events: none` (and `position: relative` when it had none), so the
  panels under it (overlay `zIndex` 0) take the pointer; `add3D` defaults `pointerEvents` to `'auto'`.
- Several `HTMLBlend`s on one canvas share it: the first saves the canvas's `position`, `z-index`, `pointer-events`
  and alpha mode, and the last one disposed puts them back.
- `view` (a labels `LabelView`) places panels and windows with that view's camera (the engine camera when it has none)
  in its rectangle: `viewport` as fractions of the canvas, or canvas pixels with `pixels: true`, scaled to the
  render target when that is not the canvas size. The viewport keeps fractional edges and the scissor rounds outward
  to whole pixels, on WebGPU and on the preview, where the GL viewport, scissor and state are put back after the
  pass. Without `view` the windows follow the frame's own view rectangle and camera.
- `remove(panel)` frees its window's buffer. After a device restore pipelines and buffers are made again and the
  premultiplied alpha mode is applied to the new canvas context. `dispose()` (or `using`) is final: `add3D` or a new
  `attach` of that instance then throws a `MargoError` with code `'disposed'`.

## Self-contained snapshots for `'foreign-object'` (`@margoengine/html/inline`)

An SVG `foreignObject` image loads nothing, so with the `'foreign-object'` rasterizer an element's images and web fonts
are missing unless they are data URLs. `margoengine/html/inline` (`@margoengine/html/inline`) fetches them for you:
`inlineResources(element, options)` returns a detached copy of the element with every image and used font embedded,
and `resourceInliner(options)` is the same as `HTMLTexture`'s `prepare` hook, run before each raster.

```ts
import {HTMLTexture} from 'margoengine/html/texture';
import {inlineResources, resourceInliner} from 'margoengine/html/inline';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const art = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#0af"/></svg>';
const card = document.createElement('div');
card.style.cssText = 'width:200px;height:100px;background:#fff';
card.innerHTML = `<img src="${URL.createObjectURL(new Blob([art], {type: 'image/svg+xml'}))}" width="64" height="64">`;
document.body.append(card);

const copy = await inlineResources(card, {timeout: 5000}); // the live card is not changed
console.log(copy.querySelector('img')!.getAttribute('src')!.startsWith('data:image/svg+xml')); // true

const textures = HTMLTexture.attach(engine, {rasterizer: 'foreign-object', prepare: resourceInliner({timeout: 5000})});
textures.add(card, {width: 2, height: 1});
```

- Embedded: `<img>` (its current source; `srcset` and `sizes` are dropped), `<input type="image">`, SVG `<image>`
  `href`, every `url(...)` in the copy's inline styles (the copy already carries the computed styles), and the
  `@font-face` rules of the font families the element uses. Those come from the document's style sheets and adopted
  sheets, including `@import`ed sheets, cross-origin sheets (fetched again with CORS) and rules inside `@media` and
  other grouping rules. The copy's own `<style>` and style sheet links are removed. Data URLs and `#fragment`
  references stay as they are.
- Each address is fetched once per call with `mode: 'cors'` and same-origin credentials. A failed or refused fetch
  throws a `MargoError` with code `'failed'` that names the address: serve it same-origin or with CORS headers.
- `timeout` bounds the whole snapshot, in whole milliseconds from 1 to 2147483647 (default 15000; `RangeError`
  otherwise). `signal` cancels it. Through `resourceInliner` the surface's own signal joins yours, so removing the
  surface cancels its fetches.
- `fontCSS` replaces the sheet search with `@font-face` CSS you pass, for faces a script made (`new FontFace(...)` in
  `document.fonts` is in no sheet). Its URLs resolve against the element's `baseURI`.

## Many anchors

One overlay takes up to 1,048,576 anchors. Its point, result and readback buffers start at 64 slots and double as anchors are added (re-made at the next depth test, never while a read is in flight), a removed anchor's slot is taken again first, and the per-frame depth work, WebGL2 queries included, runs to the highest slot in use.

```ts
import {HTML} from 'margoengine/html';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
// 10,000 map pins in one overlay: past the old 4,096 limit.
const pins = HTML.attach(engine, {capacity: 10_000});
for (let i = 0; i < 10_000; i++) {
  const pin = document.createElement('div');
  pin.textContent = String(i);
  pins.add(pin, {position: [(i % 100) - 50, 0, Math.floor(i / 100) - 50]});
}
```

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/html

## Preview tier contract

GPU-only attachments refuse the small WebGL2 preview during setup with `MargoError` code `unsupported` and a help link. Native WebGPU and the full WebGL2 compatibility layer expose the WebGPU-shaped device these passes need. Use [automatic escalation](../webgl2-compat/README.md#automatic-escalation) with awaited setup to load the full layer when required. Existing real preview routes remain available.

`HTMLBlend`, `HTMLTextureGL` and `HTMLTexture` are reviewed preview routes in `scripts/check-preview-contract.mjs` (2026-11-10): each has one `backend` test and real drawing on the small preview. `HTMLBlend` punches its mask with WebGL2 on the preview and with WebGPU elsewhere; `HTMLTextureGL` draws textured quads with WebGL2 on the preview; plain `HTMLTexture` refuses the preview (`unsupported`) and draws only through its `HTMLTextureGL` subclass there. Pixel evidence for both backends is `test/html-browser.js` (`npm run test:browser`, also with `MARGO_COMPAT=1`); the plain refusal is in `test/texture.test.js`. No behaviour changed; the routes were added after `4e3337946` first broke `npm run verify`.
