# @margoengine/kit-viz

This name forwards to [`@margoengine/science`](https://margoengine.com/llms/docs/guides/kits.md). Install `@margoengine/science` for new work. Existing imports of `@margoengine/kit-viz` keep working: every subpath re-exports the same modules.

With a `<div id="viewport" style="height:400px"></div>` in the page:

```ts
import {createStage, PointsPlugin, PointCloud, OrbitControls, colormap} from '@margoengine/kit-viz';

const stage = await createStage('#viewport', {controls: false});
const points = PointsPlugin.attach(stage.engine);
const positions = new Float32Array(30_000).map(() => Math.random() * 10);
const colors = new Float32Array(30_000).fill(1);
points.add(new PointCloud({positions, colors, material: {size: 2, shape: 'round'}}));
const controls = new OrbitControls(stage.engine.camera, stage.engine.canvas as HTMLCanvasElement);
stage.onTick((delta) => controls.update(delta));
console.log(typeof colormap);
```
