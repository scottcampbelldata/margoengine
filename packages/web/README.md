# @margoengine/web

Product viewers and 3D on web pages: a glTF model, studio light, orbit, HTML on top.

This package installs only its declared domain members and forwards their original typed modules.
The root contains common exports; member subpaths expose the complete installed member APIs.
All packages release together at one version. Optional third-party peers remain app choices.

See the [kits guide](https://margoengine.com/llms/guides/kits.md) for profile contents, independent installs,
model-loading entries and measured package counts.

With a `<div id="viewport" style="height:400px"></div>` in the page:

```ts
import {createStage, Environment, OrbitControls, Shadows, Tonemap} from '@margoengine/web';

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

Model loading is a separate import: `import {loadGLTF} from '@margoengine/web/gltf-pro'`.
