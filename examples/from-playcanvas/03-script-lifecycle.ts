// PlayCanvas, in words: a script is a class with `initialize()` (once, when the entity is enabled), `postInitialize()`
// (once, after every script's initialize has run), `update(dt)` and `postUpdate(dt)` every frame (all updates, then all
// post-updates), and `swap(old)` when hot reloading. Attributes are declared on the script and edited in the Editor.
// `this.entity` is the node it sits on and `this.app` the application. `this.on('destroy', ...)` cleans up.
//
// Margo: there is no script component, so the lifecycle is a few lines of your own. This is the whole of it: a class
// with the same hooks, and a host that calls them from `stage.onTick`. Options are constructor arguments. There is no
// `swap`; hot reload is the bundler's job.
import { createStage } from 'margoengine';
import { fail, status } from './common';

const stage = await createStage('#scene', { camera: { position: [4, 3, 6], target: [0, 0.8, 0] } }).catch(fail);
type Mesh = ReturnType<typeof stage.box>;

abstract class Script {
  constructor(readonly entity: Mesh) {}
  initialize(): void {}
  postInitialize(): void {}
  update(_delta: number): void {}
  postUpdate(_delta: number): void {}
  destroy(): void {}
}

class Scripts {
  private readonly scripts: Script[] = [];
  private fresh: Script[] = [];
  add(script: Script): void {
    script.initialize();
    this.scripts.push(script);
    this.fresh.push(script); // postInitialize waits until the next tick, after every initialize in this batch
  }
  tick(delta: number): void {
    for (const script of this.fresh) script.postInitialize();
    this.fresh = [];
    for (const script of this.scripts) script.update(delta);
    for (const script of this.scripts) script.postUpdate(delta);
  }
  dispose(): void {
    for (const script of this.scripts) script.destroy();
    this.scripts.length = 0;
  }
}

// A script with attributes (speed, height).
class Bobber extends Script {
  private time = 0;
  private baseY = 0;
  constructor(
    entity: Mesh,
    readonly attributes: { speed: number; height: number },
  ) {
    super(entity);
  }
  override initialize() {
    this.baseY = this.entity.position.y;
  }
  override postInitialize() {
    status.textContent = 'initialize and postInitialize have run; update runs each frame.';
  }
  override update(delta: number) {
    this.time += delta;
    this.entity.position.y = this.baseY + Math.sin(this.time * this.attributes.speed) * this.attributes.height;
  }
  override destroy() {
    this.entity.dispose(); // entity.destroy()
  }
}

stage.box({ size: [10, 0.1, 10], position: [0, -0.05, 0], color: '#d8d8cf' });
const scripts = new Scripts();
scripts.add(new Bobber(stage.box({ position: [-1, 1, 0], color: '#84d6bd' }), { speed: 2, height: 0.4 }));
scripts.add(new Bobber(stage.box({ position: [1, 1, 0], color: '#d9824c' }), { speed: 3, height: 0.2 }));
stage.onTick((delta) => scripts.tick(delta));
window.addEventListener(
  'pagehide',
  () => {
    scripts.dispose();
    stage.dispose();
  },
  { once: true },
);
