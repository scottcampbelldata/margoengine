import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextureBaker } from '../dist/textures.js';

function fake() {
  let lose, finish;
  const textures = [],
    buffers = [];
  const device = {
    limits: { maxTextureDimension2D: 2048 },
    lost: new Promise((resolve) => {
      lose = resolve;
    }),
    createShaderModule() {
      return {
        async getCompilationInfo() {
          return { messages: [] };
        },
      };
    },
    async createComputePipelineAsync() {
      return {
        getBindGroupLayout() {
          return {};
        },
      };
    },
    createBuffer() {
      const b = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(b);
      return b;
    },
    createTexture() {
      const t = {
        destroyed: false,
        createView() {
          return {};
        },
        destroy() {
          this.destroyed = true;
        },
      };
      textures.push(t);
      return t;
    },
    createBindGroup() {
      return {};
    },
    createCommandEncoder() {
      return {
        beginComputePass() {
          return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
        },
        finish() {
          return {};
        },
      };
    },
    queue: {
      writeBuffer() {},
      submit() {},
      onSubmittedWorkDone() {
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  };
  return { device, textures, buffers, lose: () => lose({ reason: 'destroyed' }), finish: () => finish() };
}
const linked = (code) => (e) => e.code === code && e.message.includes('https://margoengine.com/errors#procedural');
test('texture backend, abort and shader compilation faults are linked and preserve causes', async () => {
  for (const source of [null, undefined, 1, 'device'])
    await assert.rejects(createTextureBaker(source), linked('unsupported'));
  await assert.rejects(createTextureBaker({ backend: 'webgl2', gpu: null }), linked('unsupported'));
  const f = fake(),
    controller = new AbortController(),
    reason = new Error('stop');
  for (const options of [null, 1, 'options', []])
    await assert.rejects(createTextureBaker(f.device, options), linked('failed'));
  controller.abort(reason);
  await assert.rejects(createTextureBaker(f.device, { signal: controller.signal }), (e) => e === reason);
  f.device.createComputePipelineAsync = () => Promise.reject(reason);
  await assert.rejects(createTextureBaker(f.device), (e) => linked('failed')(e) && e.cause === reason);
  f.device.createShaderModule = () => ({
    async getCompilationInfo() {
      return { messages: [{ type: 'error', lineNum: 17, message: 'reserved name' }] };
    },
  });
  await assert.rejects(
    createTextureBaker(f.device),
    (e) => linked('failed')(e) && /line 17: reserved name/.test(e.message),
  );
});
test('hostile texture options allocate nothing; lifecycle handles in-flight abort, loss and disposal', async () => {
  const f = fake();
  using baker = await createTextureBaker(f.device);
  for (const options of [
    null,
    1,
    'options',
    [],
    { width: 0 },
    { width: 2049 },
    { width: NaN },
    { height: Infinity },
    { seed: -1 },
    { pattern: 'bad' },
    { repeat: [4, 3] },
    { repeat: [] },
    { repeat: [0, 2] },
    { repeat: [1.5, 2] },
    { detail: NaN },
    { grout: 0.5 },
    { color: [1, 2, 3] },
    { secondary: [] },
    { offset: [Infinity, 0] },
  ])
    await assert.rejects(baker.bake(options), linked('failed'));
  assert.equal(f.textures.length, 0);
  const controller = new AbortController(),
    reason = new Error('cancel exact');
  const aborted = baker.bake({ signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(aborted, (e) => e === reason);
  assert.ok(f.textures[0].destroyed);
  assert.ok(f.buffers[0].destroyed);
  const pending = baker.bake();
  baker.dispose();
  await assert.rejects(pending, linked('disposed'));
  assert.ok(f.textures[1].destroyed);
  assert.ok(f.buffers[1].destroyed);
  await assert.rejects(baker.bake(), linked('disposed'));
  const g = fake();
  using second = await createTextureBaker(g.device);
  const inFlight = second.bake();
  g.lose();
  await assert.rejects(inFlight, linked('failed'));
  assert.ok(g.textures[0].destroyed);
  await assert.rejects(second.bake(), linked('failed'));
});
test('completed outputs detach independently and baker disposal releases retained outputs', async () => {
  const f = fake(),
    baker = await createTextureBaker({ backend: 'webgpu', gpu: f.device });
  const pending = baker.bake();
  f.finish();
  const output = await pending;
  assert.equal(output.width, 256);
  assert.equal(output.height, 256);
  assert.ok(f.buffers[0].destroyed);
  output[Symbol.dispose]();
  output.dispose();
  assert.ok(output.texture.destroyed);
  const next = baker.bake({ width: 16, height: 16, seed: 0, repeat: [64, 64], detail: 0, grout: 0 });
  f.finish();
  const last = await next;
  baker.dispose();
  baker.dispose();
  assert.ok(last.texture.destroyed);
});

test('GPU allocation and queue failures release partial resources and carry a coded cause', async () => {
  const f = fake(),
    reason = new Error('driver allocation');
  using baker = await createTextureBaker(f.device);
  f.device.createTexture = () => {
    throw reason;
  };
  await assert.rejects(baker.bake(), (e) => linked('failed')(e) && e.cause === reason);
  assert.ok(f.buffers[0].destroyed);
  const g = fake();
  using second = await createTextureBaker(g.device);
  g.device.queue.onSubmittedWorkDone = () => Promise.reject(reason);
  await assert.rejects(second.bake(), (e) => linked('failed')(e) && e.cause === reason);
  assert.ok(g.textures[0].destroyed);
  assert.ok(g.buffers[0].destroyed);
});
