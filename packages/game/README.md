# @margoengine/game

This name forwards to [`@margoengine/games`](https://margoengine.com/llms/docs/guides/kits.md). Install `@margoengine/games` for new work. Existing imports of `@margoengine/game` keep working: every subpath re-exports the same modules.

With a `<div id="viewport" style="height:400px"></div>` in the page:

```ts
import {createStage, Shadows, OrbitControls, Input, Tween} from '@margoengine/game';

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
