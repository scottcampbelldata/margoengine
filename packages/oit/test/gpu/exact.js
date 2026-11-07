// Browser side of exact-check.mjs: unlit planes in front of an opaque wall, drawn through a chosen pass.
import { waitForPipelines } from '../../../../scripts/support/gpu-ready.js';
import { Engine } from '../../../core/dist/index.js';
import { TransparentCanvas } from '../../../environment/dist/index.js';
import { Material, createMesh } from '../../../materials/dist/index.js';
import { planeGeometry } from '../../../geometry/dist/index.js';
import { PostStack, FXAA } from '../../../post/dist/index.js';
import { OIT } from '../../dist/index.js';
import { ExactOIT } from '../../dist/exact.js';
import { MomentOIT } from '../../dist/moments.js';

const errors = [];
addEventListener('error', (e) => errors.push(e.message));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
let engine, canvas, pass;
let planes = [];
const plane = (color, z, opacity, { size = 1.6, tilt = 0, x = 0 } = {}) => {
  const mesh = createMesh(
    engine,
    planeGeometry(size, size),
    new Material({
      shading: 'basic',
      color,
      opacity,
      transparent: opacity < 1,
      doubleSided: true,
    }),
  );
  mesh.root.setPosition([x, 0, z]);
  if (opacity < 1) planes.push({ mesh, x, z });
  if (tilt) mesh.root.setRotation([0, tilt, 0]);
  return mesh;
};
const draw = async () => {
  engine.render();
  await engine.gpu.queue.onSubmittedWorkDone();
};
window.check = {
  errors,
  // {samples, mode:'exact'|'moment'|'weighted'|'sorted', depthRange, dense, layers, pool, order:[...indices], tilted, blocker, transparent, post}
  async build(o) {
    pass?.dispose();
    pass = undefined;
    planes = [];
    engine?.dispose();
    canvas?.remove();
    globalThis.margoLow = o.samples === 1 ? 1 : undefined;
    canvas = document.body.appendChild(document.createElement('canvas'));
    canvas.style.cssText = 'width:256px;height:256px;display:block';
    engine = await Engine.create(canvas, {
      backend: 'webgpu',
      preserveDrawingBuffer: true,
      camera: { position: [0, 0, 4], target: [0, 0, 0], near: 0.05, far: 100 },
    });
    engine.gpu.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    if (o.transparent) TransparentCanvas.attach(engine);
    if (!o.transparent) plane([0.2, 0.2, 0.2], -1.5, 1, { size: 8 });
    const options = {};
    if (o.layers) options.layers = o.layers;
    if (o.pool) options.pool = o.pool;
    if (o.post) PostStack.attach(engine, [new FXAA()]);
    pass =
      o.mode === 'sorted'
        ? { add() {}, dispose() {} }
        : o.mode === 'weighted'
          ? OIT.attach(engine)
          : o.mode === 'moment'
            ? MomentOIT.attach(engine, o.depthRange ? { depthRange: o.depthRange } : {})
            : ExactOIT.attach(engine, options);
    const layers = [
      [[1, 0, 0], 0.6, 0.5],
      [[0, 1, 0], 0.3, 0.4],
      [[0, 0, 1], 0, 0.6],
      [[1, 1, 0], -0.3, 0.5],
    ];
    if (o.blocker) plane([1, 1, 1], 0.15, 1, { size: 1.6 });
    if (o.dense) {
      pass.add(plane([1, 0, 0], 0.6, 0.9));
      pass.add(plane([0, 1, 0], 0.3, 0.9));
    } else if (o.tilted) {
      // Two sheets that cross on the centre line: each is in front on one half, which no per-mesh order can draw.
      pass.add(plane([1, 0, 0], 0, 0.5, { tilt: 0.5 }));
      pass.add(plane([0, 0, 1], 0, 0.5, { tilt: -0.5 }));
    } else for (const i of o.order ?? [0, 1, 2, 3]) pass.add(plane(...layers[i]));
    await waitForPipelines(draw);
    return { width: canvas.width, height: canvas.height };
  },
  draw,
  // Moves the see-through planes towards the camera.
  async shift(by) {
    for (const { mesh, x, z } of planes) mesh.root.setPosition([x, 0, z + by]);
    await draw();
  },
  async fit() {
    pass.fit();
    await draw();
  },
  stats: () => pass.stats,
  // Draws until the list has read back its count and grown, as it does over a few frames of a running scene.
  settle: () => waitForPipelines(draw, { ready: () => pass.stats.fragments > 0 && !pass.stats.dropped }),
  shot: () => canvas.toDataURL('image/png'),
};
window.ready = true;
