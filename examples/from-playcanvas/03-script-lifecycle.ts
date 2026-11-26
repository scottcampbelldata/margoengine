// PlayCanvas, in words: a script is a class with `initialize()` (once, when the entity is enabled), `postInitialize()`
// (once, after every script's initialize has run), `update(dt)` and `postUpdate(dt)` every frame (all updates, then all
// post-updates), and `swap(old)` when hot reloading. Attributes are declared on the script and edited in the Editor.
// `this.entity` is the node it sits on and `this.app` the application. `this.on('destroy', ...)` cleans up.
//
// Margo: `defineScript` and `Scripts` (ecs/scripts) are that model. A script type declares typed attributes and the
// same hooks; any number of instances attach to an ECS entity, and `scripts.update(dt)` runs the hooks in order
// (every initialize, then every postInitialize, then every update, then every postUpdate). `swap` and `reload` give
// hot reload. The ECS entity is not a mesh: keep the mesh it drives in your own map, or in `this.state`.
import { createStage } from 'margoengine';
import { World } from 'margoengine/ecs';
import { Scripts, defineScript } from 'margoengine/ecs/scripts';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [4, 3, 6], target: [0, 0.8, 0] } }).catch(fail);
type Mesh = ReturnType<typeof stage.box>;

const world = new World(16);
const scripts = new Scripts(world, { onError: (error) => console.error(error) });
const meshes = new Map<number, Mesh>(); // entity -> the node its script moves

// A script with attributes (speed, height). `this.attributes` are validated; assigning one runs onAttributeChange.
const bobber = defineScript({
  name: 'bobber',
  attributes: {
    speed: { type: 'number', default: 2, min: 0, max: 20 },
    height: { type: 'number', default: 0.4, min: 0 },
  },
  initialize() {
    this.state.time = 0;
    this.state.baseY = meshes.get(this.entity)!.position.y;
  },
  postInitialize() {
    status.textContent = 'initialize and postInitialize have run; update runs each frame.';
  },
  update(dt) {
    this.state.time += dt;
    meshes.get(this.entity)!.position.y = this.state.baseY + Math.sin(this.state.time * this.attributes.speed) * this.attributes.height;
  },
  destroy() {
    meshes.get(this.entity)?.dispose(); // entity.destroy()
  },
});
scripts.register(bobber);

stage.box({ size: [10, 0.1, 10], position: [0, -0.05, 0], color: '#d8d8cf' });
for (const [x, color, values] of [
  [-1, '#84d6bd', { speed: 2, height: 0.4 }],
  [1, '#d9824c', { speed: 3, height: 0.2 }],
] as const) {
  const entity = world.create();
  meshes.set(entity, stage.box({ position: [x, 1, 0], color }));
  scripts.add(entity, bobber, { values });
}
stage.onTick((delta) => scripts.update(delta));
window.addEventListener(
  'pagehide',
  () => {
    scripts.dispose();
    stage.dispose();
  },
  { once: true },
);
