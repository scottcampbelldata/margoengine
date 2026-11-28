import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, hardware, close } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_BOUNDARY_LAYER_FRAMES === '1' ? 'packages/physics/test-results/boundary-layer' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (name) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + name + '.png' } : {}),
  );

function changed(before, after, pixels = [0, 0, before.width, before.height]) {
  assert.equal(before.data.length, after.data.length);
  const [left, top, right, bottom] = pixels;
  let count = 0;
  for (let y = Math.max(0, top); y < Math.min(bottom, before.height); y++) {
    for (let x = Math.max(0, left); x < Math.min(right, before.width); x++) {
      const i = 4 * (y * before.width + x);
      const rgb =
        Math.abs(before.data[i] - after.data[i]) +
        Math.abs(before.data[i + 1] - after.data[i + 1]) +
        Math.abs(before.data[i + 2] - after.data[i + 2]);
      if (rgb >= 24) count++;
    }
  }
  return count;
}

function nearPixels(before, after, pixel) {
  const [x, y] = pixel.map(Math.round);
  return changed(before, after, [x - 5, y - 5, x + 6, y + 6]);
}

try {
  const setup = await page.evaluate(async () => {
    const [
      { EngineKernel, PbrMaterial, box },
      { BoundaryLayerSolver },
      { PhysicsWorld, regionWords },
      { FilmClock },
      { BoundaryLayerWind },
      { PrecipitationField },
      { Line, Lines },
      { Font, Text, TextRenderer },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/physics/dist/boundary-layer.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/math/dist/clock.js'),
      import('/packages/weather/dist/boundary-layer.js'),
      import('/packages/weather/dist/precipitation.js'),
      import('/packages/lines/dist/index.js'),
      import('/packages/text/dist/index.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);

    const profile = { speed: 12, referenceHeight: 10, roughness: 0.0002, turbulence: false, direction: 0 };
    const grid = { cells: [3, 5, 3], origin: [-20, 0, -10], spacing: [80, 20, 10] };
    const wind = await BoundaryLayerSolver.load();
    const weatherWind = new BoundaryLayerWind(profile);
    const framesPerSecond = 60;
    const film = new FilmClock({ fps: framesPerSecond });
    const world = new PhysicsWorld({ rate: film.fps }).add(wind, { profile: weatherWind.profile, grid });
    const start = 12;
    const end = 72;
    const timeScale = 6;
    const base = 80;
    const cloudX = 9;
    const cellSpeed = 5;
    const radius = 11;
    const rate = 38;
    const rain = new PrecipitationField({
      base,
      wind,
      cells: [{ centre: [cloudX, 0], velocity: [cellSpeed, 0], radius, rate }],
    });
    const rainSample = rain.sample(cloudX, base, 0, 0);
    const initial = world.takeSnapshot();

    function readField(physicalFrame) {
      const port = world.fields.port(wind.sampleField.name);
      if (!port || port.tick + 1 !== physicalFrame || port.region.type !== 'f64' || port.region.layout !== 1)
        throw new Error('The rain transect needs the accepted boundary-layer field at the current world tick.');
      const data = regionWords(world.memory, port.region);
      const [nx, ny, nz] = grid.cells;
      if (data.length !== 5 * nx * ny * nz) throw new Error('The native sample field must cover the authored grid.');
      const speeds = [];
      for (let j = 0; j < ny; j++) {
        const x = grid.origin[0] + grid.spacing[0];
        const y = grid.origin[1] + j * grid.spacing[1];
        const z = grid.origin[2] + grid.spacing[2];
        const row = 5 * ((ny + j) * nx + 1);
        const accepted = Array.from(data.slice(row, row + 5));
        const { velocity, density, temperature } = wind.sample(x, y, z, wind.elapsedSeconds);
        const scalar = weatherWind.sample(x, y, z, wind.elapsedSeconds);
        const sample = [...velocity, density, temperature];
        if (sample.some((value, i) => !Number.isFinite(value) || value !== accepted[i]))
          throw new Error('A live rain query must read the same wind as the registered atmospheric grid.');
        if (scalar.velocity.some((value, i) => Math.abs(value - velocity[i]) > 1e-11))
          throw new Error('The scalar Weather wind and accepted native wind disagree at a registered height.');
        speeds.push(velocity[0]);
      }
      return speeds;
    }

    const width = 646;
    const height = 370;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:646px;height:370px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, height],
      antialias: true,
      camera: { position: [76, 48, 189], target: [73, 44, 0], fov: 36, near: 5, far: 385 },
    });
    engine.scene.background = '#182d3d';
    engine.lighting.direction.set([-0.38, 0.82, 0.44, 1.55]);
    engine.lighting.radiance.set([0.98, 0.95, 0.89, 0.45]);
    engine.lighting.ambient.set([0.55, 0.66, 0.76]);
    const solid = (size, position, color, roughness) =>
      engine
        .createMesh()
        .setGeometry(box(...size))
        .setPosition(position)
        .setMaterial(new PbrMaterial({ color, roughness }));
    solid([196, 7, 32], [68, -3.5, -10], '#284f61', 0.81);
    solid([196, 0.55, 0.6], [68, 0.3, 6], '#84a9af', 0.62);

    const lines = Lines.attach(engine);
    const gridLines = [20, 40, 60, 80].flatMap((y) => [-16, y, -2, 163, y, -2]);
    lines.add(new Line({ mode: 'segments', positions: gridLines, color: '#8097aa', width: 1, opacity: 0.3 }));
    const ticks = [0, 40, 80, 120, 160].flatMap((x) => [x, -0.1, 6.4, x, -1.6, 6.4]);
    lines.add(new Line({ mode: 'segments', positions: ticks, color: '#8cabb0', width: 1.1 }));
    const shaft = lines.add(new Line({ mode: 'segments', positions: [0, 1, 0, 1, 1, 0], color: '#b5dce5', width: 2 }));
    const originMark = lines.add(
      new Line({ mode: 'segments', positions: [0, base, 0, 1, base, 0], color: '#e5b783', width: 2.4 }),
    );
    const texts = TextRenderer.attach(engine);
    const sans = new Font({ family: 'Arial, sans-serif', weight: 600 });
    const mono = new Font({ family: 'ui-monospace, monospace', weight: 400 });
    const label = (text, x, y, fontSize, color, font = mono) =>
      texts.add(new Text({ text, position: [x, y, 1], fontSize, font, color, anchorY: 'middle', onTop: true }));
    label('Wind bends a rain shaft', -28, 98, 6.0, '#e4ebee', sans);
    label('OFFSHORE  /  LONGITUDINAL SECTION', -28, 91, 2.7, '#a4b8c4');
    for (const y of [20, 40, 60, 80]) label(y + ' m', -31, y, 2.7, '#a4b8c4');
    for (const x of [0, 40, 80, 120, 160]) label(x + ' m', x - 3, -5.5, 2.6, '#aebec7');
    label('SEA LEVEL', -28, -5.5, 2.6, '#aebec7');
    label('Cloud-base peak', 124, 91, 2.7, '#e5b783', sans);

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

    const spacing = 3;
    const firstX = -21;
    const columns = 66;
    const levels = [5, 20, 35, 50, 65, 80];
    const rows = Array.from({ length: 26 }, (_, row) => 5 + row * 3);

    function transect(time) {
      const points = [];
      const colors = [];
      const peaks = [];
      const clear = [];
      for (const [j, y] of rows.entries()) {
        const values = [];
        for (let i = 0; i < columns; i++) {
          const x = firstX + i * spacing;
          const { rate: localRate, velocity } = rain.sample(x, y, 0, time, rainSample);
          values.push(localRate);
          if (localRate < 0.11 * rate) continue;
          const duration = 0.27;
          points.push(x, y, 0, x + duration * velocity[0], y + duration * velocity[1], duration * velocity[2]);
          const intensity = 0.11 + (0.89 * localRate) / rate;
          colors.push(1, 1, 1, intensity, 1, 1, 1, intensity);
        }
        if (j % 5 !== 0) continue;
        const peak = Math.max(...values);
        const i = values.indexOf(peak);
        if (i === 0 || i === columns - 1) throw new Error('Keep the whole simulated peak in the fixed transect.');
        // On either side of a centred exponential, ln(rate) has known slope of magnitude 1/radius.
        const offset = (radius / 2) * Math.log(values[i + 1] / values[i - 1]);
        peaks.push(firstX + i * spacing + offset);
        clear.push(Math.max(values[0], values[columns - 1]));
      }
      return { points, colors, peaks, clear };
    }

    function pixel(x, y) {
      const m = engine.camera.matrix;
      const w = m[3] * x + m[7] * y + m[15];
      return [
        ((1 + (m[0] * x + m[4] * y + m[12]) / w) * width) / 2,
        ((1 - (m[1] * x + m[5] * y + m[13]) / w) * height) / 2,
      ];
    }

    let checkpoint;
    window.boundaryLayerShot = {
      async at(frame, action) {
        film.frame = frame;
        const physicalFrame = timeScale * Math.max(0, Math.min(end - start, film.frame - start));
        if (action === 'restore') world.restoreSnapshot(checkpoint.bytes);
        else if (physicalFrame / framesPerSecond < world.time) world.restoreSnapshot(initial.bytes);
        world.advance(physicalFrame);
        const time = wind.elapsedSeconds;
        const accepted = readField(physicalFrame);
        const { points, colors, peaks, clear } = transect(time);
        const snapshot = world.takeSnapshot();
        if (action === 'save') checkpoint = snapshot;
        shaft.setPositions(points, colors);
        originMark.setPositions([peaks.at(-1) - 4, base, 0, peaks.at(-1) + 4, base, 0]);
        await draw();
        return {
          time,
          hash: snapshot.hash,
          accepted,
          peaks,
          clear,
          pixels: peaks.map((x, i) => pixel(x, levels[i] - 0.8)),
          lines: { ...lines.stats },
          meshDraws: engine.stats.drawCalls,
        };
      },
      async detach() {
        shaft.dispose();
        originMark.dispose();
        await draw();
      },
      async dispose() {
        lines.dispose();
        texts.dispose();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, gpuErrors };
      },
    };
    return { start, end, base, cloudX, cellSpeed, rate, levels, profile, grid };
  });

  const render = (frame, action) => page.evaluate(([f, a]) => window.boundaryLayerShot.at(f, a), [frame, action]);
  const initial = await render(0);
  const initialPixels = await capture('initial');
  const pre = await render(setup.start - 1);
  assert.deepEqual(pre, initial);
  assert.deepEqual((await capture('pre-trigger')).data, initialPixels.data);
  const middle = await render((setup.start + setup.end) / 2, 'save');
  const middlePixels = await capture('checkpoint');
  const end = await render(setup.end);
  const endPixels = await capture('in-wind');
  assert.deepEqual(await render(setup.end + 24), end);
  assert.deepEqual((await capture('hold')).data, endPixels.data);
  assert.deepEqual(await render((setup.start + setup.end) / 2, 'restore'), middle);
  assert.deepEqual((await capture('restore')).data, middlePixels.data);
  assert.deepEqual(await render(setup.end), end);
  assert.deepEqual((await capture('replay')).data, endPixels.data);
  await page.evaluate(() => window.boundaryLayerShot.detach());
  const direct = await capture('detached');
  assert.deepEqual(await page.evaluate(() => window.boundaryLayerShot.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);

  // Homogeneous neutral log law (Businger et al., 1971, doi:10.1175/1520-0469(1971)028<0181:FPRITA>2.0.CO;2).
  const { speed, referenceHeight, roughness } = setup.profile;
  const speedAt = (y) =>
    y > roughness ? (speed * Math.log(y / roughness)) / Math.log(referenceHeight / roughness) : 0;
  const reference = end.accepted.map((_, j) => speedAt(j * setup.grid.spacing[1]));
  assert(reference.every((v, i) => Math.abs(v - end.accepted[i]) < 1e-11));
  assert.equal(end.time, 6);
  assert.notEqual(initial.hash, end.hash);
  assert.equal(initial.peaks.length, setup.levels.length);

  // A moving exponential source gives x_peak = x_cloud(t) + (U_mid - U_cloud) * fall/c.
  // The authored rate's Marshall-Palmer mass-median diameter lies between 1.8 and 2.2 mm.
  // Gunn and Kinzer (1949) measured 6.09 and 6.90 m/s there, as reprinted by Christensen and Frost (1979), table 3-1.
  // Allow 0.7% laboratory uncertainty and 1% for the square-root density correction from 20 C to the sea-level profile.
  // https://ntrs.nasa.gov/api/citations/19790017494/downloads/19790017494.pdf
  const medianMm = (3.67 * Math.pow(setup.rate, 0.21)) / 4.1;
  assert(medianMm > 1.8 && medianMm < 2.2);
  const terminalRange = [6.09 * (1 - 0.017), 6.9 * (1 + 0.017)];
  const sourceX = setup.cloudX + setup.cellSpeed * end.time;
  const inferred = [];
  for (const [i, y] of setup.levels.entries()) {
    assert(Math.abs(end.peaks[i] - initial.peaks[i] - setup.cellSpeed * end.time) < 1e-8);
    assert(end.clear[i] < 0.1 * setup.rate);
    if (y === setup.base) {
      assert(Math.abs(end.peaks[i] - sourceX) < 1e-8);
    } else {
      assert(end.peaks[i] > end.peaks[i + 1]);
      const midWind = speedAt((setup.base + y) / 2);
      const terminal = ((midWind - setup.cellSpeed) * (setup.base - y)) / (end.peaks[i] - sourceX);
      assert(terminal > terminalRange[0] && terminal < terminalRange[1], `At ${y} m inferred terminal ${terminal} m/s`);
      inferred.push(terminal);
    }
  }
  const motionPixels = changed(initialPixels, endPixels);
  const rainPixels = changed(direct, endPixels);
  assert(end.meshDraws >= 2 && end.lines.drawCalls >= 3 && end.lines.segments > 200);
  assert(motionPixels > 1600, `World-space rain moved through only ${motionPixels} pixels`);
  assert(rainPixels > 1600, `Detaching the rain changed only ${rainPixels} pixels`);
  for (const pixel of end.pixels) {
    assert(nearPixels(direct, endPixels, pixel) >= 4, `Rain failed to draw near its physical peak at ${pixel}`);
  }
  console.log(
    `  ${backend} rain shaft: ${(end.peaks[0] - sourceX).toFixed(2)} m surfaceward offset, drift ${(sourceX - setup.cloudX).toFixed(2)} m, inferred fall speed ${Math.min(...inferred).toFixed(2)}–${Math.max(...inferred).toFixed(2)} m/s, ${motionPixels} moving pixels, ${rainPixels} rain pixels, replay ${end.hash}`,
  );
} finally {
  await close();
}
