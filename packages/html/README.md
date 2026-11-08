# @margoengine/html

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

WebGPU defaults to a shared sampleable depth target, also used by water. Pass depth: () => effect.depthTexture with SSAO/DOF, or depth: false to disable GPU occlusion. On the WebGL2 preview backend (`@margoengine/webgl`), whose canvas depth cannot be sampled, the same tests run as occlusion queries: after the scene, one point a test is drawn at the anchor with colour and depth writes off inside an `ANY_SAMPLES_PASSED` query, and the result is read when the browser makes it available, a frame or more later. A round of queries is in flight per anchor at a time; `fade` there costs `samples` x `samples` points and queries an anchor, so keep it small (`samples: 2`) with many anchors. Capacity defaults to 1024 anchors, maximum 4096. Depth results arrive asynchronously and stale results after substantial motion are ignored; there can be a frame of visibility latency. depthBias is reversed-Z depth, not world units. CSS3D objects are projected but not sampled for depth. dispose removes the overlay and owned elements.

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

`add` moves the element into an invisible holder at the top left of the page (opacity 0, no pointer events), where it keeps its layout, focus and events. The size defaults to the element's CSS size at 100 CSS pixels a world unit, the texture to `devicePixelRatio` texture pixels a CSS pixel (`pixelRatio`, 0.25 to 4). Two rasterizers draw the element: `'element-image'`, the HTML-in-canvas `drawElementImage` where the browser has it (the default there), and `'foreign-object'`, the element's tree with its computed styles inlined into an SVG `foreignObject` image, everywhere else. The texture is drawn again when the element changes (a mutation, input, focus or hover, or an HTML-in-canvas paint event); call `surface.invalidate()` after a change none of these shows, such as a loaded font. While the pointer is over a quad, the holder moves so that the element's point under the pointer is the hit point on the quad; off every quad it moves back out of the way.

With `'foreign-object'`, fonts and images the element uses must be same-origin data the SVG image can embed (data URLs); the browser loads nothing from inside it. Scene geometry in front of a quad hides it on screen but does not stop the pointer reaching the element. `textures.dispose()` removes the holders and the elements in them.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/html

