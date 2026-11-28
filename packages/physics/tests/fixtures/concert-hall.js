import { EngineKernel, PbrMaterial, box } from '/packages/core/dist/index.js';
import { sphereGeometry } from '/packages/geometry/dist/index.js';
import { UnlitMaterial, createMesh } from '/packages/materials/dist/index.js';
import { FilmClock } from '/packages/math/dist/clock.js';
import { Lines, Line } from '/packages/lines/dist/index.js';
import { acousticBox, createRoomConvolver, roomArrivals } from '/packages/physics/dist/room-sound.js';
import { Font, Text, TextRenderer } from '/packages/text/dist/index.js';
import { waitForPipelines } from '/scripts/support/gpu-ready.js';

const plus = (point, direction, factor = 1) => point.map((v, i) => v + direction[i] * factor);
const minus = (a, b) => plus(a, b, -1);
const unit = (v) => {
  const length = Math.hypot(...v);
  return v.map((component) => component / length);
};
const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];

const source = [2.4, 1.55, 2.1];
const receiver = [9.8, 1.35, 4.7];
const room = acousticBox([0, 0, 0], [12, 6, 8]);
// The timber back baffle, side panels and floor are the displayed finite room boundaries.
const surfaces = [
  { ...room[0], reflection: [0.78, 0.65, 0.4] },
  { ...room[4], reflection: [0.84, 0.64, 0.48] },
  { ...room[2], reflection: [0.58, 0.55, 0.27] },
];
const options = { source, listener: receiver, surfaces, order: 2 };
const speed = 343;
const sampleRate = 48000;
const emissionSample = 512;

async function renderAudio(arrivals) {
  const audio = new OfflineAudioContext(1, 4096, sampleRate);
  const pulse = audio.createBufferSource();
  pulse.buffer = audio.createBuffer(1, 1, sampleRate);
  pulse.buffer.getChannelData(0)[0] = 1;
  pulse.connect(createRoomConvolver(audio, arrivals)).connect(audio.destination);
  pulse.start(emissionSample / sampleRate);
  return (await audio.startRendering()).getChannelData(0);
}

function legs(arrival) {
  const points = arrival.points;
  const lengths = points.slice(1).map((point, i) => Math.hypot(...minus(point, points[i])));
  const distances = [0];
  for (const length of lengths) distances.push(distances.at(-1) + length);
  return { ...arrival, lengths, distances };
}

function traceUntil(path, travel) {
  const positions = [...path.points[0]];
  let reached = 0;
  let tip = path.points[0];
  for (const [i, length] of path.lengths.entries()) {
    const fraction = Math.min(1, (travel - path.distances[i]) / length);
    if (fraction <= 0) break;
    const start = path.points[i];
    tip = plus(start, minus(path.points[i + 1], start), fraction);
    positions.push(...tip);
    if (fraction < 1) break;
    reached++;
  }
  return { positions, reached, tip };
}

export async function mountHall() {
  const width = 740;
  const height = 440;
  const errors = [];
  const camera = { position: [16, 12.1, 18.3], target: [5.8, 2.1, 3.65], fov: 35, near: 0.15, far: 58 };
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:740px;height:440px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [width, height], camera });
  engine.scene.background = '#16232e';
  engine.lighting.direction.set([0.44, 0.79, 0.43, 1.65]);
  engine.lighting.radiance.set([0.99, 0.92, 0.81, 0.83]);
  engine.lighting.ambient.set([0.58, 0.67, 0.81]);

  const material = (color, roughness = 0.8, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const timber = material('#855a43');
  const trim = material('#543b35');
  const panel = material('#775449');
  const floor = material('#545153');
  const seats = material('#755257');
  const supports = material('#49434b', 0.54, 0.23);
  const brass = material('#b88652', 0.43, 0.65);
  const steel = material('#80a3b6', 0.4, 0.56);
  const shell = material('#39434d');
  const block = (size, at, mat) =>
    engine
      .createMesh()
      .setGeometry(box(...size))
      .setPosition(at)
      .setMaterial(mat);
  block([12.25, 0.32, 8.22], [6.05, -0.16, 4.02], floor);
  block([0.22, 6, 8.22], [-0.11, 3, 4], panel);
  block([12.22, 6, 0.22], [5.89, 3, -0.11], panel);
  block([3.35, 0.245, 7.68], [1.675, 0.1225, 4], timber);
  block([3.28, 0.075, 7.6], [1.63, 0.2825, 4], timber);
  for (let column = 0; column < 20; column++) {
    const x = 0.3 + 0.6 * column;
    block([0.036, 4.7, 0.018], [x, 2.66, -0.004], column % 4 === 0 ? timber : trim);
  }
  for (let column = 0; column < 14; column++) {
    const z = 0.28 + 0.56 * column;
    block([0.018, 4.7, 0.045], [-0.004, 2.66, z], column % 4 === 0 ? timber : trim);
  }
  block([12.15, 0.105, 0.12], [5.92, 5.91, -0.07], trim);
  block([0.1, 0.105, 8.04], [-0.035, 5.91, 3.89], trim);
  block([12.1, 0.13, 0.1], [6, 0.13, -0.023], trim);
  // Two banks of fixed-scale seating with an unobstructed listener aisle.
  const seatShapes = [box(0.45, 0.12, 0.49), box(0.09, 0.52, 0.51), box(0.29, 0.37, 0.35)];
  for (const x of [5.26, 6.27, 7.28, 8.29, 9.3, 10.31]) {
    for (const z of [1.23, 2.08, 3.0, 5.83, 6.68, 7.53]) {
      engine.createMesh().setGeometry(seatShapes[0]).setPosition([x, 0.46, z]).setMaterial(seats);
      engine
        .createMesh()
        .setGeometry(seatShapes[1])
        .setPosition([x + 0.21, 0.68, z])
        .setMaterial(seats);
      engine.createMesh().setGeometry(seatShapes[2]).setPosition([x, 0.185, z]).setMaterial(supports);
    }
  }
  // The source and receiver are physical stands, with their heads placed at the solver coordinates.
  block([0.52, 0.065, 0.48], [source[0], 0.375, source[2]], shell);
  block([0.06, 1.1, 0.06], [source[0], 0.94, source[2]], brass);
  block([0.29, 0.24, 0.25], source, shell);
  block([0.41, 0.055, 0.41], [receiver[0], 0.0275, receiver[2]], shell);
  block([0.044, 1.23, 0.044], [receiver[0], 0.665, receiver[2]], steel);
  block([0.12, 0.16, 0.14], receiver, steel);

  const arrivals = roomArrivals(options);
  const direct = legs(arrivals.find((candidate) => candidate.reflections.length === 0));
  const echo = legs(arrivals.find((candidate) => candidate.reflections.join(',') === '0,1'));
  const pcm = await renderAudio(arrivals);

  const cyan = '#4be1ef';
  const gold = '#ffba65';
  const paths = Lines.attach(engine);
  const directLine = paths.add(
    new Line({ positions: [...source, ...source], color: cyan, width: 2.6, visible: false }),
  );
  const echoLine = paths.add(new Line({ positions: [...source, ...source], color: gold, width: 2.6, visible: false }));
  const bead = sphereGeometry(1, 14, 10);
  const directMaterial = new UnlitMaterial({ color: cyan });
  const echoMaterial = new UnlitMaterial({ color: gold });
  const makeBead = (mat, scale) => {
    const model = createMesh(engine, bead, mat);
    model.root.setScale([scale, scale, scale]);
    return model;
  };
  const directPulse = makeBead(directMaterial, 0.115);
  const echoPulse = makeBead(echoMaterial, 0.115);
  const hits = echo.points.slice(1, -1).map((point) => {
    const hit = makeBead(echoMaterial, 0.15);
    hit.root.setPosition(point);
    return hit;
  });
  const hands = [directPulse, echoPulse, ...hits];
  const show = (model, visible) => {
    model.root.visible = visible;
  };
  for (const hand of hands) show(hand, false);

  const right = unit(cross(minus(camera.target, camera.position), [0, 1, 0]));
  const up = unit(cross(right, minus(camera.target, camera.position)));
  const board = (x, y) => plus(plus(camera.target, right, x), up, y);
  const labels = TextRenderer.attach(engine);
  const heading = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const sans = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const tag = (text, x, y, font, fontSize, color) =>
    labels.add(new Text({ text, position: board(x, y), font, fontSize, color, billboard: true, onTop: true }));
  tag('Inside the concert hall', -10.2, 5.67, heading, 0.51, '#f2e8d8');
  tag('Two paths shown · time slowed 80×', -10.16, 4.99, sans, 0.26, '#c0cdd1');
  tag('Direct', -10.16, -4.98, sans, 0.31, cyan);
  tag('Two reflections', -8.8, -4.98, sans, 0.31, gold);
  const clock = tag('', 5.8, -4.98, sans, 0.31, '#e5ddd4');

  const gpu = engine.gpu;
  gpu.pushErrorScope('validation');
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  const draw = async () => {
    engine.render({ delta: 0 });
    await gpu.queue.onSubmittedWorkDone();
  };
  await waitForPipelines(draw);

  const project = ([x, y, z]) => {
    const m = engine.camera.matrix;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [
      width * (1 + (m[0] * x + m[4] * y + m[8] * z + m[12]) / w) * 0.5,
      height * (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5,
    ];
  };
  const film = new FilmClock({ fps: 60 });
  const cue = 18;
  const slowdown = 80;
  const end = 225;
  function displayPulse(line, head, path, elapsed, active) {
    const trace = traceUntil(path, elapsed * speed);
    line.visible = active && trace.positions.length > 3;
    if (line.visible) line.setPositions(trace.positions);
    head.root.setPosition(trace.tip);
    show(head, active && trace.reached < path.lengths.length);
    return { ...trace, arrived: trace.reached === path.lengths.length };
  }
  return {
    setup: {
      cue,
      end,
      slowdown,
      speed,
      sampleRate,
      emissionSample,
      source,
      receiver,
      direct,
      echo,
      crossing: echo.points.slice(1, -1).map(project),
      target: project(receiver),
      count: arrivals.length,
      pcm: Array.from(pcm),
    },
    async at(frame, restore) {
      if (restore) {
        const again = roomArrivals(options);
        if (JSON.stringify(again) !== JSON.stringify(arrivals))
          throw new Error('Seeking changed the accepted geometry.');
        const samples = await renderAudio(again);
        const expected = new Uint32Array(pcm.buffer, pcm.byteOffset, pcm.length);
        const actual = new Uint32Array(samples.buffer, samples.byteOffset, samples.length);
        if (actual.length !== expected.length || actual.some((value, i) => value !== expected[i]))
          throw new Error('Replaying the impulse changed its pressure samples.');
      }
      film.frame = frame;
      const elapsed = Math.max(0, Math.min(end, film.frame - cue)) / (60 * slowdown);
      const active = film.frame > cue;
      const first = displayPulse(directLine, directPulse, direct, elapsed, active);
      const reflected = displayPulse(echoLine, echoPulse, echo, elapsed, active);
      for (const [i, hit] of hits.entries()) show(hit, reflected.reached > i);
      clock.text = (elapsed * 1000).toFixed(2) + ' ms';
      await draw();
      await draw();
      return { elapsed, first, reflected, pressure: pcm[emissionSample + Math.floor(elapsed * sampleRate)] ?? 0 };
    },
    async dispose() {
      labels.dispose();
      paths.dispose();
      for (const model of hands) model.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}
