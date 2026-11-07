// A real seek: a cutscene drives real GPU particles and a real mesh. The same time is reached by playing and by seeking,
// and the particle buffer and the picture are read back from the GPU each way.
import { Engine, PbrMaterial, box } from '@margoengine/core';
import { createHeadlessCanvas, installGPU, readPixels } from '@margoengine/headless';
import { VFX } from '@margoengine/vfx';
import { Cutscene, CutscenePlayer } from '../src/index.ts';
import { VfxDirector, activationTrack, applyActivation, vfxTrack } from '../src/vfx.ts';

const STEP = 1 / 60;

// Two clips with a gap shorter than a particle's life, so the second starts among what the first left. A burst sits
// between two frames on purpose. The cube shows from 1 s to 3 s.
const scene = {
  format: 'margo-cutscene',
  version: 1,
  duration: 4,
  tracks: [
    {
      type: 'vfx',
      id: 'fx',
      target: 'sparks',
      clips: [
        { start: 0.5, duration: 0.7, rate: 600, bursts: [{ time: 0.2542, count: 200 }] },
        { start: 1.5, duration: 0.5, rate: 300 },
      ],
    },
    { type: 'activation', id: 'on', target: 'cube', clips: [{ start: 1, duration: 2 }] },
  ],
};

/** FNV-1a over the words: equal hashes mean equal bytes, for what a page can hand back cheaply. */
function hash(words) {
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) h = Math.imul(h ^ words[i], 0x01000193);
  return h >>> 0;
}

async function words(device, buffer, size) {
  const copy = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, copy, 0, size);
  device.queue.submit([encoder.finish()]);
  await copy.mapAsync(GPUMapMode.READ);
  const data = new Uint32Array(copy.getMappedRange().slice(0));
  copy.destroy();
  return data;
}

window.check = async () => {
  const installed = installGPU({ gpu: navigator.gpu }),
    engine = await Engine.create(createHeadlessCanvas({ width: 256, height: 192 }), { backend: 'webgpu' }),
    errors = [],
    cube = engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({ color: '#3f7fd0' })).setPosition([-1.5, 0, 0]),
    effect = VFX.attach(engine, {
      capacity: 4096,
      position: [0.5, 0, 0],
      velocity: [0, 1.5, 0],
      spread: 1.5,
      lifetime: [0.4, 0.9],
      size: 0.06,
      color: [1, 0.5, 0.1, 1],
      gravity: [0, -3, 0],
      ground: -1.5,
    }),
    cutscene = new Cutscene(scene, { tracks: [vfxTrack(), activationTrack()] }),
    player = new CutscenePlayer(cutscene),
    director = new VfxDirector(cutscene, { sparks: effect }, { step: (delta) => engine.render({ delta }), stepSize: STEP });
  engine.gpu.addEventListener('uncapturederror', (event) => errors.push(event.error.message));

  const draw = () => {
    director.apply(player.state);
    applyActivation(player.state, { cube });
    engine.render({ delta: STEP });
  };
  const read = async () => {
    const { particles, indirect } = effect.gpuState,
      pixels = await readPixels(engine);
    return {
      particles: hash(await words(engine.gpu, particles, 4096 * 64)),
      live: (await words(engine.gpu, indirect, 20))[1],
      picture: hash(new Uint32Array(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength / 4)),
      cube: cube.visible,
    };
  };

  // Straight through, as a game loop runs it.
  const wanted = [40, 70, 100, 110, 140, 200],
    played = {};
  void player.play();
  for (let frame = 0; frame <= 200; frame++) {
    if (frame) player.update(STEP);
    draw();
    if (wanted.includes(frame)) played[frame] = await read();
  }

  // The same frames by seeking, out of order, from wherever the last seek left things. The times are frame * STEP,
  // not the sums the player made, so a time a rounding apart must land on the same frame.
  const sought = {};
  for (const frame of [140, 70, 200, 100, 40]) {
    player.seek(frame * STEP);
    draw();
    sought[frame] = await read();
  }
  // From frame 100 play on: seeking must leave things as playing would have, so frame 110 comes out the same.
  player.seek(100 * STEP);
  draw();
  for (let frame = 101; frame <= 110; frame++) {
    player.seek(frame * STEP);
    draw();
  }
  sought[110] = await read();

  effect.dispose();
  engine.dispose();
  installed.dispose();
  return { errors, played, sought };
};
window.ready = true;
