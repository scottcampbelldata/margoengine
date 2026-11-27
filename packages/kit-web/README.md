# @margoengine/kit-web

This name forwards to [`@margoengine/web`](https://margoengine.com/llms/docs/guides/kits.md). Install `@margoengine/web` for new work. Existing imports of `@margoengine/kit-web` keep working: every subpath re-exports the same modules.

With a `<div id="viewport" style="height:400px"></div>` in the page:

```ts
import {createStage, Environment, OrbitControls, Shadows, Tonemap} from '@margoengine/kit-web';

const stage = await createStage('#viewport', {controls: false});
const shadows = Shadows.attach(stage.engine, {resolution: 2048});
const tonemap = Tonemap.attach(stage.engine, {curve: 'neutral', exposure: 0});
const floor = stage.box({size: [6, 0.1, 6], color: '#d8d8d8'});
const product = stage.sphere({radius: 0.8, position: [0, 0.9, 0], color: '#c0792b', roughness: 0.3});
shadows.add(floor);
shadows.add(product);
const controls = new OrbitControls(stage.engine.camera, stage.engine.canvas as HTMLCanvasElement);
stage.onTick((delta) => controls.update(delta));
console.log(typeof Environment, tonemap.options.curve);
```
