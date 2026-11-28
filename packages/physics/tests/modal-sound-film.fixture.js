import { EngineKernel, PbrMaterial, box } from '@margoengine/core';
import { sphereGeometry, toGeometry } from '@margoengine/geometry';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { geometryData } from '@margoengine/geometry/utils';
import { PbrMaterial as SurfaceMaterial, createMesh } from '@margoengine/materials';
import { Physics } from '@margoengine/physics';
import { ModalContactRigidSolver, ModalSoundSolver } from '@margoengine/physics/modal-sound';
import { PhysicsWorld, regionWords, worldMemory } from '@margoengine/physics/world';
import { Font, Text, TextRenderer } from '@margoengine/text';
import { Tonemap } from '@margoengine/tonemap';
import { waitForPipelines } from '../../../scripts/support/gpu-ready.js';

const width = 768;
const height = 432;
const rate = 60;
const sampleRate = 48000;
const cue = 18;
const checkpoint = 10;
const end = 36;
const seed = 72931;
const gravity = [0, -9.81, 0];
const cell = [-8, 2, 5];
const lanes = [-0.204, 0.204];
const bar = [0.29, 0.007, 0.083];
const barTop = 0.083;
const radius = 0.021;
const drop = 0.24;
const mass = 0.3;
const bridgeTop = 0.126;
const bridgeHeight = 0.012;
const bridgeSize = [0.045, bridgeHeight, 0.121];
const gravityDrop = Math.sqrt((2 * drop) / -gravity[1]);
const steelYoungModulus = 200e9;
const steelDensity = 7850;
// Khasawneh and Segalman (2019), free–free Euler–Bernoulli beam roots:
// https://doi.org/10.1016/j.apacoust.2019.03.015
const firstRoot = 4.730040744862704;
const mode = {
  frequency:
    (firstRoot ** 2 * Math.sqrt((steelYoungModulus * bar[1] ** 2) / (12 * steelDensity))) / (2 * Math.PI * bar[0] ** 2),
  decay: 14,
  gain: 0.62,
};

async function makeTake(caught, x) {
  const sound = await ModalSoundSolver.load();
  const world = new PhysicsWorld({
    rate: { num: rate, den: 1 },
    seed,
    cellSize: 64,
    gravity,
    memory: worldMemory(false),
  });
  const physics = new Physics(null, { gravity, fixedTimestep: 1 / rate, arena: world.arena });
  const fixed = (position, size) =>
    physics.addBody(null, {
      type: 'fixed',
      position,
      colliders: { shape: 'box', halfExtents: size.map((v) => v / 2) },
    });
  const radiator = fixed([x, barTop - bar[1] / 2, 0], bar);
  if (caught) fixed([x, bridgeTop - bridgeHeight / 2, 0], bridgeSize);
  const ball = physics.addBody(null, {
    position: [x, barTop + radius + drop, 0],
    colliders: { shape: 'sphere', radius, mass, friction: 0 },
  });
  world
    .add(sound, { tracks: [{ material: { modes: [mode] } }], sampleRate, historySeconds: 0.75 }, cell)
    .add(new ModalContactRigidSolver(sound), { physics, emitters: [radiator] }, cell);
  const first = { frame: 0, snapshot: world.takeSnapshot(), contacts: [] };
  return {
    world,
    physics,
    sound,
    ball,
    frame: 0,
    contacts: [],
    checkpoints: new Map([[0, first]]),
    visited: new Map(),
  };
}

function seek(take, goal, action) {
  if (action === 'restore' || goal < take.frame) {
    const point = take.checkpoints.get(action === 'restore' ? goal : 0);
    take.world.restoreSnapshot(point.snapshot.bytes);
    take.frame = point.frame;
    take.contacts = [...point.contacts];
  }
  while (goal > take.frame) {
    take.world.advance(++take.frame);
    const contact = take.world.fields.port(take.sound.contactField.name);
    const impulse = regionWords(take.world.memory, contact.region)[0];
    if (impulse > 0) take.contacts.push({ frame: take.frame, impulse });
  }
  const snapshot = take.world.takeSnapshot();
  const prior = take.visited.get(goal);
  if (
    prior &&
    (snapshot.bytes.length !== prior.length || prior.some((byte, offset) => snapshot.bytes[offset] !== byte))
  )
    throw new Error('Restore the same rigid contact, modal bank, clock, and PCM history bytes at the same cut.');
  take.visited.set(goal, snapshot.bytes);
  if (action === 'save') take.checkpoints.set(goal, { frame: goal, snapshot, contacts: [...take.contacts] });
  return snapshot.hash;
}

function pcmBytes(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 4096) binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(binary);
}

const scope = { width: 0.318, y: 0.262, z: -0.09, peak: 0.43, halfHeight: 0.041, bins: 120 };

function waveform(samples, lane, active) {
  const vertices = [],
    normals = [],
    indices = [];
  const quad = (left, right, low, high, z) => {
    const i = vertices.length / 3;
    vertices.push(left, low, z, right, low, z, right, high, z, left, high, z);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
  };
  quad(lane - scope.width / 2, lane + scope.width / 2, scope.y - 0.001, scope.y + 0.001, scope.z + 0.002);
  const perBin = (end * sampleRate) / (rate * scope.bins);
  const step = scope.width / scope.bins;
  for (let bin = 0; active && bin < scope.bins; bin++) {
    let low = 0,
      high = 0;
    for (let j = bin * perBin; j < Math.min((bin + 1) * perBin, samples.length); j++) {
      low = Math.min(low, samples[j]);
      high = Math.max(high, samples[j]);
    }
    if (high - low < 1e-8) continue;
    const x = lane - scope.width / 2 + bin * step;
    const bottom = scope.y + (scope.halfHeight * Math.max(-scope.peak, low)) / scope.peak;
    const top = scope.y + (scope.halfHeight * Math.min(scope.peak, high)) / scope.peak;
    quad(x, x + step, bottom, top, scope.z + 0.0016);
  }
  return geometryData(vertices, normals, new Float32Array((vertices.length / 3) * 2), indices);
}

function apparatus(engine) {
  const part = (geometry, material, position) =>
    engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  const rounded = (size, bevel, material, position) =>
    part(toGeometry(roundedBoxGeometry(...size, 2, bevel)), material, position);
  const deck = new PbrMaterial({ color: '#495450', roughness: 0.58 });
  const paint = new PbrMaterial({ color: '#53605e', roughness: 0.48 });
  const coatedSteel = new PbrMaterial({ color: '#8b9599', roughness: 0.46 });
  const bronze = new PbrMaterial({ color: '#b9864f', roughness: 0.34, metalness: 1 });
  const rubber = new PbrMaterial({ color: '#474948', roughness: 0.86 });
  const bezel = new PbrMaterial({ color: '#303c3b', roughness: 0.48 });
  const screen = new PbrMaterial({ color: '#263f3d', roughness: 0.71 });
  const grid = new PbrMaterial({ color: '#526862', roughness: 0.69 });
  engine
    .createMesh()
    .setGeometry(box(2.2, 0.04, 1.4))
    .setMaterial(deck)
    .setPosition([0, -0.026, -0.04]);
  rounded([0.858, 0.053, 0.36], 0.012, deck, [0, 0.019, -0.021]);
  const y = (0.045 + barTop - bar[1]) / 2;
  const h = barTop - bar[1] - 0.045;
  const balls = [];
  const waveforms = [];
  const sphere = toGeometry(sphereGeometry(radius, 36, 20));
  for (const lane of lanes) {
    // Anderson's free–free bar experiment illustrates support at the first mode's nodal locations.
    // https://physics.byu.edu/docs/publication/3137
    for (const sign of [-1, 1]) {
      const x = lane + sign * bar[0] * (0.5 - 0.224);
      rounded([0.026, h - 0.004, 0.072], 0.0022, paint, [x, y - 0.002, 0]);
      rounded([0.027, 0.004, 0.069], 0.001, rubber, [x, barTop - bar[1] - 0.002, 0]);
    }
    rounded(bar, 0.0012, coatedSteel, [lane, barTop - bar[1] / 2, 0]);
    for (const z of [-0.066, 0.066]) {
      const top = bridgeTop - bridgeHeight;
      rounded([0.03, top - 0.045, 0.02], 0.004, paint, [lane, (top + 0.045) / 2, z]);
    }
    if (lane > 0) rounded(bridgeSize, 0.002, rubber, [lane, bridgeTop - bridgeHeight / 2, 0]);
    balls.push(part(sphere, bronze, [lane, barTop + radius + drop, 0]));

    rounded([0.363, 0.145, 0.021], 0.008, bezel, [lane, scope.y, scope.z - 0.014]);
    rounded([0.334, 0.102, 0.007], 0.003, screen, [lane, scope.y, scope.z - 0.004]);
    for (let i = 0; i <= 6; i++) {
      const x = lane + scope.width * (i / 6 - 0.5);
      part(box(0.0016, 0.086, 0.00055), grid, [x, scope.y, scope.z + 0.0003]);
    }
    for (const step of [-1, 1])
      part(box(scope.width, 0.0016, 0.00055), grid, [lane, scope.y + 0.041 * step, scope.z + 0.0003]);
    rounded([0.065, 0.169, 0.04], 0.005, paint, [lane, 0.128, scope.z - 0.031]);
    const trace = new SurfaceMaterial({ color: '#558376', emissive: [0.16, 0.85, 0.54], roughness: 0.84 });
    waveforms.push(createMesh(engine, waveform(new Float32Array(), lane, false), trace));
  }
  return { balls, waveforms };
}

export async function mountModalSoundFilm() {
  await Physics.load();
  const takes = await Promise.all(lanes.map((x, i) => makeTake(i !== 0, x)));
  const canvas = document.createElement('canvas');
  document.body.replaceChildren(canvas);
  const engine = await EngineKernel.create(canvas, {
    backend: 'webgpu',
    exactSize: [width, height],
    antialias: false,
    camera: { position: [0.1, 0.52, 0.88], target: [0.005, 0.19, -0.005], fov: 35, near: 0.03, far: 5 },
  });
  engine.scene.background = '#233130';
  engine.lighting.direction.set([-0.42, 0.61, 0.47, 1.85]);
  engine.lighting.radiance.set([1, 0.93, 0.8, 1]);
  engine.lighting.ambient.set([0.42, 0.54, 0.64]);
  const gpu = engine.gpu;
  const errors = [];
  engine.onError = (error) => errors.push(String(error));
  gpu.addEventListener('uncapturederror', ({ error }) => errors.push(error.message));
  gpu.pushErrorScope('validation');
  const { balls, waveforms } = apparatus(engine);
  const labels = TextRenderer.attach(engine);
  const title = new Font({ family: 'Arial, sans-serif', weight: 600 });
  const notes = new Font({ family: 'Arial, sans-serif', weight: 400 });
  const label = (text, position, font, fontSize) =>
    labels.add(new Text({ text, position, font, fontSize, color: '#eadbc9', billboard: true, onTop: true }));
  label('Contact makes the steel ring', [-0.333, 0.43, -0.105], title, 0.039);
  label('Normalized PCM · 0–600 ms', [-0.33, 0.386, -0.106], notes, 0.019);
  label('Direct strike', [-0.33, 0.058, 0.12], notes, 0.019);
  label('Striker caught above steel', [0.049, 0.058, 0.12], notes, 0.019);
  Tonemap.attach(engine, { curve: 'neutral', exposure: -0.11 });
  const target = gpu.createTexture({
    size: [width, height],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const output = gpu.createBuffer({
    size: width * height * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const view = { camera: engine.camera, viewport: [0, 0, 1, 1], target: { color: target } };
  const encoded = document.createElement('canvas');
  encoded.width = width;
  encoded.height = height;
  const pixels = encoded.getContext('2d');
  const draw = () => engine.render({ delta: 0, views: [view] });
  await waitForPipelines(draw);
  return {
    cue,
    rate,
    sampleRate,
    checkpoint,
    end,
    seed,
    radius,
    barTop,
    bridgeTop,
    gravityDrop,
    mass,
    drop,
    mode,
    cell,
    async sample({ editFrame, action, showTrace = true }) {
      const frame = Math.max(0, Math.min(end, editFrame - cue));
      const states = takes.map((take, i) => {
        const hash = seek(take, frame, action);
        const position = take.ball.position;
        balls[i].setPosition(position);
        const pcm = take.sound.copySince(0)?.samples ?? new Float32Array();
        waveforms[i].setGeometry(waveform(pcm, lanes[i], showTrace));
        const published = take.world.fields.port(take.sound.pcmField.name)?.cell;
        const accepted = take.world.fields.port(take.sound.contactField.name)?.cell;
        return {
          hash,
          position,
          velocity: take.ball.linearVelocity,
          contacts: take.contacts,
          pcm: pcmBytes(pcm),
          published,
          accepted,
        };
      });
      draw();
      draw();
      const encoder = gpu.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture: target }, { buffer: output, bytesPerRow: width * 4 }, [width, height]);
      gpu.queue.submit([encoder.finish()]);
      await output.mapAsync(GPUMapMode.READ);
      const color = new Uint8ClampedArray(output.getMappedRange()).slice();
      output.unmap();
      pixels.putImageData(new ImageData(color, width, height), 0, 0);
      return { frame, states, image: encoded.toDataURL('image/png').split(',')[1] };
    },
    async dispose() {
      labels.dispose();
      target.destroy();
      output.destroy();
      const validation = (await gpu.popErrorScope())?.message ?? null;
      engine.dispose();
      for (const { sound, physics } of takes) {
        sound[Symbol.dispose]?.();
        physics.dispose();
      }
      return { errors, validation };
    },
  };
}
