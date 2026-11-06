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
  for (let i = 0, quiet = 0; i < 400; i++) {
    await frame();
    await new Promise((r) => setTimeout(r, 0));
    quiet = octree.stats.loading ? 0 : quiet + 1;
    if (quiet > 3) return frame();
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

/** A Potree 2.0 folder and a 1.x one, served from memory, drawn through OctreeCloud. */
async function potree() {
  const { OctreeCloud } = await import('../dist/octree.js');
  const { PotreeSource } = await import('../dist/potree.js');
  const { serve, writePotree1, writePotree2 } = await import('./potree-writer.js');
  const positions = [...square(120)].map((v, i) => v + [1000, 2000, 3000][i % 3]),
    colors = new Array((positions.length / 3) * 3).fill(255),
    cloud = { positions, colors, capacity: 1000 },
    drawn = [];
  for (const files of [writePotree2(cloud), writePotree1(cloud)]) {
    const { engine, frame, end } = await rig({ position: [0, 0, 10] }),
      points = PointsPlugin.attach(engine),
      source = await PotreeSource.open('/scan/', { fetch: serve(files, '/scan/') }),
      octree = OctreeCloud.attach(engine, points, source, { adaptiveSize: true, material: { size: 2 } });
    const image = await settled(octree, frame);
    drawn.push(fraction(image, lit, [80, 80, 176, 176]));
    assert(octree.stats.failed === 0, 'no node failed');
    octree.dispose();
    await end();
  }
  assert(drawn[0] > 0.9 && drawn[1] > 0.9, `both versions draw the square: ${drawn}`);
  return `A Potree 2.0 and a 1.x folder stream through OctreeCloud and draw the same square (${drawn.map((v) => v.toFixed(2))})`;
}

/** An octree following a mesh: it moves, turns and hides with it, and picks answer in world positions. */
async function octreeTransform() {
  const { buildOctree, OctreeCloud } = await import('../dist/octree.js');
  const { engine, frame, end } = await rig(),
    points = PointsPlugin.attach(engine),
    octree = OctreeCloud.attach(engine, points, buildOctree({ positions: square(200) }, { maxPointsPerNode: 5000 }), {
      adaptiveSize: true,
      material: { size: 2 },
    }),
    mesh = engine.createMesh();
  octree.attach(mesh);
  const left = [20, 100, 60, 156],
    right = [196, 100, 236, 156];
  mesh.setPosition([-5, 0, 0]);
  mesh.setScale([0.5, 0.5, 0.5]);
  await settled(octree, frame);
  let image = await settled(octree, frame);
  assert(fraction(image, lit, left) > 0.9, `follows the mesh left: ${fraction(image, lit, left)}`);
  assert(fraction(image, lit, right) === 0, 'and leaves the right empty');
  mesh.setPosition([5, 0, 0]);
  await frame();
  image = await settled(octree, frame);
  assert(fraction(image, lit, right) > 0.9, `follows the mesh right: ${fraction(image, lit, right)}`);
  assert(fraction(image, lit, left) === 0, 'and leaves the left empty');
  const hit = points.pick(216, 128);
  assert(hit && hit.position[0] > 2, `picks in world positions: ${hit?.position}`);
  mesh.visible = false;
  image = await frame();
  assert(fraction(image, lit, right) === 0, 'a hidden mesh hides the octree');
  octree.dispose();
  await end();
  return 'An octree follows a mesh across the view, picks in world positions and hides with it';
}

/** One pick over meshes and points: depth order, clipping planes, shapes, hidden classes and engine.pick. */
async function gpuPicking() {
  const { box, PbrMaterial } = await import('@margoengine/core');
  const { PointCloud } = await import('@margoengine/points');
  const { PointPicking } = await import('../dist/pick.js');
  const { Picking } = await import('../../selection/dist/index.js');
  const { engine, frame, end, device } = await rig(),
    points = PointsPlugin.attach(engine),
    far = points.add(new PointCloud({ positions: [0, 0, -2, 2, 0, -2, 3, 3, 0], material: { size: 24 } })),
    near = points.add(new PointCloud({ positions: [2, 0, 1], material: { size: 24 }, reorder: true })),
    round = points.add(new PointCloud({ positions: [-3, 3, 0], material: { size: 40, shape: 'round' } })),
    ball = points.add(
      new PointCloud({
        positions: [-3, -3, 0],
        material: { size: 2, sizeUnits: 'world', shading: 'sphere', maxPixelSize: 256 },
      }),
    ),
    hidden = points.add(new PointCloud({ positions: [3, -3, 0], colors: new Uint8Array([9, 9, 9, 0]), colorComponents: 4, material: { size: 24 } }));
  const wall = engine
    .createMesh()
    .setGeometry(box(1, 1, 1))
    .setMaterial(new PbrMaterial({ color: '#808080' }))
    .setPosition([0, 0, 0]);
  const picking = Picking.attach(engine),
    overlay = PointPicking.attach(picking, points),
    pixel = (x, y, z) => {
      const d = 10 - z,
        scale = (0.5 * 256) / Math.tan(Math.PI / 6);
      return [128 + (x * scale) / d, 128 - (y * scale) / d];
    };
  await frame();
  const at = async (x, y, z = 0) => {
    const hit = await picking.pick(...pixel(x, y, z));
    await device.queue.onSubmittedWorkDone();
    return hit;
  };
  // A point behind the mesh is blocked; the mesh answers.
  const blocked = await at(0, 0, -2);
  assert(blocked?.mesh === wall && !blocked.cloud, `the mesh in front wins: ${blocked?.cloud?.name}`);
  assert(points.pick(...pixel(0, 0, -2))?.cloud === far, 'the CPU pick has no mesh to stop it');
  // Of two points on one pixel the nearer wins; a reordered cloud names the right point.
  const pair = await at(2, 0, 1);
  assert(pair?.cloud === near && pair.point === 0, 'the nearer point wins');
  assert(Math.abs(pair.position[2] - 1) < 1e-5, `world position: ${pair.position}`);
  const lone = await at(3, 3);
  assert(lone?.cloud === far && lone.point === 2, `the point's own index: ${lone?.point}`);
  // Clipping planes apply: cut, it no longer hits.
  far.material.clippingPlanes = [[-1, 0, 0, 2.5]];
  await frame();
  assert((await at(3, 3)) === null, 'a clipped point does not hit');
  assert(points.pick(...pixel(3, 3, 0))?.cloud === far, 'the CPU pick still finds it');
  far.material.clippingPlanes = [];
  await frame();
  // Round points hit on the disc, not in the corners of their quad.
  const [rx, ry] = pixel(-3, 3, 0);
  assert((await picking.pick(rx, ry))?.cloud === round, 'the centre of a round point hits');
  assert((await picking.pick(rx + 17, ry + 17)) === null, 'its corner does not');
  // A sphere hits at its curved depth: it is in front of a mesh that cuts through its middle.
  wall.setPosition([-3, -3, 0]);
  await frame();
  assert((await at(-3, -3))?.cloud === ball, 'the front of a sphere is nearer than its centre');
  wall.setPosition([0, 0, 0]);
  await frame();
  assert((await at(3, -3)) === null, 'alpha 0 does not hit');
  // engine.pick answers a mesh, which maps back to the cloud; a mesh-following cloud answers its mesh.
  const answer = await engine.pick(...pixel(3, 3, 0));
  assert(overlay.cloudOf(answer) === far, 'engine.pick answers the stand-in');
  const anchor = engine.createMesh();
  round.attach(anchor);
  await frame();
  assert((await picking.pick(rx, ry))?.mesh === anchor, 'a cloud that follows a mesh answers it');
  round.attach(null);
  // Point sizes in the tile are the view's pixels: a 24 px square hits 11 pixels out and misses 14 out.
  await frame();
  const [lx, ly] = pixel(3, 3, 0);
  assert((await picking.pick(lx + 10, ly))?.cloud === far, 'inside the square');
  assert((await picking.pick(lx + 15, ly)) === null, 'beyond the square and the tile');
  overlay.dispose();
  assert((await picking.pick(lx, ly)) === null, 'dispose leaves Picking');
  await end();
  return 'One GPU pick answers points and meshes by depth, honours clipping planes, shapes, hidden points and sphere depth, and maps back through engine.pick';
}

/** A colour of 4 scaled by a material colour of 0.25 lands on 1: only floats keep the energy past the clamp. */
async function hdrColors() {
  const { PointCloud } = await import('@margoengine/points');
  const { SurfelPlugin } = await import('../dist/surfels.js');
  const { engine, frame, end } = await rig(),
    points = PointsPlugin.attach(engine),
    surfels = SurfelPlugin.attach(engine, { name: 'surfels' }),
    colors = new Float32Array([4, 0, 0, 4, 0, 0, 4, 0, 0]),
    material = { size: 40, color: [0.25, 1, 1] },
    make = (x, extra) =>
      new PointCloud({ positions: [x, 2, 0, x, 0, 0, x, -2, 0], colors, colorSpace: 'linear', material, ...extra });
  points.add(make(-3));
  points.add(make(0, { colorFormat: 'float' }));
  surfels.add(make(3, { colorFormat: 'float' }));
  const image = await frame(),
    x = (v) => Math.round(128 + (v * 221.7) / 10),
    clamped = image.at(x(-3), 128)[0],
    float = image.at(x(0), 128)[0],
    disc = image.at(x(3), 128)[0];
  assert(clamped < 150, `rgba8 clamps to 1 first: ${clamped}`);
  assert(float > 250, `float keeps it: ${float}`);
  assert(disc > 250, `surfels read floats too: ${disc}`);
  await end();
  return `HDR colours pass the 0..1 clamp on a real GPU, in points and surfels (${float} and ${disc} against ${clamped})`;
}

/** A fine checker on a small point: with mips its average, without them one texel. Same for a world-sized sprite. */
async function mipmaps() {
  const { PointCloud, SpriteBatch } = await import('@margoengine/points');
  const size = 64,
    data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const v = ((i % size) + Math.floor(i / size)) % 2 ? 255 : 0;
    data.set([v, v, v, 255], i * 4);
  }
  const map = new ImageData(data, size, size),
    { engine, frame, end } = await rig(),
    points = PointsPlugin.attach(engine),
    x = (v) => Math.round(128 + (v * 221.7) / 10),
    y = 128;
  // 7 pixels, so samples drift across the texels: at 8 each lands where four texels meet and reads as grey anyway.
  const smooth = { map, size: 7, mapFilter: 'linear' };
  points.add(new PointCloud({ positions: [-3, 0, 0], material: smooth }));
  points.add(new PointCloud({ positions: [-1, 0, 0], material: { ...smooth, mipmaps: false } }));
  points.add(new SpriteBatch({ material: { map, mipmaps: true, transparent: false }, sprites: [{ position: [1, 0, 0], size: 0.4 }] }));
  points.add(new SpriteBatch({ material: { map, transparent: false }, sprites: [{ position: [3, 0, 0], size: 0.4 }] }));
  const image = await frame(),
    // The spread of brightness across a point: small for an even grey, large for raw texels.
    spread = (at) => {
      let low = 255,
        high = 0;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const v = image.at(at + dx, y + dy)[0];
          low = Math.min(low, v);
          high = Math.max(high, v);
        }
      return { low, high, range: high - low };
    },
    pointMips = spread(x(-3)),
    pointRaw = spread(x(-1)),
    spriteMips = spread(x(1)),
    spriteRaw = spread(x(3));
  assert(pointMips.range < 10, `a point with mips is even: ${JSON.stringify(pointMips)}`);
  // Linear grey: the average of black and white is 50 percent light, about 188 in sRGB.
  assert(Math.abs(pointMips.low - 188) < 12, `the average is taken in linear light: ${pointMips.low}`);
  assert(spriteMips.range < 10, `a sprite with mips is even: ${JSON.stringify(spriteMips)}`);
  assert(pointRaw.range > 40 || Math.abs(pointRaw.low - 188) > 12, `without mips it aliases: ${JSON.stringify(pointRaw)}`);
  assert(spriteRaw.range > 40 || Math.abs(spriteRaw.low - 188) > 12, `without mips it aliases: ${JSON.stringify(spriteRaw)}`);
  await end();
  return `Mips smooth a fine map on small points and sprites (spread ${pointMips.range} and ${spriteMips.range} against ${pointRaw.range} and ${spriteRaw.range})`;
}

window.runFeatures = async () => {
  const checks = [];
  for (const check of [adaptiveSize, surfels, surfelDepth, potree, octreeTransform, gpuPicking, hdrColors, mipmaps]) checks.push(await check());
  return checks;
};
