import { createStage } from '/packages/stage/dist/index.js';
import { toGeometry } from '/packages/geometry/dist/utils.js';
import { Quaternion } from '/packages/math/dist/quaternion.js';
import { FilmClock } from '/packages/math/dist/clock.js';
import { Font, Text, TextRenderer } from '/packages/text/dist/index.js';
import { SurfaceEnergySolver } from '/packages/weather/dist/surface-energy.js';
import { RAIL_CAR_LAYOUT, RAIL_CAR_WORDS, RailRoute, RailSolver } from '/packages/physics/dist/rail.js';
import { PhysicsWorld, regionWords, worldMemory } from '/packages/physics/dist/world.js';
import { waitForPipelines } from '/scripts/support/gpu-ready.js';

const sum = (p, u, scale = 1) => p.map((v, i) => v + scale * u[i]);
const dot = (p, u) => p.reduce((s, v, i) => s + v * u[i], 0);
const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
const scaleVector = (v, k) => v.map((axis) => k * axis);
const rotateAroundUp = (v, up, angle) => sum(scaleVector(v, Math.cos(angle)), cross(up, v), Math.sin(angle));
const subtract = (p, u) => sum(p, u, -1);
const basis = (forward, up) => {
  const side = cross(forward, up);
  const quaternion = new Quaternion()
    .setFromRotationMatrix({ elements: [...forward, 0, ...up, 0, ...side, 0, 0, 0, 0, 1] })
    .toArray();
  return { quaternion, side };
};

export function stockMaterial(stock, part) {
  const material = stock.palette[part];
  const color =
    '#' +
    material.color
      .map((v) =>
        Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  return { color, roughness: material.roughness, metalness: material.metalness };
}

// A second Last Tram fixture take. FRA, Cant Excess for Freight Train Operations on Shared Track (2020),
// gives the geometric dependence on radius and speed. Both takes use the same horizontal route, with no cant.
export async function curveTake(canvas, stock) {
  const errors = [];
  const width = 720;
  const height = 405;
  const stage = await createStage(canvas, {
    controls: false,
    autoStart: false,
    background: '#a4bac7',
    exactSize: [width, height],
    camera: { position: [12.8, 4.05, -4.6], target: [0, 1.45, 0], fov: 38, near: 0.1, far: 90 },
    onError: (error) => errors.push(String(error.message ?? error)),
  });
  const { engine } = stage;
  engine.lighting.direction.set([0.62, 0.69, -0.36, 1.32]);
  engine.lighting.radiance.set([1.0, 0.94, 0.83, 0.85]);
  engine.lighting.ambient.set([0.6, 0.68, 0.79]);
  const gpu = engine.gpu;
  gpu.pushErrorScope('validation');
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const film = new FilmClock({ fps: 60 });
  const world = new PhysicsWorld({ rate: film.fps, memory: worldMemory(true) });
  const trackRadius = 100;
  const station = 55;
  const track = new RailRoute(
    Array.from({ length: 121 }, (_, i) => {
      const angle = (i - station) / trackRadius;
      return { centre: [trackRadius * Math.sin(angle), 0, trackRadius * (1 - Math.cos(angle))] };
    }),
  );
  const weather = new SurfaceEnergySolver();
  world.add(weather, { initialWater: 1, waterCapacity: 1 });
  const rail = await RailSolver.load(world.memory, { wetnessField: weather.wetnessField });
  const wheelRadius = stock.wheels[0].diameter * 0.5;
  const bogieCentres = [0, 1].map((i) => (stock.wheels[2 * i].x + stock.wheels[2 * i + 1].x) * 0.5);
  const speed = 8;
  world.add(rail, {
    cars: [1, -1].map((direction) => ({
      track,
      distance: station - 2 * speed * direction,
      speed: speed * direction,
      centreHeight: stock.deck,
      gauge: stock.gauge,
      wheelRadius,
      bogieWheelbase: stock.wheels[1].x - stock.wheels[0].x,
      bogieSpacing: bogieCentres[1] - bogieCentres[0],
    })),
  });

  stage.box({ size: [160, 0.28, 100], position: [6, -0.49, 3.5], color: '#53636b', roughness: 0.88 });
  const crest = track.sample(station);
  const outside = [0, 0, -1];
  const defineStrip = (start, end, side, y, breadth, thickness, material) => {
    const a = track.sample(start);
    const b = track.sample(end);
    const p = sum(a.centre, a.right, side);
    const q = sum(b.centre, b.right, side);
    const forward = subtract(q, p);
    const length = Math.hypot(...forward);
    const mid = sum(p, forward, 0.5);
    mid[1] += y;
    const frame = basis(scaleVector(forward, 1 / length), [0, 1, 0]);
    stage
      .box({ size: [length + 0.008, thickness, breadth], position: mid, ...material })
      .setQuaternion(frame.quaternion);
  };
  for (let s = 24; s < 89; s += 1.5) {
    defineStrip(s, s + 1.5, 0, -0.26, 3.7, 0.2, { color: '#676965', roughness: 0.9 });
    for (const side of [-stock.gauge / 2, stock.gauge / 2])
      defineStrip(s, s + 1.5, side, -0.038, 0.078, 0.076, { color: '#8899a4', roughness: 0.24, metalness: 0.72 });
  }
  for (let s = 23; s <= 88; s += 0.61) {
    const frame = track.sample(s);
    stage
      .box({
        size: [0.185, 0.14, 2.63],
        position: sum(frame.centre, frame.up, -0.142),
        color: '#57483f',
        roughness: 0.8,
      })
      .setQuaternion(basis(frame.tangent, frame.up).quaternion);
  }
  for (const s of [-4, 0, 4]) {
    const point = track.sample(station + s);
    const pole = sum(point.centre, point.right, stock.gauge / 2 + 2.05);
    stage.box({
      size: [0.079, 0.97, 0.15],
      position: [pole[0], 0.14, pole[2]],
      color: '#82786f',
      roughness: 0.8,
    });
    stage.box({
      size: [0.09, 0.17, 0.16],
      position: [pole[0], 0.59, pole[2]],
      color: '#d7b273',
      roughness: 0.64,
    });
  }

  const body = Object.entries(stock.parts)
    .filter(([name]) => name !== 'trucks')
    .map(([name, data]) => stage.mesh(toGeometry(data), stockMaterial(stock, name)));
  const running = stock.parts.trucks;
  const front = [];
  const rear = [];
  for (let i = 0; i < running.indices.length; i += 3) {
    const index = running.indices[i];
    const list = running.positions[3 * index] < 0 ? rear : front;
    list.push(index, running.indices[i + 1], running.indices[i + 2]);
  }
  const trucks = [rear, front].map((indices) =>
    stage.mesh(toGeometry({ ...running, indices: Uint32Array.from(indices) }), stockMaterial(stock, 'trucks')),
  );
  const chalk = stock.wheels.map(() => stage.box({ size: [0.062, 0.13, 0.026], color: '#e1bc70' }));
  const marker = stage.box({ size: [0.052, 0.19, 0.25], color: '#19d9a7', roughness: 0.67 });
  const markerLocal = [5.56, 3.46, 0];
  const glyphs = TextRenderer.attach(engine);
  const headings = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const labels = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const title = new Text({
    text: 'The same outside rail',
    font: headings,
    fontSize: 0.38,
    color: '#24333b',
    position: [1.0, 5.02, -5.3],
    billboard: true,
    anchorX: 'right',
    onTop: true,
  });
  glyphs.add(title);
  const telemetry = new Text({
    text: '',
    font: labels,
    fontSize: 0.205,
    color: '#384b51',
    position: [1.0, 4.59, -5.3],
    billboard: true,
    anchorX: 'right',
    onTop: true,
  });
  glyphs.add(telemetry);
  const draw = async () => {
    engine.render({ delta: 0 });
    await gpu.queue.onSubmittedWorkDone();
  };
  const original = world.takeSnapshot();
  const snapshots = new Map();
  let current = 0;
  let recorded;
  const cue = 12;
  const match = 120;
  const end = 168;

  function pixel([x, y, z]) {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      (width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w)) / 2,
      (height * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w)) / 2,
    ];
  }
  function apply(car) {
    const sampled = track.sample(car.distance);
    const orientation = basis(car.forward, car.up);
    const base = sum(car.position, car.up, -stock.deck);
    for (const mesh of body) mesh.setPosition(base).setQuaternion(orientation.quaternion);
    const crestMark = sum(sum(base, car.forward, markerLocal[0]), car.up, markerLocal[1]);
    marker.setPosition(crestMark).setQuaternion(orientation.quaternion);
    for (const [i, offset] of bogieCentres.entries()) {
      const p = track.sample(car.distance + offset);
      const tangent = rotateAroundUp(p.tangent, p.up, -car.bogieYaw[i]);
      const pose = basis(tangent, p.up);
      const axle = sum(sum(p.centre, p.right, car.bogieSway[i]), p.up, car.bogieHeave[i]);
      trucks[i].setPosition(sum(axle, tangent, -offset)).setQuaternion(pose.quaternion);
    }
    const rim = stock.backToBack * 0.5 + 0.142;
    const witnesses = stock.wheels.map(({ x }, i) => {
      const bogie = Math.floor(i / 2);
      const wheel = car.wheelsets[i];
      const axle = track.sample(car.distance + x);
      const tangent = rotateAroundUp(axle.tangent, axle.up, -car.bogieYaw[bogie]);
      const frame = basis(tangent, axle.up);
      const centre = sum(
        sum(axle.centre, axle.right, rim + car.bogieSway[bogie] + (x - bogieCentres[bogie]) * car.bogieYaw[bogie]),
        axle.up,
        wheelRadius + wheel.heave,
      );
      const radial = sum(scaleVector(tangent, Math.sin(wheel.angle)), axle.up, Math.cos(wheel.angle));
      const target = sum(centre, radial, 0.72 * wheelRadius);
      chalk[i].setPosition(target).setQuaternion(basis(cross(radial, frame.side), radial).quaternion);
      return target;
    });
    const neutral = sum(sum(sampled.centre, sampled.tangent, markerLocal[0]), sampled.up, car.heave + markerLocal[1]);
    return {
      marker: pixel(crestMark),
      neutral: pixel(neutral),
      witnesses: witnesses.map(pixel),
      outward: dot(outside, subtract(crestMark, neutral)),
      railSide: dot(outside, sampled.right),
      trackCentre: sampled.centre,
      curvature: sampled.curvature,
    };
  }
  function state(index) {
    const port = world.fields.port(rail.carField.name);
    if (!port || port.region.type !== 'f64' || port.region.layout !== RAIL_CAR_LAYOUT)
      throw new Error('The cutaway requires accepted f64 rail car records.');
    const row = Array.from(
      regionWords(world.memory, port.region).subarray(index * RAIL_CAR_WORDS, (index + 1) * RAIL_CAR_WORDS),
    );
    const car = rail.read(index);
    if (row.length !== RAIL_CAR_WORDS || row[0] !== car.distance || row[1] !== car.speed)
      throw new Error('The displayed car must correspond to its accepted world record.');
    return { car, row };
  }
  apply(rail.read(0));
  await waitForPipelines(draw);
  const shot = async ({ frame, index = 0, action }) => {
    film.frame = frame;
    const goal = Math.max(0, Math.min(end, film.frame - cue));
    if (action === 'restore') {
      world.restoreSnapshot(recorded.snapshot.bytes);
      current = recorded.current;
    } else if (goal < current) {
      world.restoreSnapshot(original.bytes);
    }
    world.advance(goal);
    current = goal;
    const snapshot = world.takeSnapshot();
    const prior = snapshots.get(goal);
    if (!prior) snapshots.set(goal, snapshot.bytes);
    else if (prior.length !== snapshot.bytes.length || prior.some((v, i) => v !== snapshot.bytes[i]))
      throw new Error('Held and replayed rail snapshots must match byte for byte.');
    if (action === 'save') recorded = { snapshot, current };
    const other = state(1 - index);
    const shown = state(index);
    telemetry.text = (index === 0 ? 'Forward' : 'Reverse') + ' · wet track · R 100 m';
    const pose = apply(shown.car);
    await draw();
    await draw();
    return {
      ...shown,
      other,
      ...pose,
      hash: snapshot.hash,
      wetness: weather.read().wetness,
      errors: errors.splice(0),
    };
  };
  return {
    shot,
    setup: { cue, end, match, station, trackRadius, wheelRadius, speed, outside: crest.right },
    async dispose() {
      glyphs.dispose();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      stage.dispose();
      return { validation, errors };
    },
  };
}
