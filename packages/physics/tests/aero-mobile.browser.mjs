import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';

const { page, close, hardware } = await openBrowser({ startPath: '/tools/shot/blank.html', port: 'free' });
const backend = hardware.compat ? 'WebGL2' : 'WebGPU';
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const output =
  process.env.MARGO_KEEP_AERO_MOBILE_FRAMES === '1' ? 'packages/physics/test-results/aero-mobile' : undefined;
if (output) await mkdir(output, { recursive: true });
const capture = async (id) =>
  decodePNG(
    await page.locator('canvas').screenshot(output ? { path: output + '/' + backend + '-' + id + '.png' } : {}),
  );

function paperMask(image, [cx, cy], warm) {
  let count = 0;
  let center = 0;
  const span = 70;
  const pixels = [];
  for (let y = Math.max(0, Math.round(cy) - span); y <= Math.min(image.height - 1, Math.round(cy) + span); y++) {
    for (let x = Math.max(0, Math.round(cx) - span); x <= Math.min(image.width - 1, Math.round(cx) + span); x++) {
      const i = 4 * (y * image.width + x);
      const [r, g, b] = image.data.subarray(i, i + 3);
      if (warm ? r > 1.35 * g && g > 1.16 * b : g > 1.25 * r && b > 1.24 * r) {
        count++;
        center += x;
        pixels.push(i, r, g, b);
      }
    }
  }
  assert(count > 200, `The suspended paper needs a legible silhouette, found ${count} pixels`);
  return { centroid: center / count, pixels };
}

try {
  const setup = await page.evaluate(async () => {
    const [
      { EngineKernel },
      { planeGeometry, cylinderGeometry },
      { LambertMaterial, UnlitMaterial, createMesh },
      { Physics, WindForce },
      { AirSolver },
      { BODY_WORDS, BODIES_FIELD, BODY_FORCES_FIELD, FORCE_WORDS, PhysicsWorld, RigidSolver, regionWords },
      { BoundaryLayerSolver },
      { BoundaryLayerWind },
      { travellingGust },
      { rotateByQuaternion },
      { FilmClock },
      { Lines, Line },
      { Font, Text, TextRenderer },
      { waitForPipelines },
    ] = await Promise.all([
      import('/packages/core/dist/index.js'),
      import('/packages/geometry/dist/index.js'),
      import('/packages/materials/dist/index.js'),
      import('/packages/physics/dist/index.js'),
      import('/packages/physics/dist/flight.js'),
      import('/packages/physics/dist/world.js'),
      import('/packages/physics/dist/boundary-layer.js'),
      import('/packages/weather/dist/boundary-layer.js'),
      import('/packages/weather/dist/turbulence.js'),
      import('/packages/math/dist/quat.js'),
      import('/packages/math/dist/clock.js'),
      import('/packages/lines/dist/index.js'),
      import('/packages/text/dist/index.js'),
      import('/scripts/support/gpu-ready.js'),
    ]);
    const add = (a, b) => a.map((value, i) => value + b[i]);
    const sub = (a, b) => a.map((value, i) => value - b[i]);
    const scale = (a, s) => a.map((value) => value * s);
    const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const unit = (v) => scale(v, 1 / Math.hypot(...v));

    // An original folded silhouette, in metres. Museum reference for the wing/neck proportions:
    // Smithsonian Anacostia Community Museum, Colorful Origami Crane, 2011.0004.0081.
    const folds = [
      [0, 0.022, 0.037],
      [0, 0.017, -0.037],
      [-0.048, 0.002, 0.045],
      [-0.123, 0.036, -0.024],
      [-0.045, -0.003, -0.048],
      [-0.054, 0.04, -0.004],
      [0.047, 0.001, 0.046],
      [0.12, 0.028, -0.022],
      [0.044, -0.004, -0.046],
      [0.054, 0.034, -0.003],
      [-0.008, 0.027, 0.061],
      [0, 0.041, 0.063],
      [0.008, 0.027, 0.061],
      [-0.006, 0.095, 0.092],
      [0, 0.103, 0.095],
      [0.006, 0.095, 0.092],
      [0, 0.084, 0.138],
      [-0.011, 0.015, -0.088],
      [0, 0.029, -0.091],
      [0.011, 0.014, -0.087],
      [0, 0.035, -0.132],
    ];
    const faces = [
      [0, 1, 5],
      [1, 4, 5],
      [4, 3, 5],
      [3, 2, 5],
      [2, 0, 5],
      [1, 0, 9],
      [0, 6, 9],
      [6, 7, 9],
      [7, 8, 9],
      [8, 1, 9],
      [0, 2, 10],
      [0, 10, 11],
      [6, 0, 11],
      [6, 11, 12],
      [11, 10, 13],
      [11, 13, 14],
      [12, 11, 14],
      [12, 14, 15],
      [14, 13, 16],
      [15, 14, 16],
      [4, 1, 17],
      [17, 1, 18],
      [1, 8, 18],
      [18, 8, 19],
      [17, 18, 20],
      [18, 19, 20],
    ];
    const vertexNormals = folds.map(() => [0, 0, 0]);
    const rim = new Map();
    let paperArea = 0;
    for (const [a, b, c] of faces) {
      const normal = cross(sub(folds[b], folds[a]), sub(folds[c], folds[a]));
      paperArea += Math.hypot(...normal) / 2;
      for (const i of [a, b, c]) vertexNormals[i] = add(vertexNormals[i], normal);
      for (const [i, j] of [
        [a, b],
        [b, c],
        [c, a],
      ]) {
        if (!rim.delete(j + ':' + i)) rim.set(i + ':' + j, [i, j]);
      }
    }
    const halfThickness = 0.000065;
    const layer = (side) => folds.map((p, i) => add(p, scale(unit(vertexNormals[i]), side * halfThickness)));
    const n = folds.length;
    const shell = [...layer(1), ...layer(-1)];
    const outside = [...faces, ...faces.map(([a, b, c]) => [a + n, c + n, b + n])];
    for (const [i, j] of rim.values()) outside.push([j, i, j + n], [i, i + n, j + n]);
    const flat = outside.flatMap((face) => face.map((i) => shell[i]));
    const normals = outside.flatMap(([a, b, c]) => {
      const normal = unit(cross(sub(shell[b], shell[a]), sub(shell[c], shell[a])));
      return [normal, normal, normal];
    });
    const paper = {
      positions: Float32Array.from(flat.flat()),
      normals: Float32Array.from(normals.flat()),
      indices: Uint32Array.from(flat.map((_, i) => i)),
    };
    const paperMass = 0.08 * paperArea;
    const paperCollider = {
      shape: 'trimesh',
      vertices: shell.flat(),
      indices: outside.flat(),
      oriented: true,
      mass: paperMass,
    };

    await Physics.load();
    const physics = new Physics(null, { fixedTimestep: 1 / 60 });
    const air = new AirSolver();
    const atmosphere = await BoundaryLayerSolver.load({ id: 'gallery-air' });
    const film = new FilmClock({ fps: 60 });
    const hooks = [
      [-0.24, 0.63, 0],
      [0.24, 0.63, -0.02],
    ];
    const threads = [0.36, 0.4];
    const rigid = new RigidSolver();
    const mobiles = hooks.map((hook, i) => {
      const wall = physics.addBody(null, { type: 'fixed', position: hook, colliders: [] });
      const yaw = i === 0 ? 0.44 : 0.68;
      const rotation = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
      const body = physics.addBody(null, {
        rotation,
        colliders: paperCollider,
        angularDamping: 0.22,
        linearDamping: 0.15,
      });
      const [mx, , mz] = body.centerOfMass;
      const tie = [mx, 0.031, mz];
      body.setPosition(sub(add(hook, [0, -threads[i], 0]), rotateByQuaternion(tie, rotation)));
      const joint = physics.addJoint(wall, body, { type: 'rope', length: threads[i], anchorB: tie });
      return { body, joint, hook, tie };
    });
    const preRoll = 90;
    const front = {
      origin: [-0.5, 0, 0],
      start: preRoll / 60 + 0.3,
      speed: 0.85,
      length: 0.38,
      amplitude: [3.0, 0.72, -0.55],
    };
    const world = new PhysicsWorld({ rate: film.fps }).add(atmosphere, {
      profile: new BoundaryLayerWind({ speed: 0, turbulence: false, roughness: 0.03 }).profile,
      grid: { cells: [2, 2, 2], origin: [-0.5, 0, -0.2], spacing: [1, 0.6, 0.4] },
    });
    const flow = travellingGust(atmosphere, front);
    const wind = new WindForce(physics, { velocity: flow });
    world.add(rigid, { physics }).add(air, { physics }).couple(['air', 'rigid'], 'staggered');

    const width = 720;
    const height = 440;
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:720px;height:440px';
    document.body.replaceChildren(canvas);
    const engine = await EngineKernel.create(canvas, {
      backend: 'webgpu',
      exactSize: [width, height],
      camera: { position: [0.045, 0.46, 1.46], target: [0, 0.387, 0], fov: 27, near: 0.08, far: 12 },
    });
    engine.scene.background = '#343f46';
    engine.lighting.direction.set([-0.36, 0.48, 0.73, 2.1]);
    engine.lighting.radiance.set([1, 0.9, 0.78, 0.92]);
    engine.lighting.ambient.set([0.51, 0.58, 0.66]);
    const walnut = new UnlitMaterial({ color: '#a1876b' });
    const brass = new UnlitMaterial({ color: '#c5aa78' });
    const wall = new UnlitMaterial({ color: '#4d5860' });
    const mullion = new UnlitMaterial({ color: '#404b52' });
    createMesh(engine, planeGeometry(1.85, 1.1), wall).root.setPosition([0, 0.35, -0.64]);
    for (const x of [-0.59, 0.59])
      createMesh(engine, planeGeometry(0.014, 1.1), mullion).root.setPosition([x, 0.35, -0.638]);
    const rail = createMesh(engine, cylinderGeometry(0.007, 0.007, 0.68, 20), walnut);
    rail.root.setPosition([0, 0.649, -0.01]).setQuaternion([0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    for (const [x, y, z] of hooks)
      createMesh(engine, cylinderGeometry(0.0075, 0.0075, 0.025, 16), brass).root.setPosition([x, y + 0.011, z]);
    for (const x of [-0.333, 0.333])
      createMesh(engine, cylinderGeometry(0.0018, 0.0018, 0.2, 10), brass).root.setPosition([x, 0.75, -0.01]);
    const paperMaterials = [new LambertMaterial({ color: '#ca7142' }), new LambertMaterial({ color: '#76aab2' })];
    const models = paperMaterials.map((material) => createMesh(engine, paper, material));
    const lines = Lines.attach(engine);
    const ties = mobiles.map(({ hook }) =>
      lines.add(new Line({ positions: [...hook, ...hook], width: 1.45, color: '#cab790', opacity: 0.94 })),
    );
    const glyphs = TextRenderer.attach(engine);
    const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
    const bodyFont = new Font({ family: 'Arial, sans-serif', weight: 400 });
    function text(content, position, font, fontSize, color) {
      return glyphs.add(new Text({ text: content, position, font, fontSize, color, billboard: true, onTop: true }));
    }
    text('Paper in moving air', [-0.53, 0.137, 0.02], title, 0.035, '#e8dfcd');
    text('Wind load on a suspended paper mobile', [-0.53, 0.103, 0.02], bodyFont, 0.017, '#c1cbd0');
    const clock = text('', [0.365, 0.108, 0.02], bodyFont, 0.018, '#d9cac2');

    const gpu = engine.gpu;
    const gpuErrors = [];
    engine.onError = (error) => gpuErrors.push(String(error));
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    gpu.pushErrorScope('validation');
    const project = ([x, y, z]) => {
      const m = engine.camera.matrix;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      return [
        (width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w)) / 2,
        (height * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w)) / 2,
      ];
    };
    const draw = async () => {
      engine.render({ delta: 0 });
      await gpu.queue.onSubmittedWorkDone();
    };
    // Let the paper settle under its own weight before the shot. Wind begins on the same absolute world clock.
    world.advance(preRoll);
    const initial = world.takeSnapshot();
    const snapshots = new Map();
    let acceptedFrame = preRoll;
    const cue = 12;
    const duration = 152;
    let peak = [
      { force: 0, torque: 0 },
      { force: 0, torque: 0 },
    ];
    let saved;
    function stepReceipts() {
      const port = air.exportPorts(acceptedFrame).find((entry) => entry.field === BODY_FORCES_FIELD.name);
      if (!port || port.region.type !== 'f64') throw new Error('The AirSolver must publish its bodyForces.');
      const loads = regionWords(world.memory, port.region);
      for (const [i, { body }] of mobiles.entries()) {
        const offset = FORCE_WORDS * body.row;
        const force = Math.hypot(...loads.subarray(offset, offset + 3));
        const torque = Math.hypot(...loads.subarray(offset + 3, offset + 6));
        peak[i].force = Math.max(peak[i].force, force);
        peak[i].torque = Math.max(peak[i].torque, torque);
      }
    }
    async function shot(frame, action) {
      film.frame = frame;
      const next = preRoll + Math.max(0, Math.min(duration, film.frame - cue));
      if (action === 'restore') {
        world.restoreSnapshot(saved.snapshot.bytes);
        acceptedFrame = saved.frame;
        peak = saved.peak.map((value) => ({ ...value }));
      } else if (next < acceptedFrame) {
        world.restoreSnapshot(initial.bytes);
        acceptedFrame = preRoll;
        peak = peak.map(() => ({ force: 0, torque: 0 }));
      }
      while (acceptedFrame < next) {
        world.advance(++acceptedFrame);
        stepReceipts();
      }
      const snapshot = world.takeSnapshot();
      const before = snapshots.get(next);
      if (!before) snapshots.set(next, snapshot.bytes);
      else if (snapshot.bytes.length !== before.length || snapshot.bytes.some((value, i) => value !== before[i]))
        throw new Error('The replayed rigid and atmosphere snapshot must match byte for byte.');
      if (action === 'save') saved = { snapshot, frame: next, peak: peak.map((value) => ({ ...value })) };
      const port = world.fields.port(BODIES_FIELD.name);
      if (!port || port.region.type !== 'f32' || port.region.layout !== 2)
        throw new Error('The mobile must use the accepted bodies port.');
      const rows = regionWords(world.memory, port.region);
      clock.text = ((acceptedFrame - preRoll) / 60).toFixed(2) + ' s';
      const poses = mobiles.map(({ body, joint, hook, tie }, i) => {
        const row = body.row * BODY_WORDS;
        const position = Array.from(rows.subarray(row, row + 3));
        const rotation = Array.from(rows.subarray(row + 3, row + 7));
        const endpoint = add(position, rotateByQuaternion(tie, rotation));
        if (body.position.some((value, k) => value !== position[k]))
          throw new Error('The rendered pose must match the latest accepted rigid-body pose.');
        models[i].root.setPosition(position).setQuaternion(rotation);
        ties[i].setPositions([...hook, ...endpoint]);
        return {
          position,
          rotation,
          thread: Math.hypot(...sub(endpoint, hook)),
          load: [...joint.force],
          screen: project(position),
          mass: body.mass,
          air: flow.sample(...position, world.time).velocity,
        };
      });
      await draw();
      return { hash: snapshot.hash, time: world.time, poses, peak: peak.map((value) => ({ ...value })) };
    }
    await shot(0);
    await waitForPipelines(draw);
    window.mobile = {
      at: shot,
      async dispose() {
        wind.remove();
        physics.dispose();
        atmosphere[Symbol.dispose]();
        lines.dispose();
        glyphs.dispose();
        const validation = (await gpu.popErrorScope())?.message ?? null;
        engine.dispose();
        return { validation, gpuErrors };
      },
    };
    return { cue, duration, threads, paperMass };
  });

  const render = (frame, action) => page.evaluate(([f, a]) => window.mobile.at(f, a), [frame, action]);
  const rest = await render(0);
  const restImage = await capture('rest');
  assert.deepEqual(await render(setup.cue - 1), rest);
  assert.deepEqual((await capture('held-rest')).data, restImage.data);
  const nearFrame = setup.cue + 59;
  const farFrame = setup.cue + 94;
  const endFrame = setup.cue + setup.duration;
  const near = await render(nearFrame, 'save');
  const nearImage = await capture('first-bird');
  const far = await render(farFrame);
  const farImage = await capture('second-bird');
  const end = await render(endFrame);
  const endImage = await capture('end');
  assert.deepEqual(await render(endFrame + 15), end);
  assert.deepEqual((await capture('held-end')).data, endImage.data);
  assert.deepEqual(await render(nearFrame, 'restore'), near);
  assert.deepEqual((await capture('restored')).data, nearImage.data);
  assert.deepEqual(await render(farFrame), far);
  assert.deepEqual((await capture('replay')).data, farImage.data);
  assert.deepEqual(await render(endFrame), end);
  assert.deepEqual((await capture('replay-end')).data, endImage.data);
  assert.deepEqual(await page.evaluate(() => window.mobile.dispose()), { validation: null, gpuErrors: [] });
  assert.deepEqual(errors, []);

  for (const shot of [rest, near, far, end]) {
    for (const [i, pose] of shot.poses.entries()) {
      assert(Math.abs(pose.mass - setup.paperMass) < 1e-8);
      assert(Math.abs(pose.thread - setup.threads[i]) < 0.008, JSON.stringify({ i, pose, setup }));
    }
  }
  assert(near.peak[0].force > 0.0005 && near.peak[0].torque > 1e-6);
  assert(near.peak[1].force < 1e-5, JSON.stringify(near));
  assert(far.peak[1].force > 0.0005 && far.peak[1].torque > 1e-6);
  const turns = [near.poses[0], far.poses[1]].map(
    ({ rotation }, i) =>
      2 *
      Math.acos(Math.min(1, Math.abs(rotation.reduce((sum, value, k) => sum + value * rest.poses[i].rotation[k], 0)))),
  );
  const images = [nearImage, farImage];
  const moving = [near.poses[0], far.poses[1]];
  const motion = moving.map((pose, i) => pose.position[0] - rest.poses[i].position[0]);
  const firstMasks = rest.poses.map(({ screen }, i) => paperMask(restImage, screen, i === 0));
  const shifts = images.map(
    (image, i) => paperMask(image, moving[i].screen, i === 0).centroid - firstMasks[i].centroid,
  );
  assert.deepEqual(near.poses[1].air, [0, 0, 0]);
  const waiting = near.poses[1].position;
  const waitingDrift = Math.hypot(...waiting.map((value, axis) => value - rest.poses[1].position[axis]));
  const waitingPixels = paperMask(nearImage, rest.poses[1].screen, false).centroid - firstMasks[1].centroid;
  assert(waitingDrift < 1e-5 && Math.abs(waitingPixels) < 0.25, JSON.stringify({ waitingDrift, waitingPixels }));
  // In still air the settled thread carries the paper's actual weight.
  for (const pose of rest.poses) assert(Math.abs(pose.load[1] / (pose.mass * 9.81) - 1) < 0.02, JSON.stringify(pose));
  assert(
    motion.every((value) => value > 0.012),
    JSON.stringify({ motion, turns, shifts, near, far }),
  );
  assert(
    turns.every((value) => value > 0.055),
    JSON.stringify({ motion, turns, shifts, near, far }),
  );
  for (const [i, pose] of moving.entries()) {
    const projectedTravel = pose.screen[0] - rest.poses[i].screen[0];
    assert(shifts[i] > 7 && Math.abs(shifts[i] - projectedTravel) < 38, JSON.stringify({ shifts, projectedTravel }));
  }
  console.log(
    `  ${backend} paper mobile: ${(setup.paperMass * 1000).toFixed(2)} g paper, translation ${motion.map((value) => (100 * value).toFixed(2)).join('/')} cm, turns ${turns.map((value) => ((180 * value) / Math.PI).toFixed(1)).join('/')}°, pixels ${shifts.map((value) => value.toFixed(1)).join('/')}, waiting drift ${(waitingDrift * 1e6).toFixed(2)} µm, replay ${far.hash}`,
  );
} finally {
  await close();
}
