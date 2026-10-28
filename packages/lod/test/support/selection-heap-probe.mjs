// Runs in its own process (node --expose-gc) so no other test, timer or promise shares the heap while it is measured.
// Prints a JSON array: heap bytes retained after a forced gc over each of 5 windows of 1,000 frames of selection with
// level switches for 3,000 objects. `--allocate` makes every update allocate a little, to prove the probe notices.
import v8 from 'node:v8';
import { Engine, TransformStore, box } from '../../../core/dist/extension.js';
import { LODSystem } from '../../dist/index.js';

const allocate = process.argv.includes('--allocate');
const store = await TransformStore.create(8192),
  renderer = {
    backend: 'webgpu',
    gpu: null,
    live: new Set(),
    add(g) {
      this.live.add(g);
    },
    remove(g) {
      this.live.delete(g);
    },
    render() {},
    dispose() {},
  },
  e = new Engine({ width: 400, height: 200, clientWidth: 400, clientHeight: 200 }, store, renderer),
  lods = new LODSystem();
e.use(lods);
const a = box(),
  b = box(0.5, 0.5, 0.5),
  kept = [];
for (let i = 0; i < 3000; i++) {
  const anchor = e.createMesh().setPosition([(i % 60) * 4, 0, -Math.floor(i / 60) * 4]),
    child = e.createMesh(anchor).setGeometry(a);
  lods.add(anchor, [{ object: child }, { object: b, distance: 40 }, { object: null, distance: 120 }]);
}
const near = [0, 0, 0.001],
  far = [60, 0, -60],
  run = (frames) => {
    for (let f = 0; f < frames; f++) {
      e.camera.position = f % 2 ? near : far;
      lods.update();
      if (allocate) kept.push(new Array(64).fill(f));
    }
  };
run(4000);
const growth = [];
for (let w = 0; w < 5; w++) {
  globalThis.gc();
  const before = v8.getHeapStatistics().used_heap_size;
  run(1000);
  growth.push(v8.getHeapStatistics().used_heap_size - before);
}
const levels = new Set(lods.handles.map((l) => l.level));
console.log(JSON.stringify({ growth, levels: [...levels].sort() }));
e.dispose();
