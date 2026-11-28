import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_ORBIT_FRAMES === '1' ? 'packages/physics/test-results/orbit-equilibrium' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function changeAt(before, after, i) {
  return (
    Math.abs(before.data[i] - after.data[i]) +
    Math.abs(before.data[i + 1] - after.data[i + 1]) +
    Math.abs(before.data[i + 2] - after.data[i + 2])
  );
}

function changedPixels(before, after) {
  assert.equal(before.data.length, after.data.length);
  let count = 0;
  for (let i = 0; i < before.data.length; i += 4) if (changeAt(before, after, i) >= 24) count++;
  return count;
}

function changedNear(before, after, [x, y]) {
  let count = 0;
  for (let j = Math.floor(y) - 4; j <= Math.ceil(y) + 4; j++) {
    for (let i = Math.floor(x) - 4; i <= Math.ceil(x) + 4; i++) {
      if (
        i >= 0 &&
        i < before.width &&
        j >= 0 &&
        j < before.height &&
        changeAt(before, after, (j * before.width + i) * 4) >= 24
      )
        count++;
    }
  }
  return count;
}

try {
  const setup = await page.evaluate(async () => {
    const [
      { EngineKernel, Geometry, PbrMaterial },
      { sphereGeometry },
      { OrbitSolver, ORBIT_FIELD_LAYOUT, ORBIT_GRAVITATIONAL_CONSTANT },
      { PhysicsWorld, regionWords },
      { FilmClock },
      { Line, Lines },
      { Text, TextRenderer, Font },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/geometry/dist/index.js'),
      import('/packages/physics/dist/orbit.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/math/dist/clock.js'),
      import('/packages/lines/dist/index.js'),
      import('/packages/text/dist/index.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);

    // Lagrange's equilateral solution. Translating to the mass centre
    // gives a_i = -G sum(m_j) r_i / separation^3 for every body.
    const separation = 9.6e9;
    const solarMass = 1.9884e30;
    const ratios = [0.96, 0.28, 0.12];
    const masses = ratios.map((ratio) => ratio * solarMass);
    const totalMass = masses.reduce((sum, mass) => sum + mass, 0);
    const vertices = [
      [-separation / 2, 0, 0],
      [separation / 2, 0, 0],
      [0, (Math.sqrt(3) * separation) / 2, 0],
    ];
    const centre = [0, 1, 2].map((axis) =>
      vertices.reduce((sum, vertex, i) => sum + (vertex[axis] * masses[i]) / totalMass, 0),
    );
    const omega = Math.sqrt((ORBIT_GRAVITATIONAL_CONSTANT * totalMass) / separation ** 3);
    const bodies = vertices.map((vertex, i) => {
      const position = vertex.map((component, axis) => component - centre[axis]);
      return { position, velocity: [-omega * position[1], omega * position[0], 0], mass: masses[i] };
    });
    const start = 12;
    const end = 72;
    const finalAngle = 2.55;
    const secondsPerFrame = finalAngle / (omega * end);
    const substeps = 8;
    const orbit = await OrbitSolver.load({ id: 'lagrange-equilibrium' });
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(orbit, {
      bodies,
      substeps,
      timeScale: 60 * secondsPerFrame,
      integrator: 'yoshida',
    });
    const film = new FilmClock({ fps: 60 });
    const initial = world.takeSnapshot();

    function read() {
      const readPort = (field, expected) => {
        const port = world.fields.port(field.name);
        if (!port || port.region.layout !== ORBIT_FIELD_LAYOUT || port.region.type !== 'f64')
          throw new Error('Read the accepted layout-1 OrbitSolver field.');
        const values = Array.from(regionWords(world.memory, port.region));
        if (values.length !== expected || !values.every(Number.isFinite))
          throw new Error('Invalid accepted orbit field.');
        return values;
      };
      const positions = readPort(orbit.positionField, 9);
      const velocities = readPort(orbit.velocityField, 9);
      const [elapsed] = readPort(orbit.timeField, 1);
      const accepted = bodies.map((_, i) => {
        const sample = orbit.sample(i);
        const position = positions.slice(3 * i, 3 * i + 3);
        const velocity = velocities.slice(3 * i, 3 * i + 3);
        if (
          !position.every((value, axis) => value === sample.position[axis]) ||
          !velocity.every((value, axis) => value === sample.velocity[axis]) ||
          elapsed !== orbit.elapsedSeconds
        )
          throw new Error('The scene needs matching orbit rows and physical time from the accepted tick.');
        return { position, velocity };
      });
      return { elapsed, accepted };
    }

    const beginning = read();
    let current = 0;
    let history = [beginning];
    function seek(frame) {
      if (current > frame) {
        world.restoreSnapshot(initial.bytes);
        current = 0;
        history = [beginning];
      }
      while (current < frame) {
        world.advance(++current);
        history.push(read());
      }
    }

    const width = 600;
    const height = 342;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:600px;height:342px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, height],
      antialias: true,
      camera: { position: [0, 9, 8.8], target: [0, 0, 0], fov: 29, near: 0.65, far: 80 },
    });
    engine.scene.background = '#142235';
    engine.lighting.direction.set([-0.44, 0.78, 0.45, 1.65]);
    engine.lighting.radiance.set([1, 0.94, 0.86, 0.45]);
    engine.lighting.ambient.set([0.63, 0.73, 0.86]);
    const colors = ['#f2d9aa', '#df9f73', '#a0cedf'];
    const radii = [0.24, 0.17, 0.145];
    const markers = colors.map((color, i) => {
      const s = sphereGeometry(radii[i], 24, 12);
      return engine
        .createMesh()
        .setGeometry(new Geometry(s.positions, s.normals, s.indices))
        .setMaterial(new PbrMaterial({ color, roughness: 0.76, doubleSided: false }));
    });
    const lines = Lines.attach(engine);
    const barycentre = lines.add(
      new Line({
        mode: 'segments',
        color: '#8498a7',
        width: 1.05,
        positions: [-0.105, 0, 0, 0.105, 0, 0, 0, 0, -0.105, 0, 0, 0.105],
      }),
    );
    const edges = lines.add(
      new Line({
        mode: 'loop',
        positions: [0, 0, 0, 1, 0, 0, 0, 0, 1],
        color: '#678299',
        width: 1.05,
        opacity: 0.62,
        dashed: true,
        dashSize: 0.073,
        gapSize: 0.044,
      }),
    );
    const trails = colors.map((color) =>
      lines.add(new Line({ positions: [0, 0, 0, 0, 0, 0], color, width: 1.85, opacity: 0.78, visible: false })),
    );
    const texts = TextRenderer.attach(engine);
    const font = new Font({ family: 'Arial, sans-serif', weight: 600 });
    const mono = new Font({ family: 'ui-monospace, monospace', weight: 400 });
    const label = (text, position, fontSize, color, typeface = font) =>
      texts.add(
        new Text({
          text,
          position,
          fontSize,
          font: typeface,
          color,
          anchorY: 'middle',
          billboard: true,
          onTop: true,
        }),
      );
    const board = (x, y) => [x, 0.699 * y, -0.715 * y];
    label('Three-body motion', board(-5.29, 2.77), 0.31, '#e3ebee');
    label('Lagrange equilateral solution', board(-5.26, 2.35), 0.168, '#9cacb9', mono);
    label('9.60 million km between bodies', board(-5.26, -2.53), 0.173, '#c0ced8', mono);
    label('Markers enlarged', board(-5.26, -2.86), 0.145, '#9cacb9');
    const time = label('', board(3.67, 2.75), 0.181, '#c0ced8', mono);
    const names = ['A', 'B', 'C'];
    const chips = names.map((name, i) => label(name, [0, 0, 0], 0.19, colors[i]));
    for (const [i, ratio] of ratios.entries()) {
      label(names[i] + '  ' + ratio.toFixed(2) + ' solar masses', board(2.79, -1.96 - 0.34 * i), 0.164, colors[i]);
    }

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

    const sceneUnits = 3e9;
    function renderPosition([x, y, z]) {
      return [x / sceneUnits, z / sceneUnits, -y / sceneUnits];
    }

    function pixel([x, y, z]) {
      const m = engine.camera.matrix;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [
        ((1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * width) / 2,
        ((1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * height) / 2,
      ];
    }

    let checkpoint;
    window.orbitShot = {
      async at(shotFrame, action) {
        film.frame = shotFrame;
        const frame = Math.max(0, Math.min(end, film.frame - start));
        if (action === 'restore') {
          world.restoreSnapshot(checkpoint.snapshot.bytes);
          current = checkpoint.frame;
          history = checkpoint.history.slice();
        }
        seek(frame);
        const state = history[frame];
        const snapshot = world.takeSnapshot();
        if (action === 'save') checkpoint = { snapshot, frame, history: history.slice() };
        time.text = (state.elapsed / 86400).toFixed(3) + ' d';
        const points = state.accepted.map(({ position }) => renderPosition(position));
        edges.setPositions(points.flat());
        for (const [i, point] of points.entries()) {
          markers[i].setPosition(point);
          chips[i].setPosition([point[0] + radii[i] + 0.04, point[1], point[2] - 0.065]);
          trails[i].visible = frame > 0;
          if (frame > 0) trails[i].setPositions(history.flatMap((entry) => renderPosition(entry.accepted[i].position)));
        }
        await draw();
        return {
          frame,
          hash: snapshot.hash,
          state,
          markerPixels: points.map(pixel),
          strokes: { ...lines.stats },
          labels: { ...texts.stats },
          meshDraws: engine.stats.drawCalls,
        };
      },
      async dispose() {
        barycentre.dispose();
        lines.dispose();
        texts.dispose();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, gpuErrors };
      },
    };
    return { separation, bodies, totalMass, omega, secondsPerFrame, substeps, start, end };
  });

  const render = (frame, action) => page.evaluate(([f, a]) => window.orbitShot.at(f, a), [frame, action]);
  const initial = await render(0);
  const initialPixels = await capture('ready');
  const heldBefore = await render(setup.start - 1);
  const heldBeforePixels = await capture('pre-trigger');
  const motion = await render(setup.start + 24);
  const motionPixels = await capture('motion');
  const middle = await render(setup.start + 42, 'save');
  const middlePixels = await capture('checkpoint');
  const final = await render(setup.start + setup.end);
  const finalPixels = await capture('final');
  const heldAfter = await render(setup.start + setup.end + 28);
  const heldAfterPixels = await capture('post-hold');
  const rewind = await render(setup.start + 42, 'restore');
  const rewindPixels = await capture('rewind');
  const replay = await render(setup.start + setup.end);
  const replayPixels = await capture('replay');
  const clear = await render(0);
  const clearPixels = await capture('clear');
  assert.deepEqual(await page.evaluate(() => window.orbitShot.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);

  assert.deepEqual(initial, heldBefore);
  assert.deepEqual(initial, clear);
  assert.deepEqual(initialPixels.data, heldBeforePixels.data);
  assert.deepEqual(initialPixels.data, clearPixels.data);
  assert.deepEqual(final, heldAfter);
  assert.deepEqual(final, replay);
  assert.deepEqual(finalPixels.data, heldAfterPixels.data);
  assert.deepEqual(finalPixels.data, replayPixels.data);
  assert.deepEqual(middle, rewind);
  assert.deepEqual(middlePixels.data, rewindPixels.data);

  const { separation, bodies, totalMass, omega, secondsPerFrame, substeps } = setup;
  const stepAngle = (omega * secondsPerFrame) / substeps;
  let maximumResidual = 0;
  for (const shot of [motion, middle, final]) {
    const seconds = shot.frame * secondsPerFrame;
    const angle = seconds * omega;
    const { elapsed, accepted } = shot.state;
    assert.ok(Math.abs(elapsed - seconds) <= 4 * shot.frame * Number.EPSILON * seconds);
    // The accumulated fourth-order position scale is d * angle * stepAngle^4.
    // Eight allows the coupled position and velocity stages. Add IEEE-754 drift roundoff.
    const bound = separation * (8 * angle * stepAngle ** 4 + 128 * substeps * shot.frame * Number.EPSILON);
    const barycentre = [0, 0, 0];
    for (const [i, { position, velocity }] of accepted.entries()) {
      const [x, y, z] = bodies[i].position;
      const rotated = [x * Math.cos(angle) - y * Math.sin(angle), x * Math.sin(angle) + y * Math.cos(angle), z];
      const residual = Math.hypot(...position.map((value, axis) => value - rotated[axis]));
      assert.ok(residual <= bound, residual + ' m exceeds ' + bound + ' m');
      maximumResidual = Math.max(maximumResidual, residual);
      const expectedVelocity = [-omega * rotated[1], omega * rotated[0], 0];
      assert.ok(Math.hypot(...velocity.map((value, axis) => value - expectedVelocity[axis])) <= omega * bound);
      const next = accepted[(i + 1) % bodies.length].position;
      assert.ok(Math.abs(Math.hypot(...position.map((value, axis) => value - next[axis])) - separation) <= 2 * bound);
      for (let axis = 0; axis < 3; axis++) barycentre[axis] += (position[axis] * bodies[i].mass) / totalMass;
    }
    assert.ok(Math.hypot(...barycentre) <= 128 * substeps * shot.frame * Number.EPSILON * separation);
    assert.equal(shot.strokes.segments, 5 + 3 * shot.frame);
    assert.ok(shot.meshDraws >= bodies.length && shot.labels.drawCalls > 0);
  }
  const firstChange = changedPixels(initialPixels, motionPixels);
  const totalChange = changedPixels(initialPixels, finalPixels);
  assert.ok(firstChange > 550 && totalChange > firstChange);
  for (const pixel of [...initial.markerPixels, ...final.markerPixels])
    assert.ok(
      changedNear(initialPixels, finalPixels, pixel) > 15,
      'The accepted body movement is visible near ' + pixel,
    );
  console.log(
    'SPACE-01',
    backend,
    final.hash + ':',
    (final.state.elapsed / 86400).toFixed(3),
    'days,',
    final.strokes.segments,
    'segments,',
    totalChange,
    'changed pixels,',
    maximumResidual.toFixed(2),
    'm maximum analytic position residual and exact holds and replay.',
  );
} finally {
  await close();
}
