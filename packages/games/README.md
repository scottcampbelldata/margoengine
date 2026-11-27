# @margoengine/games

Install profile. Games: models, animation, light and shadow, sky, physics, audio, input, effects.

It holds no code of its own and only re-exports its member packages: it installs only its declared domain members and forwards their original typed modules.
The root contains common exports; member subpaths expose the complete installed member APIs.
All packages release together at one version. Optional third-party peers remain app choices.

See the [kits guide](https://margoengine.com/llms/docs/guides/kits.md) for profile contents, independent installs,
model-loading entries and measured package counts.

With a `<div id="viewport" style="height:400px"></div>` in the page:

```ts
import {createStage, Shadows, OrbitControls, Input, Tween} from '@margoengine/games';

const stage = await createStage('#viewport', {controls: false});
const shadows = Shadows.attach(stage.engine, {resolution: 2048});
const ground = stage.box({size: [10, 0.2, 10], color: '#c8c8c8'});
const player = stage.box({position: [0, 1, 0], color: '#84d6bd'});
shadows.add(ground);
shadows.add(player);
const controls = new OrbitControls(stage.engine.camera, stage.engine.canvas as HTMLCanvasElement);
const input = new Input({jump: [{type: 'key', code: 'Space'}]});
const tween = new Tween();
const height = {y: 1};
stage.onTick((delta) => {
  input.update();
  if (input.state('jump').pressed) tween.to(height, 'y', 3, {duration: 0.4});
  tween.update(delta);
  player.position.y = height.y;
  controls.update(delta);
});
```

Model loading is a separate import: `import {loadGLTF} from '@margoengine/games/gltf/pbr'`.
Physics is one too: `import {Physics} from '@margoengine/games/physics'`. A game without it ships no solver Wasm.
