// CPU checks (mock GPU) of live reflection capture in @margoengine/environment/probes: validation, time slicing (faces
// per frame, the prefilter with each probe's sixth face, one probe at a time), priority (nearest the camera, marked
// dynamic), on-demand refresh promises, the interplay with bake(), device restoration, disposal and pooled resources.
// The GPU itself is checked by examples/package-benchmarks/probes-live-gpu.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { LightProbes } from '../dist/probes.js';

const coreShader = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];
const room = { min: [-2, 0, -2], max: [2, 3, 2] };
const FRAME_BYTES = 128;

function harness(options, { volume = false } = {}) {
  const gpu = mockGPU(),
    d = gpu.device;
  gpu.encoder.finish ??= () => ({});
  let workDone = 0;
  Object.assign(d, {
    createCommandEncoder: () => gpu.encoder,
    pushErrorScope() {},
    popErrorScope: async () => null,
    queue: Object.assign(d.queue, {
      onSubmittedWorkDone: async () => {
        workDone++;
      },
    }),
  });
  const createBuffer = d.createBuffer;
  d.createBuffer = (descriptor) => {
    const value = createBuffer(descriptor);
    if (descriptor.usage & GPUBufferUsage.MAP_READ)
      Object.assign(value, {
        mapAsync: async () => undefined,
        getMappedRange: () => new ArrayBuffer(probes.byteLength - 1088),
        unmap() {},
      });
    return value;
  };
  const engine = {
    backend: 'webgpu',
    gpu: d,
    lighting: { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.3]) },
    onError(error) {
      throw error;
    },
    removePlugin() {},
  };
  const probes = new LightProbes({
      ...(volume ? { volume: { ...room, counts: [2, 1, 1], resolution: 8 } } : {}),
      reflections: [{ position: [0, 1, 0], ...room }],
      resolution: 16,
      ...options,
    }),
    frame = context(gpu, { shader: coreShader }),
    run = passes(probes);
  let frames = 0,
    eye = null;
  const render = () =>
    gpu.record(() => {
      frame.begin(frames++);
      if (eye) frame.camera.position.splice(0, 3, ...eye);
      run(frame.c);
    });
  engine.render = render;
  probes.setup(engine);
  return {
    gpu,
    engine,
    probes,
    frame,
    render,
    /** Pins the main camera's eye (null: the recorder's orbit). */
    look(position) {
      eye = position;
    },
    workDone: () => workDone,
  };
}
// Capture-camera frame uniform writes of one recorded frame: the face's eye position (floats 16-18).
const captures = (log) =>
  log
    .filter((e) => e[0] === 'writeBuffer' && e[2] === 0 && e[3].length === FRAME_BYTES * 2)
    .map((e) => {
      const b = Buffer.from(e[3], 'hex');
      return [64, 68, 72].map((o) => +b.readFloatLE(o).toFixed(4));
    });
const computePasses = (log) => log.filter((e) => e[0] === 'beginComputePass').length;
// The writeBuffer that turns reflection probe j on (its data.w word in the header).
const activation = (log, j) =>
  log.find((e) => e[0] === 'writeBuffer' && e[2] === 64 + j * 64 + 60 && e[3] === '01000000');

test('live options validate, start from the constructor and stop with null', () => {
  const probe = { position: [0, 1, 0], ...room };
  assert.throws(() => new LightProbes({ reflections: [{ ...probe, dynamic: 1 }] }), TypeError);
  assert.throws(
    () => new LightProbes({ volume: { ...room, counts: [1, 1, 1] }, live: {} }),
    /live capture needs reflection probes/,
  );
  const probes = new LightProbes({ reflections: [probe], live: { facesPerFrame: 2 } });
  assert.deepEqual(probes.live, { facesPerFrame: 2, priority: 'nearest', samples: 256 });
  assert.ok(Object.isFrozen(probes.live));
  for (const facesPerFrame of [0, 1.5, 97, NaN])
    assert.throws(() => probes.setLive({ facesPerFrame }), RangeError, String(facesPerFrame));
  assert.throws(() => probes.setLive({ priority: 'far' }), TypeError);
  for (const samples of [32, 100, 8192]) assert.throws(() => probes.setLive({ samples }), /live samples/);
  assert.throws(() => probes.setLive('on'), TypeError);
  assert.deepEqual(probes.live, { facesPerFrame: 2, priority: 'nearest', samples: 256 }, 'failed calls change nothing');
  probes.setLive(null);
  assert.equal(probes.live, null);
  probes.setLive({ priority: 'dynamic', samples: 64, facesPerFrame: 96 });
  assert.deepEqual(probes.live, { facesPerFrame: 96, priority: 'dynamic', samples: 64 });
});

test('live capture renders one cube face per frame and prefilters with the sixth, then turns the probe on', () => {
  const h = harness({ live: { facesPerFrame: 1 } }, { volume: true });
  const logs = Array.from({ length: 13 }, () => h.render());
  // Faces 1-5: one capture draw and submit each, no prefilter; face 6 adds the compute pass (resample + 2 rough levels).
  logs.forEach((log, i) => {
    assert.equal(captures(log).length, 1, `frame ${i}: one face`);
    assert.equal(log.filter((e) => e[0] === 'submit').length, 1);
    assert.equal(computePasses(log), i % 6 === 5 ? 1 : 0, `frame ${i}: prefilter only with the sixth face`);
  });
  assert.deepEqual(
    logs[5].filter((e) => e[0] === 'pass.dispatchWorkgroups').map((e) => [e[1], e[2]]),
    [
      [2, 2],
      [8, 8],
      [4, 4],
    ],
    'resample 16 px (8 x 8 texels per workgroup), prefilter 8 and 4 px (a workgroup per texel); no volume',
  );
  const params = logs[5].find((e) => e[0] === 'writeBuffer' && e[3].length === 3 * 256 * 2),
    uniform = Buffer.from(params[3], 'hex');
  assert.deepEqual(
    [0, 1, 2].map((slot) => uniform.readUInt32LE(slot * 256 + 20)),
    [0, 256, 256],
    'rough levels use 256 GGX samples: a fixed cost',
  );
  assert.match(
    logs.flat().find((e) => e[0] === 'module' && e[2].code.includes('fn prefilter('))[2].code,
    /importanceGGX/,
  );
  // The probe lights receivers from its first refresh on (one header write, after that refresh's prefilter).
  assert.ok(activation(logs[5], 0));
  assert.ok(logs.findIndex((log) => activation(log, 0)) === 5);
  assert.equal(h.probes.refreshes, 2);
  assert.equal(h.probes.baked, false, 'live capture is not a bake: no CPU snapshot');
  // Every face of a refresh sees the same capture point; the six faces turn the camera.
  assert.deepEqual(new Set(logs.flatMap((log) => captures(log).map(String))).size, 1);
  h.probes.setLive(null);
  assert.equal(captures(h.render()).length, 0, 'stopping live capture stops capturing');
  h.probes.dispose();
});

test('facesPerFrame spreads its budget across probes, one probe at a time', () => {
  const reflections = [
      { position: [0, 1, 0], ...room },
      { position: [1, 1, 1], ...room },
    ],
    six = harness({ reflections, live: { facesPerFrame: 6 } }),
    first = six.render();
  assert.equal(captures(first).length, 6);
  assert.equal(computePasses(first), 1, 'a whole probe per frame');
  assert.equal(six.probes.refreshes, 1);
  six.probes.dispose();
  const four = harness({ reflections, live: { facesPerFrame: 4 } }),
    frames = [four.render(), four.render(), four.render()];
  assert.deepEqual(
    frames.map((log) => captures(log).length),
    [4, 4, 4],
  );
  assert.deepEqual(frames.map(computePasses), [0, 1, 1], 'probe A finishes in frame 2, probe B in frame 3');
  assert.deepEqual(
    frames.flatMap(captures).map((p) => p.join()),
    [...Array(6).fill('0,1,0'), ...Array(6).fill('1,1,1')],
    'the second probe starts only after the first one finished',
  );
  four.probes.dispose();
});

test('nearest priority refreshes every probe once per round, the one nearest the camera first', () => {
  const reflections = [
      { position: [-8, 1, 0], min: [-10, 0, -2], max: [-6, 3, 2] },
      { position: [0, 1, 0], ...room },
      { position: [8, 1, 0], min: [6, 0, -2], max: [10, 3, 2] },
    ],
    h = harness({ reflections, live: { facesPerFrame: 6 } }),
    order = () => captures(h.render())[0][0];
  h.look([7, 1, 0]); // inside the +x box
  assert.deepEqual([order(), order(), order()], [8, 0, -8], 'round 1: nearest first');
  h.look([-12, 1, 0]);
  assert.deepEqual([order(), order(), order()], [-8, 0, 8], 'round 2 follows the camera');
  h.look([0, 1, 0]);
  assert.deepEqual([order(), order(), order(), order()], [0, -8, 8, 0], 'ties keep index order; rounds repeat');
  h.probes.dispose();
});

test('dynamic priority refreshes only probes marked dynamic, and none when none are', () => {
  const reflections = [
      { position: [0, 1, 0], ...room },
      { position: [1, 1, 1], ...room, dynamic: true },
      { position: [-1, 1, 1], ...room, dynamic: false },
    ],
    h = harness({ reflections, live: { facesPerFrame: 6, priority: 'dynamic' } });
  const seen = new Set();
  for (let i = 0; i < 5; i++) for (const p of captures(h.render())) seen.add(p.join());
  assert.deepEqual([...seen], ['1,1,1']);
  h.probes.dispose();
  const none = harness({ live: { priority: 'dynamic' } });
  for (let i = 0; i < 3; i++) assert.equal(captures(none.render()).length, 0);
  none.probes.dispose();
});

test('refresh() re-captures on demand ahead of the live order and resolves once the GPU is done', async () => {
  const reflections = [
      { position: [0, 1, 0], ...room },
      { position: [1, 1, 1], ...room },
    ],
    h = harness({ reflections });
  // Without live capture: nothing until asked.
  assert.equal(captures(h.render()).length, 0);
  let done = false;
  const refreshed = h.probes.refresh(1).then(() => {
    done = true;
  });
  const frames = Array.from({ length: 6 }, () => h.render());
  assert.deepEqual(
    frames.map((log) => captures(log).map(String)),
    Array(6).fill(['1,1,1']),
    'one face per frame without live capture',
  );
  assert.equal(computePasses(frames[5]), 1);
  await refreshed;
  assert.ok(done && h.workDone() >= 1, 'resolved after onSubmittedWorkDone');
  assert.equal(captures(h.render()).length, 0, 'then idle again');
  // With live capture: a request jumps the queue after the probe in progress.
  h.probes.setLive({ facesPerFrame: 2 });
  h.look([0, 1, 0]);
  const live = [h.render()]; // live starts probe 0 (faces 1-2)
  const both = h.probes.refresh();
  for (let i = 0; i < 6; i++) live.push(h.render());
  assert.deepEqual(
    live.map((log) => captures(log)[0].join()),
    ['0,1,0', '0,1,0', '0,1,0', '0,1,0', '0,1,0', '0,1,0', '1,1,1'],
    'probe 0 finishes, then the refresh queue (probe 0 again, captured whole after the request, then probe 1)',
  );
  live.push(h.render(), h.render());
  await both;
  await assert.rejects(h.probes.refresh(2), RangeError);
  await assert.rejects(h.probes.refresh(0.5), RangeError);
  const pending = h.probes.refresh(0);
  h.probes.dispose();
  await assert.rejects(pending, (error) => error.name === 'MargoError' && error.code === 'disposed');
  await assert.rejects(h.probes.refresh(0), (error) => error.code === 'disposed');
  const detached = new LightProbes({ reflections });
  await assert.rejects(detached.refresh(), (error) => error.name === 'MargoError' && error.code === 'state');
});

test('a bake during live capture restarts the refresh in progress and keeps its exact prefilter', async () => {
  const h = harness({ live: { facesPerFrame: 1 } });
  h.render();
  h.render(); // faces 1-2 of the first live refresh
  const log = [],
    render = h.engine.render;
  h.engine.render = () => {
    const entries = render();
    log.push(...entries);
    return entries;
  };
  await h.probes.bake();
  h.engine.render = render;
  const exact = log.find((e) => e[0] === 'module' && e[2].code.includes('fn prefilter('));
  assert.ok(!exact || !/importanceGGX/.test(exact[2].code), 'bake keeps the full-source convolution');
  assert.equal(h.probes.baked, true);
  // The live refresh starts over: six more frames to its prefilter.
  const after = Array.from({ length: 6 }, () => h.render());
  assert.deepEqual(after.map(computePasses), [0, 0, 0, 0, 0, 1]);
  h.probes.dispose();
});

test('live capture reuses pooled resources and bind groups across refreshes', () => {
  const h = harness({ live: { facesPerFrame: 3 } });
  for (let i = 0; i < 4; i++) h.render(); // two refreshes: everything created
  const log = Array.from({ length: 40 }, () => h.render()).flat();
  for (const name of ['buffer', 'texture', 'view', 'sampler', 'group', 'renderPipeline', 'computePipeline', 'module'])
    assert.equal(log.filter((entry) => entry[0] === name).length, 0, name + ' must not be recreated');
  assert.equal(h.probes.refreshes, 22);
  h.probes.dispose();
});

test('device restoration darkens live-only probes until recaptured and restarts a requested refresh', async () => {
  const h = harness({ live: { facesPerFrame: 1 } });
  for (let i = 0; i < 6; i++) h.render();
  const pending = h.probes.refresh(0);
  h.render(); // live order: the requested refresh starts (face 1)
  const fresh = mockGPU();
  fresh.encoder.finish = () => ({});
  Object.assign(fresh.device, {
    createCommandEncoder: () => fresh.encoder,
    queue: Object.assign(fresh.device.queue, { onSubmittedWorkDone: async () => undefined }),
  });
  h.engine.gpu = fresh.device;
  const restore = fresh.record(() => h.probes.onDeviceRestored(h.engine));
  const header = Buffer.from(restore.find((e) => e[0] === 'writeBuffer' && e[2] === 0)[3], 'hex');
  assert.equal(header.readUInt32LE(124), 0, 'the probe radiance was lost with the device');
  // Frames on the new device: the requested refresh runs whole and resolves.
  const frame = context(fresh, { shader: coreShader }),
    run = passes(h.probes),
    logs = Array.from({ length: 6 }, (_, i) =>
      fresh.record(() => {
        frame.begin(i);
        run(frame.c);
      }),
    );
  assert.deepEqual(logs.map(computePasses), [0, 0, 0, 0, 0, 1]);
  assert.ok(activation(logs[5], 0), 'lit again after the recapture');
  await pending;
  h.probes.dispose();
});

test('a live capture that throws turns live capture off and rejects waiting refreshes', async () => {
  const h = harness({ live: { facesPerFrame: 1 } }),
    pending = h.probes.refresh(0);
  // Lit by the probes (their patch applies) but without core's tone-map tail, which the capture shader needs.
  h.frame.state.shader = coreShader.replace('let mapped=', 'let toned=');
  assert.throws(() => h.render(), /standard core lighting shader/);
  assert.equal(h.probes.live, null);
  await assert.rejects(pending, /standard core lighting shader/);
  h.frame.state.shader = coreShader;
  assert.equal(captures(h.render()).length, 0, 'a restarted engine does not capture again until asked');
  h.probes.setLive({ facesPerFrame: 6 });
  assert.equal(captures(h.render()).length, 6);
  h.probes.dispose();
});

// Live irradiance volume (dynamic GI): the header word that turns the volume on (4: vec4u per L2 probe).
const volumeOn = (log) => log.find((e) => e[0] === 'writeBuffer' && e[2] === 44 && e[3] === '04000000');
const sweepRoom = { ...room, counts: [3, 1, 1], resolution: 8 };

test('the live volume validates, needs a volume, starts from the constructor and stops with null', () => {
  assert.throws(
    () => new LightProbes({ reflections: [{ position: [0, 1, 0], ...room }], liveVolume: {} }),
    /needs an irradiance volume/,
  );
  const probes = new LightProbes({ volume: { ...room, counts: [2, 2, 2] }, liveVolume: { probesPerFrame: 3 } });
  assert.deepEqual(probes.liveVolume, { probesPerFrame: 3 });
  assert.ok(Object.isFrozen(probes.liveVolume));
  for (const probesPerFrame of [0, 2.5, 4097, NaN])
    assert.throws(() => probes.setLiveVolume({ probesPerFrame }), RangeError, String(probesPerFrame));
  assert.throws(() => probes.setLiveVolume('on'), TypeError);
  assert.deepEqual(probes.liveVolume, { probesPerFrame: 3 }, 'failed calls change nothing');
  probes.setLiveVolume(null);
  assert.equal(probes.liveVolume, null);
  assert.deepEqual(new LightProbes({ volume: { ...room, counts: [1, 1, 1] }, liveVolume: {} }).liveVolume, {
    probesPerFrame: 4,
  });
});

test('the live volume captures probesPerFrame probes a frame in a sweep, and lights the volume after the first', () => {
  const h = harness({ reflections: [], volume: sweepRoom, liveVolume: { probesPerFrame: 2 } });
  const logs = Array.from({ length: 4 }, () => h.render());
  // Two probes a frame: six faces and one SH pass each, the sweep running on across its end (3 probes: 0 1 | 2 0 | ...).
  assert.deepEqual(
    logs.map((log) => captures(log).length),
    [12, 12, 12, 12],
  );
  assert.deepEqual(logs.map(computePasses), [2, 2, 2, 2]);
  const xs = logs.flatMap((log) =>
    captures(log)
      .filter((_, i) => i % 6 === 0)
      .map((p) => p[0]),
  );
  assert.deepEqual(xs, [-1.3333, 0, 1.3333, -1.3333, 0, 1.3333, -1.3333, 0]);
  assert.ok(
    logs[0].filter((e) => e[0] === 'pass.dispatchWorkgroups').every((e) => e[1] === 1 && e[2] === 1),
    'SH only: no reflection resample or prefilter',
  );
  // The volume lights receivers from the end of the first sweep (frame 2), once.
  assert.deepEqual(
    logs.map((log) => !!volumeOn(log)),
    [false, true, false, false],
  );
  assert.equal(h.probes.sweeps, 2, 'eight captures of three probes: two full sweeps');
  assert.equal(h.probes.baked, false, 'live capture is not a bake: no CPU snapshot');
  h.probes.setLiveVolume(null);
  assert.equal(captures(h.render()).length, 0, 'stopping the live volume stops capturing');
  h.probes.dispose();
});

test('live reflections and the live volume share a frame: the reflection faces first, then the volume probes', () => {
  const h = harness({ volume: sweepRoom, live: { facesPerFrame: 2 }, liveVolume: { probesPerFrame: 1 } });
  const log = h.render(),
    eyes = captures(log).map((p) => p[0]);
  assert.deepEqual(eyes, [0, 0, -1.3333, -1.3333, -1.3333, -1.3333, -1.3333, -1.3333]);
  h.probes.dispose();
});

test('a device restore darkens the live volume until a full sweep on the new device', () => {
  const h = harness({ reflections: [], volume: sweepRoom, liveVolume: { probesPerFrame: 3 } });
  assert.ok(volumeOn(h.render()), 'lit after one sweep');
  h.render(); // a sweep in progress on the old device
  const fresh = mockGPU();
  fresh.encoder.finish = () => ({});
  Object.assign(fresh.device, {
    createCommandEncoder: () => fresh.encoder,
    queue: Object.assign(fresh.device.queue, { onSubmittedWorkDone: async () => undefined }),
  });
  h.engine.gpu = fresh.device;
  const restore = fresh.record(() => h.probes.onDeviceRestored(h.engine));
  const header = Buffer.from(restore.find((e) => e[0] === 'writeBuffer' && e[2] === 0)[3], 'hex');
  assert.equal(header.readUInt32LE(44), 0, 'the volume light was lost with the device');
  const frame = context(fresh, { shader: coreShader }),
    run = passes(h.probes),
    log = fresh.record(() => {
      frame.begin(0);
      run(frame.c);
    });
  // The sweep starts again at probe 0 and lights the volume when it ends.
  assert.deepEqual(
    captures(log)
      .filter((_, i) => i % 6 === 0)
      .map((p) => p[0]),
    [-1.3333, 0, 1.3333],
  );
  assert.ok(volumeOn(log));
  h.probes.dispose();
});

test('readback copies the GPU probe data to the CPU, one copy at a time, and needs an attached engine', async () => {
  await assert.rejects(new LightProbes({ volume: sweepRoom }).readback(), /not attached/);
  const h = harness({ reflections: [], volume: sweepRoom, liveVolume: { probesPerFrame: 3 } });
  h.render();
  assert.equal(h.probes.baked, false);
  const log = await h.gpu.record(async () => {
    await Promise.all([h.probes.readback(), h.probes.readback()]);
  });
  assert.equal(log.filter((e) => e[0] === 'copyBufferToBuffer').length, 1, 'concurrent calls share one copy');
  assert.equal(h.probes.texels.length, (h.probes.byteLength - 1088) / 4);
  assert.ok(h.probes.irradianceAt([0, 1, 0], [0, 1, 0]), 'irradianceAt reads the copy');
  h.probes.dispose();
  await assert.rejects(h.probes.readback(), /disposed/);
});
