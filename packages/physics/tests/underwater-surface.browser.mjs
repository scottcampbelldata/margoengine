import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_UNDERWATER_FRAMES === '1' ? 'packages/physics/test-results/underwater-waveguide' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function rgbDifference(a, b, pixel) {
  return (
    Math.abs(a.data[pixel] - b.data[pixel]) +
    Math.abs(a.data[pixel + 1] - b.data[pixel + 1]) +
    Math.abs(a.data[pixel + 2] - b.data[pixel + 2])
  );
}

function changedPixels(a, b) {
  assert.equal(a.data.length, b.data.length);
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) if (rgbDifference(a, b, i) >= 24) changed++;
  return changed;
}

function changedNear(a, b, [x, y]) {
  let changed = 0;
  for (let j = Math.floor(y) - 3; j <= Math.ceil(y) + 3; j++) {
    for (let i = Math.floor(x) - 3; i <= Math.ceil(x) + 3; i++) {
      if (i < 0 || i >= a.width || j < 0 || j >= a.height) continue;
      if (rgbDifference(a, b, 4 * (j * a.width + i)) >= 24) changed++;
    }
  }
  return changed;
}

try {
  await page.evaluate(async () => {
    const [
      { EngineKernel, PbrMaterial, box },
      { PhysicsWorld, regionWords },
      { ACOUSTIC_FIELD_LAYOUT, UnderwaterAcousticsSolver },
      { FilmClock },
      { Line, Lines },
      { Text, TextRenderer, Font },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/physics/dist/underwater.js'),
      import('/packages/math/dist/clock.js'),
      import('/packages/lines/dist/index.js'),
      import('/packages/text/dist/index.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);

    // Homogeneous shallow-water cutaway. All depths and ranges use metres.
    const speed = 1488;
    const bottom = 56;
    const launchDepth = 24;
    const launch = [
      { depth: launchDepth, declination: 0, frequency: 1500, waist: 6, pressure: 1 },
      { depth: launchDepth, declination: -0.31, frequency: 1500, waist: 6, pressure: 1 },
      { depth: launchDepth, declination: 0.3, frequency: 1500, waist: 6, pressure: 1 },
    ];
    const settings = {
      profile: [
        { depth: 0, speed },
        { depth: bottom, speed },
      ],
      surfaceReflection: -1,
      bottomReflection: 0.63,
      absorption: 3,
      rays: launch,
    };
    const solver = new UnderwaterAcousticsSolver({ id: 'waveguide' });
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, settings);
    const clock = new FilmClock({ fps: 60 });
    const triggerFrame = 12;
    const slowBy = 6;
    const lastStep = 12;
    const initial = world.takeSnapshot();

    // Separate the physical trace clock from the displayed slow-motion clock.
    function read(tick) {
      const ports = solver.exportPorts(tick);
      const view = (field, count) => {
        const port = ports.find((value) => value.field === field.name);
        if (!port || port.region.layout !== ACOUSTIC_FIELD_LAYOUT || port.region.type !== 'f64')
          throw new Error('The waveguide display requires the layout-1 acoustic ports.');
        const values = regionWords(world.memory, port.region);
        if (values.length !== count) throw new Error('An accepted acoustic port has the wrong row count.');
        return values;
      };
      const path = view(solver.pathField, 12);
      const signal = view(solver.signalField, 6);
      const delay = view(solver.delayField, 3);
      return launch.map((_, i) => {
        const sample = solver.sample(i);
        const [range, depth, length, width] = path.subarray(4 * i, 4 * i + 4);
        const real = signal[i * 2];
        const imaginary = signal[i * 2 + 1];
        if (
          ![range, depth, length, width, real, imaginary, delay[i]].every(Number.isFinite) ||
          sample.range !== range ||
          sample.depth !== depth ||
          sample.pathLength !== length ||
          sample.width !== width ||
          sample.travelTime !== delay[i]
        )
          throw new Error('Acoustic geometry and delay must come from the same accepted ray.');
        return {
          range,
          depth,
          length,
          width,
          delay: delay[i],
          reflections: sample.reflections,
          direction: sample.declination,
          pressure: Math.sign(sample.pressure) * Math.hypot(real, imaginary),
        };
      });
    }

    const started = read(0);
    let history = [started];
    let current = 0;
    function seek(target) {
      if (target < current) {
        world.restoreSnapshot(initial.bytes);
        history = [started];
        current = 0;
      }
      for (; current < target; current++) {
        world.advance(current + 1);
        history.push(read(world.tick));
      }
    }

    const width = 512;
    const height = 258;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:512px;height:258px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, height],
      antialias: true,
      camera: { position: [172, 10, 318], target: [153, -25, 0], fov: 34, near: 12, far: 840 },
    });
    engine.scene.background = '#17283a';
    engine.lighting.direction.set([-0.36, 0.79, 0.49, 1.7]);
    engine.lighting.radiance.set([1, 0.93, 0.83, 0.56]);
    engine.lighting.ambient.set([0.71, 0.79, 0.91]);
    const mat = (color, roughness = 0.9) => new PbrMaterial({ color, roughness });
    const water = mat('#274e65');
    const floor = mat('#75675b');
    const surface = mat('#a4c2c6');
    const mount = mat('#3e4c5b');
    const probe = mat('#c79457', 0.46);
    const solid = (size, material, position) =>
      engine
        .createMesh()
        .setGeometry(box(...size))
        .setMaterial(material)
        .setPosition(position);
    solid([334, bottom, 11], water, [151, -bottom / 2, -16]);
    solid([337, 7, 17], floor, [151, -bottom - 3.5, -15.5]);
    solid([335, 1.5, 14], surface, [151, 0.78, -15]);
    solid([19, 3.3, 4.5], mount, [-12.5, -launchDepth, -1.4]);
    solid([3.1, 5.4, 5.2], probe, [-0.8, -launchDepth, -0.2]);
    for (const depth of [0, 14, 28, 42, 56]) solid([3, 0.85, 1.1], surface, [-17.4, -depth, -5]);

    const colors = ['#8ad9fa', '#ffcc8c', '#a6e0b6'];
    const names = ['Direct', 'Surface first', 'Seabed first'];
    const lines = Lines.attach(engine);
    const traces = colors.map((color) =>
      lines.add(new Line({ positions: [0, -launchDepth, 1, 0, -launchDepth, 1], width: 2.4, color, visible: false })),
    );
    const glyphs = TextRenderer.attach(engine);
    const sans = new Font({ family: 'Arial, sans-serif', weight: 600 });
    const numbers = new Font({ family: 'ui-monospace, monospace', weight: 400 });
    function label(text, position, fontSize, color, font = sans) {
      return glyphs.add(new Text({ text, position, fontSize, font, color, onTop: true, anchorY: 'middle' }));
    }
    label('Shallow-water acoustics', [-15, 32, 2], 12, '#e8f0f3');
    label('56 m depth  /  1,488 m/s sound speed', [-14, 18, 2], 7.8, '#9fb5c1', numbers);
    label('Surface', [-13, 6, 2], 6, '#ccdde4');
    label('Seabed', [-13, -67, 2], 6, '#ccdde4');
    const readings = names.map((name, i) => {
      const x = -13 + i * 113;
      label(name, [x, -82, 2], 7.6, colors[i]);
      return label('', [x, -94, 2], 7.8, '#dfe8ec', numbers);
    });

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

    function position([range, depth]) {
      return [range, -depth, 1];
    }
    function pixel(point) {
      const [x, y, z] = position(point);
      const m = engine.camera.matrix;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      const u = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
      const v = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      return [((u + 1) * width) / 2, ((1 - v) * height) / 2];
    }

    let checkpoint;
    window.waveguideShot = {
      async at(shotFrame, action) {
        clock.frame = shotFrame;
        const frame = Math.min(lastStep, Math.max(0, Math.floor((clock.frame - triggerFrame) / slowBy)));
        if (action === 'restore') {
          world.restoreSnapshot(checkpoint.snapshot.bytes);
          current = checkpoint.frame;
          history = checkpoint.history.slice();
        }
        seek(frame);
        const snapshot = world.takeSnapshot();
        if (action === 'save') checkpoint = { snapshot, frame, history: history.slice() };
        const active = frame > 0;
        const axis = history[frame];
        const bounces = [];
        const tips = [];
        for (const [ray, trace] of traces.entries()) {
          trace.visible = active;
          readings[ray].text = active
            ? (axis[ray].delay * 1000).toFixed(1) + ' ms · ' + axis[ray].pressure.toFixed(3) + ' Pa'
            : 'Ready';
          const line = [[started[ray].range, started[ray].depth]];
          const reflections = [];
          for (let q = 1; q <= frame; q++) {
            const previous = history[q - 1][ray];
            const next = history[q][ray];
            if (next.reflections > previous.reflections) {
              if (next.reflections !== previous.reflections + 1)
                throw new Error('Choose a larger depth for one reflection per display step.');
              const boundary = previous.direction < 0 ? 0 : bottom;
              // The two accepted straight pieces have equal incidence angles in this constant-speed layer.
              const first = Math.abs(previous.depth - boundary);
              const second = Math.abs(next.depth - boundary);
              const hit = [previous.range + ((next.range - previous.range) * first) / (first + second), boundary];
              line.push(hit);
              reflections.push(hit);
            }
            line.push([next.range, next.depth]);
          }
          if (active) trace.setPositions(line.flatMap(position));
          bounces.push(reflections);
          tips.push(line.at(-1));
        }
        await draw();
        return {
          hash: snapshot.hash,
          axis,
          frame,
          bounces,
          bouncePixels: bounces.flatMap((points) => points.map(pixel)),
          tipPixels: tips.map(pixel),
          strokes: { ...lines.stats },
          labels: { ...glyphs.stats },
          sceneDraws: engine.stats.drawCalls,
        };
      },
      async dispose() {
        lines.dispose();
        glyphs.dispose();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, gpuErrors };
      },
    };
  });

  const render = (frame, action) => page.evaluate(([f, a]) => window.waveguideShot.at(f, a), [frame, action]);
  const ready = await render(0);
  const bare = await capture('ready');
  const hold = await render(11);
  const holdImage = await capture('pre-trigger');
  const emitted = await render(30);
  const early = await capture('emitted');
  const reflected = await render(42, 'save');
  const middle = await capture('reflected');
  const stop = await render(84);
  const final = await capture('held');
  const held = await render(109);
  const holdFinal = await capture('after-stop');
  const rewind = await render(42, 'restore');
  const rewindImage = await capture('rewind');
  const replay = await render(84);
  const replayImage = await capture('replay');
  const startAgain = await render(0);
  const bareAgain = await capture('clear');
  assert.deepEqual(await page.evaluate(() => window.waveguideShot.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);
  assert.deepEqual(ready, hold);
  // Returning before the trigger removes previous paths and rereads the launch state.
  assert.deepEqual(startAgain, ready);
  assert.deepEqual(rewind, reflected);
  assert.deepEqual(replay, stop);
  assert.deepEqual(held, stop);
  assert.deepEqual(bare.data, holdImage.data);
  assert.deepEqual(bareAgain.data, bare.data);
  assert.deepEqual(rewindImage.data, middle.data);
  assert.deepEqual(replayImage.data, final.data);
  assert.deepEqual(holdFinal.data, final.data);

  assert.deepEqual(
    ready.axis.map((ray) => ray.reflections),
    [0, 0, 0],
  );
  assert.deepEqual(
    emitted.axis.map((ray) => ray.reflections),
    [0, 0, 0],
  );
  assert.deepEqual(
    reflected.axis.map((ray) => ray.reflections),
    [0, 1, 1],
  );
  assert.deepEqual(
    stop.axis.map((ray) => ray.reflections),
    [0, 2, 1],
  );
  const speed = 1488;
  const launchDepth = 24;
  const bottom = 56;
  // Twelve accepted steps at up to 80 rounded operations each, plus 64 for the reference and fold.
  const closeTo = (actual, expected, scale = Math.max(1, Math.abs(expected))) =>
    assert.ok(Math.abs(actual - expected) <= 1024 * Number.EPSILON * scale, actual + ' versus ' + expected);
  for (const stage of [emitted, reflected, stop]) {
    const time = stage.frame / 60;
    const length = speed * time;
    const width = Math.hypot(6, (speed * length) / (Math.PI * 1500 * 6));
    const attenuated = 10 ** ((-3 * length) / 20_000) * Math.sqrt(6 / width);
    for (const [i, angle] of [0, -0.31, 0.3].entries()) {
      const ray = stage.axis[i];
      const unfold = launchDepth + length * Math.sin(angle);
      const folded = ((unfold % (2 * bottom)) + 2 * bottom) % (2 * bottom);
      const pressures = [
        attenuated,
        ray.reflections ? -attenuated * (ray.reflections === 2 ? 0.63 : 1) : attenuated,
        ray.reflections ? 0.63 * attenuated : attenuated,
      ];
      closeTo(ray.delay, time);
      closeTo(ray.length, length);
      closeTo(ray.range, length * Math.cos(angle), length);
      closeTo(ray.depth, Math.min(folded, 2 * bottom - folded), bottom);
      closeTo(ray.width, width);
      closeTo(ray.pressure, pressures[i]);
    }
    const nBounces = stage.bounces.reduce((sum, points) => sum + points.length, 0);
    assert.equal(stage.strokes.segments, 3 * stage.frame + nBounces);
    assert.equal(stage.strokes.drawCalls, 3);
    assert.ok(stage.labels.drawCalls > 0 && stage.sceneDraws > 0);
  }
  const firstSurface = launchDepth / Math.tan(0.31);
  const firstSeabed = (bottom - launchDepth) / Math.tan(0.3);
  closeTo(stop.bounces[1][0][0], firstSurface);
  closeTo(stop.bounces[1][1][0], firstSurface + bottom / Math.tan(0.31));
  closeTo(stop.bounces[2][0][0], firstSeabed);
  assert.deepEqual(
    stop.bounces.map((points) => points.map((point) => point[1])),
    [[], [0, 56], [56]],
  );
  assert.equal(ready.strokes.drawCalls, 0);
  for (const point of [...stop.bouncePixels, ...stop.tipPixels])
    assert.ok(changedNear(bare, final, point) >= 4, 'the accepted trace is visible near ' + point);
  const signal = changedPixels(bare, final);
  const rising = changedPixels(early, middle);
  assert.ok(signal > 700 && rising > 250);
  console.log(
    'SOUND-03',
    backend,
    stop.hash + ':',
    stop.strokes.segments,
    'ray segments,',
    signal,
    'changed pixels, 200 ms with three exact reflections and exact rewind/replay.',
  );
} finally {
  await close();
}
