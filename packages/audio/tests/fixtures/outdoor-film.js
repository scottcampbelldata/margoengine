import { AudioListener, PositionalAudio } from '/packages/audio/dist/index.js';
import { OutdoorAudio } from '/packages/audio/dist/outdoor.js';
import { EngineKernel, PbrMaterial, box } from '/packages/core/dist/index.js';
import { computeVertexNormals, latheGeometry, sphereGeometry, toGeometry } from '/packages/geometry/dist/index.js';
import { geometryData } from '/packages/geometry/dist/utils.js';
import { Line, Lines } from '/packages/lines/dist/index.js';
import { UnlitMaterial, createMesh } from '/packages/materials/dist/index.js';
import { TerrainBed } from '/packages/physics/dist/earth.js';
import { OutdoorSound } from '/packages/physics/dist/outdoor-sound.js';
import { PhysicsWorld, regionWords } from '/packages/physics/dist/world.js';
import { Font, Text, TextRenderer } from '/packages/text/dist/index.js';
import { waitForPipelines } from '/scripts/support/gpu-ready.js';

const source = [-25, 2.7, 0];
const receivers = [
  [15, 2.7, -30],
  [25, 2.7, 0],
];
const crest = [0, 13, 0];
const colours = ['#6af3f5', '#ffbc67'];
const sampleRate = 48000;
const strikeSample = 768;
const playbackRate = 600;
const cue = 12;
const duration = 106;
const width = 768;
const height = 456;
const plus = (a, b, factor = 1) => a.map((x, axis) => x + b[axis] * factor);
const minus = (a, b) => plus(a, b, -1);
const unit = (v) => v.map((x) => x / Math.hypot(...v));
const cross = ([ax, ay, az], [bx, by, bz]) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];

function hill(x, z) {
  const shoulder = Math.max(0, 1 - Math.abs(x) / 14);
  const spine = Math.max(0, 1 - (z / 14) ** 2);
  const backSlope = Math.max(0, (z - 6) / 60) * (3 + Math.cos(x / 8));
  return crest[1] * shoulder * spine * spine + backSlope;
}

function terrainFixture(world) {
  const terrain = new TerrainBed();
  const grid = { columns: 40, rows: 28, width: 80, depth: 56, centre: [0, -8] };
  const elevations = [];
  for (let c = 0; c <= grid.columns; c++)
    for (let r = 0; r <= grid.rows; r++) elevations.push(hill(-40 + 2 * c, -36 + 2 * r));
  world.add(terrain, { ...grid, elevations });
  return terrain;
}

function drawTerrain(engine, terrain) {
  const { columns, rows, width, depth, centre } = terrain.grid;
  const stride = rows + 1;
  const elevations = terrain.elevations();
  const positions = [];
  const uvs = [];
  const faces = [];
  for (let c = 0; c <= columns; c++)
    for (let r = 0; r <= rows; r++) {
      const u = c / columns;
      const v = r / rows;
      positions.push(centre[0] + (u - 0.5) * width, elevations[c * stride + r], centre[1] + (v - 0.5) * depth);
      uvs.push(u, v);
    }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const a = c * stride + r;
      faces.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
    }
  const vertices = new Float32Array(positions);
  const texture = new Float32Array(uvs);
  const data = geometryData(vertices, new Float32Array(vertices.length), texture, new Uint32Array(faces));
  engine
    .createMesh()
    .setGeometry(toGeometry(computeVertexNormals(data)))
    .setMaterial(new PbrMaterial({ color: '#677961', roughness: 0.96 }));
}

function soundSource(engine) {
  const wood = new PbrMaterial({ color: '#583d2c', roughness: 0.79 });
  const stone = new PbrMaterial({ color: '#888275', roughness: 0.89 });
  const weatheredBronze = new PbrMaterial({ color: '#927451', metallic: 1, roughness: 0.49 });
  function beam(shape, at, surface) {
    return engine
      .createMesh()
      .setGeometry(box(...shape))
      .setPosition(at)
      .setMaterial(surface);
  }
  const [x, , z] = source;
  beam([2.8, 0.32, 2.38], [x, 0.16, z], stone);
  for (const side of [-1, 1]) beam([0.29, 3.62, 0.29], [x + side * 1.05, 2, z], wood);
  beam([2.61, 0.26, 0.51], [x, 3.73, z], wood);
  for (const side of [-1, 1])
    beam([1.38, 0.17, 1.29], [x + side * 0.63, 4 + 0.1, z], wood)
      .setRotation([0, 0, -side * 0.27])
      .setMaterial(wood);
  beam([0.15, 0.56, 0.15], [x, 3.47, z], weatheredBronze);
  const bell = latheGeometry(
    [
      [0.16, 0.55],
      [0.34, 0.44],
      [0.39, 0.18],
      [0.48, -0.04],
      [0.64, -0.18],
      [0.62, -0.25],
      [0.53, -0.24],
      [0.4, -0.01],
      [0.34, 0.16],
      [0.28, 0.39],
      [0.15, 0.51],
    ],
    28,
  );
  engine.createMesh().setGeometry(toGeometry(bell)).setPosition(source).setMaterial(weatheredBronze);
  for (const [rx, ry, rz] of receivers) {
    beam([1.1, 0.17, 0.91], [rx, 0.09, rz], stone);
    beam([0.14, 2.61, 0.14], [rx, 1.38, rz], wood);
    beam([0.49, 0.38, 0.41], [rx, ry, rz], weatheredBronze);
  }
}

function makeStrike(context) {
  const signal = context.createBuffer(1, 14400, sampleRate);
  const samples = signal.getChannelData(0);
  const modes = [
    [330, 0.34, 7],
    [671, 0.22, 10],
    [1375, 0.13, 14],
    [2740, 0.1, 19],
    [5960, 0.13, 24],
  ];
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    samples[i] = modes.reduce(
      (pressure, [frequency, level, decay]) =>
        pressure + level * Math.exp(-decay * t) * Math.cos(2 * Math.PI * frequency * t),
      0,
    );
  }
  return signal;
}

async function listen(solver, index) {
  const context = new OfflineAudioContext(2, 24000, sampleRate);
  const listener = new AudioListener({ context, smoothing: 0, autoResume: false });
  const position = receivers[index];
  listener.setPose(position, unit(minus(source, position)));
  const sound = new PositionalAudio(listener, { panningModel: 'equalpower', rolloffFactor: 1 });
  sound.setPosition(...source);
  const controller = new OutdoorAudio(sound, () => solver.read(index), { maxDelay: 0.5 });
  if (sound.rolloffFactor !== 0 || sound.getFilters().length !== 4)
    throw new Error('The path must control all four production outdoor filters.');
  sound.setBuffer(makeStrike(context)).play(strikeSample / sampleRate);
  try {
    const result = await context.startRendering();
    return [result.getChannelData(0), result.getChannelData(1)];
  } finally {
    controller.dispose();
    if (sound.rolloffFactor !== 1 || sound.getFilters().length !== 0)
      throw new Error('Outdoor audio disposal must restore the source.');
    listener.dispose();
  }
}

function measure(pcm) {
  const [left, right] = pcm;
  const first = left.findIndex((v, i) => Math.abs(v) + Math.abs(right[i]) > 1e-8);
  function mode(frequency) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < 4096; i++) {
      const w = (1 - Math.cos((2 * Math.PI * i) / 4096)) * (left[first + i] + right[first + i]);
      const angle = (2 * Math.PI * frequency * i) / sampleRate;
      re += w * Math.cos(angle);
      im += w * Math.sin(angle);
    }
    return Math.hypot(re, im);
  }
  return {
    first,
    trebleToBassDb: 20 * Math.log10(mode(5960) / mode(330)),
    finite: pcm.every((side) => side.every(Number.isFinite)),
  };
}

function sameSamples(a, b) {
  return a.every((side, i) => {
    const words = new Uint32Array(side.buffer, side.byteOffset, side.length);
    const replay = new Uint32Array(b[i].buffer, b[i].byteOffset, b[i].length);
    return words.length === replay.length && words.every((x, n) => x === replay[n]);
  });
}

function pathPoints(path, index) {
  if (!path.blocked) return [source, receivers[index]];
  // The symmetric crest point can be reconstructed from the accepted diffracted length.
  // Only this fixed isothermal cutaway makes that inference, and it is checked against TerrainBed.
  return [source, [0, source[1] + Math.sqrt((path.distance / 2) ** 2 - 25 ** 2), 0], receivers[index]];
}

function pulseAt(points, fraction) {
  if (fraction >= 1) return { positions: points.flat(), point: points.at(-1) };
  const lengths = points.slice(1).map((point, i) => Math.hypot(...minus(point, points[i])));
  let remaining = fraction * lengths.reduce((sum, length) => sum + length, 0);
  const vertices = [points[0]];
  for (let leg = 0; leg < lengths.length; leg++) {
    vertices.push(plus(points[leg], minus(points[leg + 1], points[leg]), Math.min(1, remaining / lengths[leg])));
    remaining -= lengths[leg];
    if (remaining <= 0) break;
  }
  return { positions: vertices.flat(), point: vertices.at(-1) };
}

export async function setupOutdoorFilm() {
  const world = new PhysicsWorld({ rate: { num: playbackRate, den: 1 } });
  const terrain = terrainFixture(world);
  const solver = await OutdoorSound.load();
  world.add(solver, {
    bed: terrain.bed,
    groundReflection: 0,
    intervals: 64,
    links: receivers.map((listener) => ({ source, listener })),
  });
  const initialFrame = playbackRate / 60;
  world.advance(initialFrame);
  const initialTime = world.time;
  const initial = world.takeSnapshot();
  const camera = { position: [-6, 35, 62], target: [0, 3.2, -9], fov: 36, near: 0.1, far: 180 };
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:768px;height:456px';
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, { backend: 'webgpu', exactSize: [width, height], camera });
  engine.scene.background = '#36494e';
  engine.lighting.direction.set([-0.46, 0.73, 0.47, 2.45]);
  engine.lighting.radiance.set([1, 0.91, 0.78, 0.94]);
  engine.lighting.ambient.set([0.4, 0.52, 0.62]);
  drawTerrain(engine, terrain);
  soundSource(engine);

  const lines = Lines.attach(engine);
  const sphere = sphereGeometry(1, 16, 12);
  const traces = colours.map((color) => {
    const line = lines.add(new Line({ positions: [...source, ...source], width: 2.5, color, visible: false }));
    const head = createMesh(engine, sphere, new UnlitMaterial({ color })).root;
    head.setScale([0.48, 0.48, 0.48]);
    head.visible = false;
    return { line, head };
  });
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const text = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const forward = unit(minus(camera.target, camera.position));
  const right = unit(cross(forward, [0, 1, 0]));
  const up = unit(cross(right, forward));
  const board = (x, y) => plus(plus(camera.target, right, x), up, y);
  function tag(value, x, y, font, size, color) {
    return labels.add(
      new Text({ text: value, position: board(x, y), font, fontSize: size, color, billboard: true, onTop: true }),
    );
  }
  tag('The ridge between us', -37, 21, title, 1.76, '#f2e9d9');
  tag('One bell, two listeners 50 m away · time slowed 10×', -37, 18.5, text, 1.04, '#c7d5d3');
  tag('Open ground', -37, -20, title, 1.16, colours[0]);
  tag('Behind the ridge', -24, -20, title, 1.16, colours[1]);
  const clock = tag('', 17, -20, text, 1.05, '#e9decd');

  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
  gpu.pushErrorScope('validation');
  const draw = async () => {
    engine.render({ delta: 0 });
    await gpu.queue.onSubmittedWorkDone();
  };

  let tick = 0;
  let checkpoint;
  let samples;
  const recorded = new Map();
  async function at(frame, action) {
    const next = Math.max(0, Math.min(duration, frame - cue));
    if (action === 'restore') {
      world.restoreSnapshot(checkpoint.bytes);
      tick = checkpoint.tick;
    } else if (next < tick) {
      world.restoreSnapshot(initial.bytes);
      tick = 0;
    }
    if (next > tick) {
      tick = next;
      world.advance(initialFrame + tick);
    }
    const snapshot = world.takeSnapshot();
    const original = recorded.get(next);
    if (original && (original.length !== snapshot.bytes.length || original.some((x, i) => x !== snapshot.bytes[i])))
      throw new Error('Seek changed the accepted acoustic world bytes.');
    recorded.set(next, snapshot.bytes);
    if (action === 'save') checkpoint = { bytes: snapshot.bytes, tick };
    const region = world.fields.port(solver.field.name)?.region;
    if (region?.type !== 'f64') throw new Error('The time trace needs the accepted outdoor path field.');
    const words = regionWords(world.memory, region);
    const paths = receivers.map((_, i) => solver.read(i));
    if (words[0] !== paths[0].delaySeconds || words[1] !== paths[0].distance)
      throw new Error('The accepted field must drive the visible and audible path.');
    const time = world.time - initialTime;
    const cues = traces.map(({ line, head }, i) => {
      const path = paths[i];
      const points = pathPoints(path, i);
      const arrived = time >= path.delaySeconds;
      if (path.blocked && Math.abs(points[1][1] - terrain.bed.sample(points[1][0], points[1][2]).elevation) > 1e-9)
        throw new Error('Displayed crest ' + points[1][1] + ' does not match the accepted 13 m terrain.');
      const pulse = pulseAt(points, time / path.delaySeconds);
      line.visible = time > 0;
      if (line.visible) line.setPositions(pulse.positions);
      head.visible = time > 0;
      head.setPosition(pulse.point);
      return {
        blocked: path.blocked,
        distance: path.distance,
        delay: path.delaySeconds,
        arrived,
        point: pulse.point,
        diffraction: [path.diffractionDb[0], path.diffractionDb[7]],
      };
    });
    clock.text = (time * 1000).toFixed(1) + ' ms after strike';
    await draw();
    const captureAudio = action === 'save' || action === 'restore' || action === 'audio';
    if (captureAudio) {
      const pcm = await Promise.all(receivers.map((_, i) => listen(solver, i)));
      if (samples && pcm.some((path, i) => !sameSamples(path, samples[i])))
        throw new Error('Snapshot restore or cue replay changed the stereo pressure samples.');
      samples ??= pcm;
    }
    return {
      hash: snapshot.hash,
      time,
      cues,
      ...(captureAudio && { audio: samples.map(measure) }),
    };
  }
  await at(0);
  await waitForPipelines(draw);
  return {
    cue,
    duration,
    sampleRate,
    strikeSample,
    source,
    receivers,
    crest,
    at,
    async dispose() {
      solver.dispose();
      lines.dispose();
      labels.dispose();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      return { validation, errors };
    },
  };
}
