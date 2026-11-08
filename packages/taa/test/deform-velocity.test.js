import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';

globalThis.GPUBufferUsage ??= { UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, STORAGE: 128, VERTEX: 32, INDEX: 16 };
function rig(options) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      meshes: new Map(),
      stats: { drawCalls: 0 },
      removePlugin() {},
      store: { visible: new Uint8Array(1), hidden: new Uint8Array(1), parents: new Int32Array(1).fill(-1) },
    };
  const taa = new TAA(options);
  taa.setup(engine);
  const run = passes(taa),
    view = context(gpu, { samples: 1, shader: wgsl });
  let index = 0;
  return {
    gpu,
    engine,
    taa,
    frame() {
      view.begin(index++);
      run(view.c);
      view.end();
    },
  };
}

test('a velocity pass draws its own motion inside the object pass, once a frame per view, and is released', () => {
  const r = rig({}),
    frames = [],
    released = [];
  const drawer = {
    drawVelocity(pass, frame) {
      frames.push(frame);
      pass.draw(3);
    },
    releaseVelocity: (key) => released.push(key),
  };
  const remove = r.taa.add(drawer);
  assert.throws(() => r.taa.add(drawer), /Duplicate TAA source/);
  const log = r.gpu.record(() => r.frame());
  const begins = log.filter((c) => c[0] === 'beginRenderPass'),
    drawAt = log.findIndex((c) => c[0] === 'pass.draw' && c[1] === 3 && log.slice(0, log.indexOf(c)).some((b) => b[0] === 'beginRenderPass'));
  assert.equal(frames.length, 1);
  assert.ok(drawAt > 0 && begins.length >= 2);
  const f = frames[0];
  assert.equal(f.camera.length, 36);
  assert.deepEqual(f.targets, [{ format: 'rg16float' }, { format: 'r32float' }]);
  assert.equal(f.depthStencil.depthCompare, 'equal');
  assert.equal(f.depthStencil.depthWriteEnabled, false);
  assert.equal(f.key, r.taa);
  r.frame();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].camera[34], 1, 'history on the second frame');
  remove();
  assert.deepEqual(released, [r.taa]);
  r.frame();
  assert.equal(frames.length, 2, 'gone once removed');
  r.taa.add(drawer);
  r.frame();
  r.taa.dispose();
  assert.ok(released.length >= 2, 'disposing TAA releases its views');
});

test("a displaced primitive whose graph's move reads its uniforms binds last frame's block beside them", () => {
  const r = rig({}),
    gpu = r.gpu.device,
    uniforms = gpu.createBuffer({ size: 32, usage: 72 }),
    bytes = new Uint8Array(32),
    program = { next: 3, buffers: new WeakMap([[gpu, { bytes }]]) };
  const displacement = {
    key: 'graph',
    cuts: false,
    depth: (code) => code,
    velocity: (code) => code.replace('{var o:Out;', '{var o:Out;var margoPosition=i.position.xyz;'),
    layout: () => gpu.createBindGroupLayout({ entries: [] }),
    entries: () => [{ binding: 0, resource: { buffer: uniforms } }],
    move: ['margoPosition=i.position.xyz+vec3f(ndu.nd0,0,0);'],
    program,
  };
  const node = { matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), engine: r.engine, check() {} },
    primitive = {
      primitive: {},
      node,
      vertex: gpu.createBuffer({ size: 240, usage: 128 | 32 }),
      index: gpu.createBuffer({ size: 12, usage: 16 }),
      count: 3,
      stride: 80,
      displacement,
    };
  r.taa.add({ shadowPrimitives: [primitive] });
  const sent = [],
    frame = (value) => {
      new Float32Array(bytes.buffer)[0] = value;
      const log = r.gpu.record(() => r.frame());
      return log;
    };
  const first = frame(1),
    group = first.find((c) => c[0] === 'group' && c[2].entries.length === 2 && c[2].entries[1].binding === 3),
    kept = group?.[2].entries[1].resource.buffer,
    module = first.find((c) => c[0] === 'module' && /nduBefore/.test(c[2].code));
  assert.ok(group, 'group 1: the graph at 0, last frame at program.next');
  assert.ok(module && /margoBefore-i\.position\.xyz/.test(module[2].code));
  assert.match(module[2].code, /margoPosition=i\.position\.xyz\+vec3f\(nduBefore\.nd0,0,0\);/);
  const value = (log) => {
    const call = log.find((c) => c[0] === 'writeBuffer' && c[1] === kept);
    return call && new Float32Array(Uint8Array.from(Buffer.from(call[3], 'hex')).buffer)[0];
  };
  sent.push(value(first), value(frame(2)), value(frame(5)));
  assert.deepEqual(sent, [1, 1, 2], 'this frame on the first, then always the frame before');
  const end = r.gpu.record(() => r.taa.dispose());
  assert.ok(end.some((c) => c[0] === 'destroy' && c[1] === kept), 'destroyed with TAA');
  // A move that reads no uniform keeps today's shader and group.
  const plain = rig({});
  plain.taa.add({
    shadowPrimitives: [{ ...primitive, node: { ...node, engine: plain.engine }, displacement: { ...displacement, move: [] } }],
  });
  const log = plain.gpu.record(() => plain.frame());
  assert.ok(!log.some((c) => c[0] === 'module' && /nduBefore/.test(c[2].code)));
});
