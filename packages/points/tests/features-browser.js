// Real-GPU checks of the optional point features, each on a canvas of its own. Each check returns a line for the report.
import { Engine } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { PointsPlugin } from '@margoengine/points';
import { Capture } from './points-browser.js';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** A fresh engine on its own 256 px canvas with pixel capture; `frame()` renders and reads it, `end()` checks for errors. */
async function rig(camera = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  canvas.style.cssText = 'width:256px;height:256px';
  document.body.append(canvas);
  const engine = await Engine.create(canvas, {
    backend: 'webgpu',
    camera: { position: [0, 0, 10], target: [0, 0, 0], fov: 60, near: 0.1, far: 100, ...camera },
  });
  engine.stop();
  const device = engineRuntime(engine).gpu,
    capture = new Capture(),
    errors = [];
  device.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  engine.use(capture);
  const frame = async () => {
    engine.render();
    await device.queue.onSubmittedWorkDone();
    return capture.read();
  };
  const end = async () => {
    await device.queue.onSubmittedWorkDone();
    assert(!errors.length, `GPU errors: ${errors.join('; ')}`);
    engine.dispose();
    canvas.remove();
  };
  return { engine, device, frame, end, errors };
}
const fraction = (image, test, [x0, y0, x1, y1]) => {
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (test(image.at(x, y))) n++;
  return n / ((x1 - x0) * (y1 - y0));
};
const lit = ([r, g, b]) => r + g + b > 60;

/** Waits until an octree has loaded everything it wants, drawing frames. */
async function settled(octree, frame) {
  // fixed-wait: a cap, not a delay; it returns on the first frame after every node load has settled
  for (let i = 0; i < 400; i++) {
    await frame();
    await new Promise((r) => setTimeout(r, 0));
    if (octree.stats.loading === 0 && i > 3) return frame();
  }
  throw new Error(`octree did not settle: ${JSON.stringify(octree.stats)}`);
}

/** A flat square of n x n points, side 8, facing the camera at z = 0, on a jittered grid. */
function square(n) {
  const positions = new Float32Array(n * n * 3);
  let s = 3;
  const random = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = 0; i < n * n; i++)
    positions.set(
      [(((i % n) + random()) / n) * 8 - 4, (((Math.floor(i / n) + random()) / n) * 8 - 4) * 1, (random() - 0.5) * 0.01],
      i * 3,
    );
  return positions;
}

async function adaptiveSize() {
  const { buildOctree, OctreeCloud } = await import('../dist/octree.js');
  const tree = buildOctree({ positions: square(700) }, { maxPointsPerNode: 4000, grid: 32 }),
    area = [80, 80, 176, 176],
    cover = async (adaptiveSize) => {
      const { engine, frame, end } = await rig(),
        points = PointsPlugin.attach(engine),
        // The budget holds only the top of the tree: a sparse sample of the square.
        octree = OctreeCloud.attach(engine, points, tree, {
          pointBudget: 3000,
          adaptiveSize,
          material: { size: 1, shape: 'round' },
        });
      const image = await settled(octree, frame),
        covered = fraction(image, lit, area),
        drawn = octree.stats.drawn;
      octree.dispose();
      await end();
      return { covered, drawn };
    };
  const plain = await cover(false),
    grown = await cover(true);
  assert(plain.drawn === grown.drawn && plain.drawn <= 3000, `same nodes: ${plain.drawn} and ${grown.drawn}`);
  assert(plain.covered < 0.6, `the sparse sample should show holes: ${plain.covered}`);
  assert(grown.covered > 0.95, `adaptive points should close them: ${grown.covered}`);
  return `Adaptive point size closes the holes of a sparse octree sample: ${plain.covered.toFixed(3)} to ${grown.covered.toFixed(3)} of the pixels covered`;
}

window.runFeatures = async () => {
  const checks = [];
  for (const check of [adaptiveSize]) checks.push(await check());
  return checks;
};
