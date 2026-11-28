import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, hardware, close } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_PLANT_GUST_FRAMES === '1' ? 'packages/scatter/test-results/plant-gust' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function bladeMask(image, [x, y]) {
  const left = Math.round(x) - 49;
  const top = Math.round(y) - 7;
  let count = 0;
  let moment = 0;
  const pixels = [];
  for (let j = top; j <= top + 14; j++) {
    for (let i = left; i <= left + 98; i++) {
      const offset = 4 * (j * image.width + i);
      const [r, g, b] = image.data.subarray(offset, offset + 3);
      pixels.push(r, g, b);
      if (g > 1.25 * r && g > 1.4 * b) {
        count++;
        moment += i;
      }
    }
  }
  assert(count > 30, 'The fixed-camera region must contain visible blades');
  return { center: moment / count, pixels };
}

try {
  const setup = await page.evaluate(async () => {
    const [
      { EngineKernel },
      { planeGeometry },
      { UnlitMaterial, createMesh },
      { PlantSway, PLANT_SWAY_WORDS },
      { BoundaryLayerSolver },
      { PhysicsWorld, regionWords },
      { BoundaryLayerWind },
      { travellingGust },
      { FilmClock },
      { GrassScatter },
      { PlantMotion },
      { Font, Text, TextRenderer },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/geometry/dist/index.js'),
      import('/packages/materials/dist/index.js'),
      import('/packages/physics/dist/vegetation.js'),
      import('/packages/physics/dist/boundary-layer.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/weather/dist/boundary-layer.js'),
      import('/packages/weather/dist/turbulence.js'),
      import('/packages/math/dist/clock.js'),
      import('/packages/scatter/dist/grass.js'),
      import('/packages/scatter/dist/plant-motion.js'),
      import('/packages/text/dist/index.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);
    const roots = [
      [-2, 0, 0],
      [0, 0, 0],
      [2, 0, 0],
    ];
    const height = 0.67;
    const front = { origin: [-3, 0, 0], start: 0.5, speed: 4, length: 3, amplitude: [8, 0, 0] };
    const air = await BoundaryLayerSolver.load({ id: 'meadow-air' });
    const sway = await PlantSway.load();
    const grid = { cells: [roots.length, 3, 2], spacing: [2, height / 2, 1], origin: roots[0] };
    const hz = 60;
    const film = new FilmClock({ fps: hz });
    const world = new PhysicsWorld({ rate: film.fps }).add(air, {
      profile: new BoundaryLayerWind({ speed: 0, turbulence: false, roughness: 0.03 }).profile,
      grid,
    });
    const gust = travellingGust(air, front);
    world.add(sway, {
      flow: gust,
      plants: roots.map((root) => ({
        root,
        height,
        baseDiameter: 0.017,
        tipDiameter: 0.014,
        density: 850,
        youngModulus: 2.5e7,
        dampingRatio: 0.2,
        addedMassCoefficient: 0,
      })),
    });
    let reads = 0;
    const motion = new PlantMotion({
      roots: roots.map(([x, , z]) => ({ xz: [x, z], height })),
      cellSize: 1,
      origin: [-0.5, -0.5],
      readSway() {
        const port = world.fields.port(sway.swayField.name);
        const live = sway.readSway();
        if (!port || port.region.type !== 'f64' || port.region.layout !== 1)
          throw new Error('PlantMotion requires the current layout-1 f64 sway region.');
        const accepted = regionWords(world.memory, port.region);
        if (accepted.length !== roots.length * PLANT_SWAY_WORDS || live.some((value, i) => value !== accepted[i]))
          throw new Error('PlantMotion poses must match the registered accepted sway field.');
        reads++;
        return live;
      },
    });

    const width = 640;
    const heightPx = 360;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:640px;height:360px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, heightPx],
      camera: { position: [0, 1.22, 6.45], target: [0, 0.35, 0], fov: 34, near: 0.35, far: 36 },
    });
    engine.scene.background = '#c2d5d3';
    engine.lighting.direction.set([-0.48, 0.8, 0.37, 1.9]);
    engine.lighting.radiance.set([1, 0.89, 0.72, 0.8]);
    engine.lighting.ambient.set([0.58, 0.69, 0.78]);
    const meadow = planeGeometry(32, 34, 40, 42);
    for (let i = 0; i < meadow.positions.length; i += 3) {
      const x = meadow.positions[i];
      const z = -meadow.positions[i + 1] - 8;
      const rise = Math.max(0, Math.min(1, (-z - 1) / 10));
      meadow.positions[i + 1] = rise * (0.88 + 0.48 * Math.sin(0.49 * x + 0.2 * z));
      meadow.positions[i + 2] = z;
    }
    createMesh(engine, meadow, new UnlitMaterial({ color: '#796c49' }));
    const patches = roots.map((root, i) =>
      GrassScatter.attach(engine, {
        count: 11,
        center: root,
        area: [0.48, 0.63],
        scale: [1, 1],
        lod: [14, 18, 22],
        lodFade: 0,
        color: [0.16, 0.42, 0.095],
        grass: {
          height,
          width: 0.028,
          blades: 8,
          heightVariance: 0.04,
          radius: 0.076,
          lean: 0.11,
          segments: [12, 7, 4],
        },
        seed: 57 + i,
        states: motion,
        wind: [1, 0, 0],
      }),
    );
    const glyphs = TextRenderer.attach(engine);
    const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
    const labels = new Font({ family: 'ui-monospace, monospace', weight: 400 });
    const text = (content, position, font, fontSize, color) =>
      glyphs.add(new Text({ text: content, position, font, fontSize, color, onTop: true, anchorY: 'middle' }));
    text('Wind crosses the meadow', [-2.9, 1.73, 0], title, 0.26, '#213b37');
    text('Gust front  ' + front.speed + ' m/s', [-2.9, 1.49, 0], labels, 0.105, '#36534e');
    for (const [x] of roots) text(x - front.origin[0] + ' m', [x - 0.15, 0.095, 0.85], labels, 0.115, '#f0e6c8');

    const gpu = engine.gpu;
    const gpuErrors = [];
    engine.onError = (error) => gpuErrors.push(String(error));
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    gpu.pushErrorScope('validation');
    const draw = async () => {
      engine.render({ delta: 0 });
      await gpu.queue.onSubmittedWorkDone();
    };
    await waitForPipelines(draw);
    function pixel([x, y, z]) {
      const m = engine.camera.matrix;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [
        (width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w)) / 2,
        (heightPx * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w)) / 2,
      ];
    }
    const start = 12;
    const lastStep = 170;
    let frame = 0;
    let arrivals = roots.map(() => null);
    const initial = world.takeSnapshot();
    const snapshots = new Map([[0, initial.bytes]]);
    let saved;
    window.meadow = {
      async at(shotFrame, action) {
        film.frame = shotFrame;
        const goal = Math.max(0, Math.min(lastStep, film.frame - start));
        if (action === 'restore') {
          world.restoreSnapshot(saved.snapshot.bytes);
          frame = saved.frame;
          arrivals = saved.arrivals.slice();
        } else if (goal < frame) {
          world.restoreSnapshot(initial.bytes);
          frame = 0;
          arrivals.fill(null);
        }
        while (frame < goal) {
          world.advance(++frame);
          for (let i = 0; i < roots.length; i++) {
            if (arrivals[i] === null && sway.sample(i, height).displacement[0] !== 0) arrivals[i] = frame;
          }
        }
        const snapshot = world.takeSnapshot();
        const prior = snapshots.get(frame);
        if (!prior) snapshots.set(frame, snapshot.bytes);
        else if (prior.length !== snapshot.bytes.length || snapshot.bytes.some((value, i) => value !== prior[i]))
          throw new Error('Held and replayed physics snapshots must match byte for byte.');
        if (action === 'save') saved = { snapshot, frame, arrivals: arrivals.slice() };
        const readsBefore = reads;
        await draw();
        if (reads === readsBefore) throw new Error('GrassScatter did not read the accepted plant poses.');
        const airField = world.fields.port(air.sampleField.name);
        if (!airField || airField.region.type !== 'f64' || airField.region.layout !== 1)
          throw new Error('The gust must start from the current boundary-layer air field.');
        const airRows = regionWords(world.memory, airField.region);
        const probeHeight = 0.87 * height;
        const poses = roots.map(([x, y, z], i) => {
          const base = air.sample(x, y + height, z, world.time);
          const atTip = gust.sample(x, y + height, z, world.time);
          const topRow = (grid.cells[1] - 1) * grid.cells[0];
          const row = 5 * (topRow + i);
          if (
            !base.velocity.every((value, axis) => value === airRows[row + axis]) ||
            base.density !== airRows[row + 3] ||
            base.temperature !== airRows[row + 4]
          )
            throw new Error('The gust base must agree with the registered boundary-layer row.');
          const [dx, dz] = sway.sample(i, probeHeight).displacement;
          return {
            root: sway.sample(i, 0).displacement,
            tip: sway.sample(i, height).displacement,
            wind: atTip.velocity,
            air: [base.density, atTip.density, base.temperature, atTip.temperature],
            reference: pixel([x, y + probeHeight, z]),
            projected: pixel([x + dx, y + probeHeight, z + dz]),
          };
        });
        return { hash: snapshot.hash, time: world.time, arrivals: arrivals.slice(), poses };
      },
      async dispose() {
        for (const patch of patches) patch.dispose();
        motion.dispose();
        glyphs.dispose();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        sway[Symbol.dispose]();
        air[Symbol.dispose]();
        return { validation, gpuErrors };
      },
    };
    return { start, lastStep, hz, front, roots };
  });

  const render = (frame, action) => page.evaluate(([f, a]) => window.meadow.at(f, a), [frame, action]);
  const still = await render(0);
  const stillPixels = await capture('rest');
  assert.deepEqual(await render(setup.start - 1), still);
  assert.deepEqual((await capture('held-rest')).data, stillPixels.data);

  const nearFrame = setup.start + 74;
  const farFrame = setup.start + 134;
  const endFrame = setup.start + setup.lastStep;
  const near = await render(nearFrame, 'save');
  const nearPixels = await capture('near-gust');
  const far = await render(farFrame);
  const farPixels = await capture('far-gust');
  const end = await render(endFrame);
  const endPixels = await capture('end');
  assert.deepEqual(await render(endFrame + 15), end);
  assert.deepEqual((await capture('held-end')).data, endPixels.data);
  assert.deepEqual(await render(nearFrame, 'restore'), near);
  assert.deepEqual((await capture('restored')).data, nearPixels.data);
  assert.deepEqual(await render(farFrame), far);
  assert.deepEqual((await capture('replay')).data, farPixels.data);
  assert.deepEqual(await render(endFrame), end);
  assert.deepEqual((await capture('replay-end')).data, endPixels.data);
  assert.deepEqual(await page.evaluate(() => window.meadow.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);

  const { front, roots, hz } = setup;
  const edges = roots.map(([x]) => front.start + (x - front.origin[0]) / front.speed);
  // The continuous front is zero at the crossing itself. The next tick samples inside the gust.
  assert.deepEqual(
    far.arrivals,
    edges.map((seconds) => Math.floor(seconds * hz) + 1),
  );
  assert.deepEqual(near.arrivals, [far.arrivals[0], null, null]);
  assert.deepEqual(near.poses[2].tip, [0, 0]);
  assert(near.poses[0].tip[0] > 0.1 && far.poses[2].tip[0] > 0.1);
  assert(Math.abs(near.poses[0].tip[0] - far.poses[2].tip[0]) < 1e-12);
  for (const shot of [still, near, far, end]) {
    for (const [i, pose] of shot.poses.entries()) {
      const d = front.speed * (shot.time - edges[i]);
      // 14 CFR 25.341(a)(2), with H = length / 2. This checks the authored pulse geometry.
      const expected =
        d > 0 && d < front.length ? (front.amplitude[0] / 2) * (1 - Math.cos((2 * Math.PI * d) / front.length)) : 0;
      assert(Math.abs(pose.wind[0] - expected) < 1e-12);
      assert.deepEqual(pose.wind.slice(1), [0, 0]);
      assert.deepEqual(pose.root, [0, 0]);
      const [baseDensity, gustDensity, baseTemperature, gustTemperature] = pose.air;
      assert(baseDensity > 0 && baseTemperature > 0);
      assert.equal(gustDensity, baseDensity);
      assert.equal(gustTemperature, baseTemperature);
    }
  }
  const nearRest = bladeMask(stillPixels, near.poses[0].reference);
  const farRest = bladeMask(stillPixels, far.poses[2].reference);
  assert.deepEqual(bladeMask(nearPixels, far.poses[2].reference).pixels, farRest.pixels);
  const shifts = [
    bladeMask(nearPixels, near.poses[0].reference).center - nearRest.center,
    bladeMask(farPixels, far.poses[2].reference).center - farRest.center,
  ];
  for (const [i, pose] of [near.poses[0], far.poses[2]].entries()) {
    const expected = pose.projected[0] - pose.reference[0];
    assert(expected > 6 && shifts[i] > 5, 'Visible blades must travel downwind with their accepted plants');
    assert(Math.abs(shifts[i] - expected) < 4, `Drew ${shifts[i]} px against projected ${expected} px of blade travel`);
  }
  console.log(
    `  ${backend} meadow gust: front at ${edges.join('/')} s, first sway frames ${far.arrivals.join('/')}, visible travel ${shifts.map((value) => value.toFixed(2)).join('/')} px, replay ${far.hash}`,
  );
} finally {
  await close();
}
