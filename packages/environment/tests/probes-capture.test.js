// CPU checks (mock GPU) of probe capture hooks in @margoengine/environment/probes (LightProbes.addCapture): which
// plugin passes a capture replays, the probe face context they get, the restore of passes that ran before the capture,
// validation, removal and disposal. The GPU itself is checked by tests/probe-capture-browser.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { LightProbes } from '../dist/probes.js';

const coreShader = readFileSync(new URL('../../core/src/shaders.ts', import.meta.url), 'utf8').split('`')[1];
const room = { min: [-2, 0, -2], max: [2, 3, 2] };

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
    sceneOf() {
      return this;
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

// A plugin like terrain or a VFX system: a simulation before the frame, an upload of the camera, a draw after main.
function plugin(log) {
  return {
    name: 'fake',
    registerPasses(graph) {
      graph.add({ name: 'fake:simulate', order: -8, execute: (c) => log.push(['simulate', c]) });
      graph.add({
        name: 'fake:prepare',
        order: -6,
        execute: (c) => log.push(['prepare', c, c.camera.position.slice()]),
      });
      graph.add({
        name: 'fake:draw',
        order: 4,
        execute: (c) => log.push(['draw', c, { format: c.format, attach: c.attach, last: c.last, only: c.only }]),
      });
    },
  };
}

test('addCapture replays the drawing passes into every captured face with the face context', () => {
  const h = harness({ live: { facesPerFrame: 2 } });
  const log = [];
  h.probes.addCapture(plugin(log));
  h.frame.c.attach = () => {};
  h.frame.c.last = true;
  h.render();
  assert.deepEqual(
    log.map((e) => e[0]),
    ['draw', 'draw'],
    'default: only passes ordered after main, once per face, never the simulation',
  );
  for (const [, c, seen] of log) {
    assert.notEqual(c, h.frame.c, 'a context of its own');
    assert.notEqual(c.color, h.frame.c.color, 'the face target');
    assert.equal(c.device, h.gpu.device, 'the real device, not the shader-rewriting proxy');
    assert.deepEqual(seen, { format: 'rgba16float', attach: undefined, last: false, only: false });
  }
  assert.equal(h.frame.c.last, true, "the frame's context keeps its flags");
  assert.equal(typeof h.frame.c.attach, 'function');
});

test('named passes replay in order, and passes that ran before the capture run again with the frame camera', () => {
  const h = harness({ live: { facesPerFrame: 3 } });
  const log = [];
  h.probes.addCapture(plugin(log), { passes: ['fake:draw', 'fake:prepare'] });
  h.render();
  const names = log.map((e) => e[0]);
  assert.deepEqual(names, ['prepare', 'draw', 'prepare', 'draw', 'prepare', 'draw', 'prepare']);
  const last = log.at(-1);
  assert.equal(last[1], h.frame.c, 'the restore runs with the frame context');
  assert.notDeepEqual(log[0][2], last[2], 'the face camera differs from the frame camera');
  assert.deepEqual(last[2], h.frame.c.camera.position.slice());
  // A frame that captures nothing restores nothing.
  h.probes.setLive(null);
  log.length = 0;
  h.render();
  assert.deepEqual(log, []);
});

test('addCapture validates, and removal and disposal stop the replay', () => {
  const h = harness({ live: { facesPerFrame: 1 } });
  const log = [];
  assert.throws(() => h.probes.addCapture({ name: 'x' }), TypeError);
  assert.throws(() => h.probes.addCapture(null), TypeError);
  assert.throws(() => h.probes.addCapture(plugin(log), { passes: 'fake:draw' }), TypeError);
  assert.throws(() => h.probes.addCapture(plugin(log), { passes: ['fake:nope'] }), /no pass 'fake:nope'.*'fake:draw'/);
  const early = { name: 'early', registerPasses: (g) => g.add({ name: 'early', order: -2, execute() {} }) };
  assert.throws(() => h.probes.addCapture(early), /no pass to replay/);
  const remove = h.probes.addCapture(plugin(log));
  h.render();
  assert.equal(log.length, 1);
  remove();
  h.render();
  assert.equal(log.length, 1, 'removed: not replayed');
  h.probes.addCapture(plugin(log));
  h.probes.dispose();
  assert.throws(() => h.probes.addCapture(plugin(log)), /disposed/);
});
