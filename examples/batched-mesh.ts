// BatchedMesh demo: 2,500 items of six different shapes in one materials mesh, one draw call per pass. Every item has
// its own matrix, colour and visibility; a wave of hidden items sweeps the field and the shapes spin (held still under
// prefers-reduced-motion, which the visual check uses).
import { createStage } from 'margoengine';
import {
  boxGeometry,
  capsuleGeometry,
  coneGeometry,
  cylinderGeometry,
  sphereGeometry,
  torusGeometry,
} from '@margoengine/geometry';
import { Material } from '@margoengine/materials';
import { BatchedMesh } from '@margoengine/materials/batched';
import { Shadows } from '@margoengine/shadows';
import { engineRuntime } from '@margoengine/core/extension';
import { still } from './multi-view.js';

declare global {
  interface Window {
    batchedDemo?: { batch: BatchedMesh; drawCalls: () => number };
  }
}

const status = document.querySelector<HTMLParagraphElement>('#status')!,
  canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
const life = new AbortController();
let dispose = () => {};
window.addEventListener(
  'pagehide',
  () => {
    life.abort();
    dispose();
  },
  { once: true },
);
try {
  const stage = await createStage(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 26, 40], target: [0, 0, 0] },
    onError: (error) => {
      if (!life.signal.aborted) status.textContent = String(error);
    },
  });
  dispose = () => stage.dispose();
  life.signal.throwIfAborted();
  const engine = stage.engine,
    runtime = engineRuntime(engine);
  runtime.lighting.direction.set([-4, 9, 3, 3.5]);
  const floor = stage.box({ size: [64, 0.2, 64], position: [0, -0.1, 0], color: '#3b4656', roughness: 0.95 });
  const shapes = [
    boxGeometry(0.8, 0.8, 0.8),
    sphereGeometry(0.5, 20, 12),
    coneGeometry(0.45, 1, 20),
    torusGeometry(0.4, 0.14, 12, 24),
    cylinderGeometry(0.35, 0.35, 0.9, 18),
    capsuleGeometry(0.28, 0.5, 4, 12),
  ];
  const side = 50,
    vertices = shapes.reduce((sum, g) => sum + g.positions.length / 3, 0),
    batch = BatchedMesh.attach(engine, new Material({ roughness: 0.45, metalness: 0.1 }), {
      maxItems: side * side,
      maxVertices: Math.ceil((vertices * side * side) / shapes.length) + 4096,
      maxIndices: shapes.reduce((sum, g) => sum + g.indices.length, 0) * Math.ceil((side * side) / shapes.length),
    });
  // A small integer hash, so the layout is the same on every load.
  const hash = (n: number) => {
    n = Math.imul(n ^ (n >>> 15), 0x2c1b3c6d);
    n = Math.imul(n ^ (n >>> 12), 0x297a2d39);
    return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
  };
  const ids: number[] = [],
    spin: number[] = [];
  for (let i = 0; i < side * side; i++) {
    const x = (i % side) - side / 2 + 0.5,
      z = Math.floor(i / side) - side / 2 + 0.5,
      hue = hash(i * 3 + 1);
    ids.push(
      batch.add(shapes[i % shapes.length], {
        color: [0.25 + 0.75 * hue, 0.3 + 0.6 * hash(i * 3 + 2), 1 - 0.8 * hue],
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x * 1.2, 0.5, z * 1.2, 1],
      }),
    );
    spin.push(hash(i * 3 + 3) * Math.PI * 2);
  }
  const shadows = Shadows.attach(engine, { resolution: 2048, distance: 90 });
  shadows.add(floor, { static: true });
  shadows.add(batch.mesh);
  const matrix = new Float32Array(16);
  const pose = (time: number) => {
    for (let i = 0; i < ids.length; i++) {
      const angle = spin[i] + time * (0.5 + (i % 7) * 0.1),
        c = Math.cos(angle),
        s = Math.sin(angle),
        x = (i % side) - side / 2 + 0.5,
        z = Math.floor(i / side) - side / 2 + 0.5;
      matrix.set([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, x * 1.2, 0.5 + 0.3 * Math.sin(time + x * 0.3), z * 1.2, 1]);
      batch.setMatrix(ids[i], matrix);
      // A diagonal band of hidden items sweeps across the field.
      batch.setVisible(ids[i], Math.abs(((x + z + time * 6) % 30) + (x + z + time * 6 < 0 ? 30 : 0) - 15) > 1.5);
    }
  };
  pose(0);
  let time = 0;
  if (!still)
    stage.use({
      name: 'batched-demo',
      setup() {},
      onPreUpdate(delta) {
        time += delta;
        pose(time);
      },
    });
  window.batchedDemo = { batch, drawCalls: () => engine.stats.drawCalls };
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  status.textContent = `${batch.count.toLocaleString()} items of ${shapes.length} shapes in one batched mesh.`;
  canvas.dataset.ready = 'true';
} catch (error) {
  if (!life.signal.aborted) status.textContent = String(error);
}
