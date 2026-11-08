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

WebGPU defaults to a shared sampleable depth target, also used by water. Pass depth: () => effect.depthTexture with SSAO/DOF, or depth: false to disable GPU occlusion. WebGL keeps projection and caller occlusion hooks without GPU depth. Capacity defaults to 1024 anchors, maximum 4096. Depth results arrive asynchronously and stale results after substantial motion are ignored; there can be a frame of visibility latency. depthBias is reversed-Z depth, not world units. CSS3D objects are projected but not sampled for depth. dispose removes the overlay and owned elements.

## Smooth partial occlusion

`fade` fades an anchor as geometry slides over it instead of hiding it at once. Each frame the depth pass tests an `samples` x `samples` grid over a square `radius` CSS pixels around the anchor (4 x 4 over 8 px by default) and the element's `style.opacity` moves toward the share of tests the scene leaves clear, at most from 1 to 0 in `duration` seconds (default 0.15; 0 follows each result at once). At opacity 0 the element is hidden (`display: none`); at 1 its inline opacity is removed again. WebGPU only; style the element's own opacity on a child, since fade writes the element's.

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

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/html

