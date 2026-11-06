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

/** A surface of opaque points in two colours that meet at x = 0: surfels blend across the line, plain points do not. */
async function surfels() {
  const { PointCloud } = await import('@margoengine/points');
  const { SurfelPlugin } = await import('../dist/surfels.js');
  const n = 120,
    positions = square(n),
    colors = new Uint8Array(n * n * 3);
  for (let i = 0; i < n * n; i++) colors.set(positions[i * 3] < 0 ? [255, 0, 0] : [0, 0, 255], i * 3);
  const material = { size: 8 / n, sizeUnits: 'world', minPixelSize: 0 },
    area = [80, 80, 176, 176],
    filled = ([r, , b]) => r + b > 100,
    between = ([r, , b]) => r > 40 && b > 40;
  const draw = async (make) => {
    const { engine, frame, end } = await rig(),
      value = make(engine),
      image = await frame();
    return { value, image, end };
  };
  const plain = await draw((engine) =>
    PointsPlugin.attach(engine).add(new PointCloud({ positions, colors, material: { ...material, shape: 'round' } })),
  );
  const blended = await draw((engine) => {
    const plugin = SurfelPlugin.attach(engine, { overlap: 2 });
    plugin.add(new PointCloud({ positions, colors, colorSpace: 'linear', material }));
    return plugin;
  });
  const holes = 1 - fraction(blended.image, filled, area),
    plainHoles = 1 - fraction(plain.image, filled, area),
    mixed = fraction(blended.image, between, [120, 80, 136, 176]),
    plainMixed = fraction(plain.image, between, [120, 80, 136, 176]),
    far = blended.image.at(90, 128),
    near = blended.image.at(166, 128);
  assert(holes < 0.001, `surfels leave no holes: ${holes}`);
  assert(plainHoles > holes, `plain points show more holes: ${plainHoles}`);
  assert(mixed > plainMixed * 3, `colours blend across the seam: ${mixed} against ${plainMixed}`);
  assert(far[0] > 200 && far[2] < 30 && near[2] > 200 && near[0] < 30, `each side keeps its colour: ${far} ${near}`);
  await plain.end();
  await blended.end();
  return `Surfels close a jittered surface (${holes.toFixed(4)} holes against ${plainHoles.toFixed(3)}) and blend colours across a seam (${mixed.toFixed(2)} against ${plainMixed.toFixed(2)})`;
}

/** A red surface in front of a blue one, nearer than the disc size, and a mesh in front of surfels. */
async function surfelDepth() {
  const { PointCloud } = await import('@margoengine/points');
  const { SurfelPlugin } = await import('../dist/surfels.js');
  const { box, PbrMaterial } = await import('@margoengine/core');
  const { engine, frame, end } = await rig(),
    plugin = SurfelPlugin.attach(engine, { overlap: 2 }),
    n = 60,
    positions = square(n),
    material = { size: 8 / n, sizeUnits: 'world' };
  const back = plugin.add(new PointCloud({ positions: positions.map((v, i) => (i % 3 === 2 ? v - 1 : v)), material: { ...material, color: [0, 0, 1] } }));
  const front = plugin.add(new PointCloud({ positions, material: { ...material, color: [1, 0, 0] } }));
  const hidden = (await frame()).at(128, 128);
  assert(hidden[0] > 200 && hidden[2] < 30, `the front surface hides the back one: ${hidden}`);
  front.material.clippingPlanes = [[-1, 0, 0, 0]];
  const cut = await frame();
  assert(cut.at(100, 128)[0] > 200, `the kept half stays: ${cut.at(100, 128)}`);
  assert(cut.at(156, 128)[2] > 200, `the cut half shows the surface behind: ${cut.at(156, 128)}`);
  front.material.clippingPlanes = [];
  back.visible = false;
  engine
    .createMesh()
    .setGeometry(box(1, 1, 1))
    .setMaterial(new PbrMaterial({ color: '#000000', roughness: 1 }))
    .setPosition([0, 0, 2]);
  const shown = await frame();
  assert(shown.at(128, 128)[0] < 100, `a mesh in front hides surfels: ${shown.at(128, 128)}`);
  assert(shown.at(70, 128)[0] > 200, `beside it they still show: ${shown.at(70, 128)}`);
  await end();
  return 'Surfels keep a near surface in front of a far one, honour clipping planes and share depth with meshes';
}

window.runFeatures = async () => {
  const checks = [];
  for (const check of [adaptiveSize, surfels, surfelDepth]) checks.push(await check());
  return checks;
};
