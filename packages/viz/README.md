# @margoengine/viz

Data and scientific visualization: figures and GPU compute, points, lines, splats, terrain, labels and text.

This package installs only its declared domain members and forwards their original typed modules.
The root contains common exports; member subpaths expose the complete installed member APIs.
All packages release together at one version. Optional third-party peers remain app choices.

See the [kits guide](https://margoengine.com/llms/guides/kits.md) for profile contents, independent installs,
model-loading entries and measured package counts.

With a `<div id="viewport" style="height:400px"></div>` in the page:

```ts
import {createStage, PointsPlugin, PointCloud, OrbitControls, colormap} from '@margoengine/viz';

const stage = await createStage('#viewport', {controls: false});
const points = PointsPlugin.attach(stage.engine);
const positions = new Float32Array(30_000).map(() => Math.random() * 10);
const colors = new Float32Array(30_000).fill(1);
points.add(new PointCloud({positions, colors, material: {size: 2, shape: 'round'}}));
const controls = new OrbitControls(stage.engine.camera, stage.engine.canvas as HTMLCanvasElement);
stage.onTick((delta) => controls.update(delta));
console.log(typeof colormap);
```

Model loading is a separate import: `import {loadGLTF} from '@margoengine/viz/gltf-pro'`.
