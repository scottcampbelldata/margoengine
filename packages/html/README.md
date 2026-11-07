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

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/html

