import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, hardware, close } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_PLANT_SURGE_FRAMES === '1' ? 'packages/scatter/test-results/plant-surge' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function grassMask(image, [x, y], span, height) {
  let count = 0;
  let moment = 0;
  for (let j = Math.round(y - height); j <= Math.round(y + height); j++) {
    for (let i = Math.round(x - span); i <= Math.round(x + span); i++) {
      if (i < 0 || i >= image.width || j < 0 || j >= image.height) continue;
      const p = 4 * (j * image.width + i);
      const [r, g, b] = image.data.subarray(p, p + 3);
      if (g > 1.25 * r && g > 1.4 * b) {
        count++;
        moment += i;
      }
    }
  }
  assert(count > 8, `Visible blades expected at ${x}, ${y}, got ${count} green pixels`);
  return moment / count;
}

try {
  const setup = await page.evaluate(async () => {
    const [
      { EngineKernel, PbrMaterial, box },
      { PlantSway, PLANT_SWAY_WORDS },
      { SpectralSea },
      { PhysicsWorld, regionWords },
      { FilmClock },
      { GrassScatter },
      { PlantMotion },
      { Font, Text, TextRenderer },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/vegetation.js'),
      import('/packages/physics/dist/sea.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/math/dist/clock.js'),
      import('/packages/scatter/dist/grass.js'),
      import('/packages/scatter/dist/plant-motion.js'),
      import('/packages/text/dist/index.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);
    const amplitude = 0.18;
    const frequency = 0.6;
    const omega = 2 * Math.PI * frequency;
    const gravity = 9.81;
    const waveNumber = (omega * omega) / gravity;
    const wavelength = (2 * Math.PI) / waveNumber;
    const height = 0.78;
    // Equal wave phase in X at two depths. The small removable mounts mark the planted locations.
    const roots = [
      [-wavelength / 2, -1.18, 0],
      [wavelength / 2, -2.75, 0],
    ];
    const sea = new SpectralSea({
      seed: 11,
      waves: {
        frequencies: Float64Array.of(frequency),
        directions: Float64Array.of(0),
        energy: Float64Array.of((amplitude * amplitude) / (4 * Math.PI * frequency)),
        depth: Infinity,
        density: 1025,
      },
    });
    const sway = await PlantSway.load();
    const film = new FilmClock({ fps: 60 });
    const world = new PhysicsWorld({ rate: film.fps, gravity: [0, -gravity, 0] }).add(sway, {
      flow: sea.water,
      plants: roots.map((root) => ({
        root,
        height,
        baseDiameter: 0.015,
        tipDiameter: 0.012,
        density: 1028,
        youngModulus: 6e7,
        dampingRatio: 0.12,
        addedMassCoefficient: 1,
      })),
    });
    let reads = 0;
    const motion = new PlantMotion({
      roots: roots.map(([x, , z]) => ({ xz: [x, z], height })),
      cellSize: 0.5,
      origin: [-0.125, -0.125],
      readSway() {
        const port = world.fields.port(sway.swayField.name);
        const live = sway.readSway();
        if (!port || port.region.type !== 'f64' || port.region.layout !== 1)
          throw new Error('PlantMotion needs the live layout-1 f64 sway field.');
        const accepted = regionWords(world.memory, port.region);
        if (accepted.length !== roots.length * PLANT_SWAY_WORDS || live.some((value, i) => value !== accepted[i]))
          throw new Error('The rendered rows must match the accepted sway port.');
        reads++;
        return live;
      },
    });

    const width = 620;
    const heightPx = 350;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:620px;height:350px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, heightPx],
      camera: { position: [0, -1.2, 7.2], target: [0, -1.6, 0], fov: 34, near: 0.35, far: 28 },
    });
    engine.scene.background = '#193c4a';
    engine.lighting.direction.set([-0.38, 0.82, 0.43, 1.55]);
    engine.lighting.radiance.set([0.88, 0.96, 1, 0.65]);
    engine.lighting.ambient.set([0.52, 0.75, 0.87]);
    const material = new PbrMaterial({ color: '#586966', roughness: 0.94 });
    for (const [x, y, z] of roots) {
      engine
        .createMesh()
        .setGeometry(box(2.65, 0.28, 0.75))
        .setMaterial(material)
        .setPosition([x, y - 0.14, z - 0.12]);
    }
    const patches = roots.map((root, i) =>
      GrassScatter.attach(engine, {
        count: 1,
        center: root,
        area: [0.0001, 0.0001],
        scale: [1, 1],
        lod: [14, 18, 22],
        lodFade: 0,
        color: [0.13, 0.43, 0.11],
        grass: { height, width: 0.035, blades: 9, heightVariance: 0, radius: 0.078, lean: 0.12, segments: [12, 7, 4] },
        seed: 31 + i,
        states: motion,
        wind: [1, 0, 0],
      }),
    );
    const glyphs = TextRenderer.attach(engine);
    const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
    const labels = new Font({ family: 'ui-monospace, monospace', weight: 400 });
    const text = (content, position, font, fontSize, color) =>
      glyphs.add(new Text({ text: content, position, font, fontSize, color, onTop: true, anchorY: 'middle' }));
    text('Seagrass under wave surge', [-3.54, 0.26, 0], title, 0.3, '#deebec');
    text('1.18 m BELOW MEAN SURFACE', [-3.45, -1.6, 0.33], labels, 0.098, '#c2ceca');
    text('2.75 m BELOW MEAN SURFACE', [0.97, -3.17, 0.33], labels, 0.098, '#c2ceca');

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
    const initial = world.takeSnapshot();
    const start = 12;
    const end = 132;
    let saved;
    let frame = 0;
    window.surge = {
      async at(shotFrame, action) {
        film.frame = shotFrame;
        const goal = Math.max(0, Math.min(end - start, film.frame - start));
        if (action === 'restore') {
          world.restoreSnapshot(saved.snapshot.bytes);
          frame = saved.frame;
        } else if (goal < frame) {
          world.restoreSnapshot(initial.bytes);
          frame = 0;
        }
        world.advance(goal);
        frame = goal;
        const snapshot = world.takeSnapshot();
        if (action === 'save') saved = { snapshot, frame };
        const readsBefore = reads;
        await draw();
        if (reads === readsBefore) throw new Error('GrassScatter must draw the accepted plant poses.');
        const row = sway.readSway();
        return {
          hash: snapshot.hash,
          time: world.time,
          poses: roots.map(([x, y, z], i) => {
            const dx = sway.sample(i, height).displacement;
            if (dx[0] !== row[i * PLANT_SWAY_WORDS] + row[i * PLANT_SWAY_WORDS + 2])
              throw new Error('Both tip-normalized modes must feed the same pose.');
            const probeHeight = 0.88 * height;
            const [probeX, probeZ] = sway.sample(i, probeHeight).displacement;
            return {
              root: sway.sample(i, 0).displacement,
              dx,
              velocity: sea.water.sample(x, y + height, z, world.time).velocity,
              reference: pixel([x, y + probeHeight, z]),
              expected: pixel([x + probeX, y + probeHeight, z + probeZ]),
              rootPixel: pixel([x, y + 0.1 * height, z]),
            };
          }),
        };
      },
      async dispose() {
        for (const patch of patches) patch.dispose();
        motion.dispose();
        glyphs.dispose();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, gpuErrors };
      },
    };
    return { start, end, height, roots, omega, waveNumber, amplitude };
  });

  const render = (frame, action) => page.evaluate(([f, a]) => window.surge.at(f, a), [frame, action]);
  const start = await render(0);
  const rest = await capture('rooted');
  assert.deepEqual(await render(setup.start - 1), start);
  assert.deepEqual((await capture('held-rooted')).data, rest.data);
  const left = await render(setup.start + 32, 'save');
  const leftPixels = await capture('westward');
  const right = await render(setup.start + 78);
  const rightPixels = await capture('eastward');
  const end = await render(setup.end);
  const endPixels = await capture('end');
  assert.deepEqual(await render(setup.end + 15), end);
  assert.deepEqual((await capture('held-end')).data, endPixels.data);
  assert.deepEqual(await render(setup.start + 32, 'restore'), left);
  assert.deepEqual((await capture('restored')).data, leftPixels.data);
  assert.deepEqual(await render(setup.start + 78), right);
  assert.deepEqual((await capture('replay')).data, rightPixels.data);
  assert.deepEqual(await render(setup.end), end);
  assert.deepEqual((await capture('replay-end')).data, endPixels.data);
  assert.deepEqual(await page.evaluate(() => window.surge.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);

  // Deep-water Airy orbital speed aω exp(ky), independently of wave phase. FHWA HEC-25 (2020), Chapter 5.
  for (const shot of [start, left, right, end]) {
    for (const [i, pose] of shot.poses.entries()) {
      const y = setup.roots[i][1] + setup.height;
      const amplitude = setup.amplitude * setup.omega * Math.exp(setup.waveNumber * y);
      assert(Math.abs(Math.hypot(...pose.velocity) - amplitude) < 1e-12);
      assert.deepEqual(pose.root, [0, 0]);
    }
  }
  assert(left.poses[0].dx[0] < 0 && right.poses[0].dx[0] > 0);
  const shallowTravel = right.poses[0].dx[0] - left.poses[0].dx[0];
  const deepTravel = Math.abs(right.poses[1].dx[0] - left.poses[1].dx[0]);
  assert(deepTravel > 0 && shallowTravel > deepTravel);
  const measured = left.poses.map((pose, i) => {
    const from = grassMask(leftPixels, pose.reference, 32, 5);
    const to = grassMask(rightPixels, right.poses[i].reference, 32, 5);
    return to - from;
  });
  const projected = right.poses[0].expected[0] - left.poses[0].expected[0];
  assert(projected > 12 && measured[0] > 8 && measured[0] > Math.abs(measured[1]));
  assert(
    Math.abs(measured[0] - projected) < 5,
    `Drew ${measured[0]} px against projected ${projected} px of tip travel`,
  );
  const base = left.poses[0].rootPixel;
  assert(Math.abs(grassMask(leftPixels, base, 15, 2) - grassMask(rightPixels, base, 15, 2)) <= 1);
  console.log(
    `  ${backend} seagrass surge: ${(100 * shallowTravel).toFixed(2)} cm shallower motion / ${(100 * deepTravel).toFixed(2)} cm deeper, ${measured[0].toFixed(2)} px visible travel at fixed root, replay ${right.hash}`,
  );
} finally {
  await close();
}
