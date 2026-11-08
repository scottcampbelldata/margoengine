import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { Sharpen } from '../dist/sharpen.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
import { present } from '../src/shader.ts';
import { sharpenCode } from '../src/cas.ts';

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
    taa,
    frame() {
      view.begin(index++);
      run(view.c);
      view.end();
    },
  };
}

test('Sharpen puts the shared unsharp mask into the present shader in place of the plain read', () => {
  const code = new Sharpen().code(present);
  assert.ok(code.includes(sharpenCode));
  assert.match(code, /@group\(0\) @binding\(1\) var<uniform> sharpen:vec4f;/);
  assert.match(code, /let c=max\(margoSharpen\(image,vec2i\(i\.clip\.xy\),sharpen\.x\),vec3f\(0\)\);/);
  assert.doesNotMatch(code, /let c=max\(textureLoad\(image/);
  assert.throws(() => new Sharpen().code('fn fragment(){}'), /needs the TAA present shader/);
});

test('the sharpen keeps the neighbourhood range and stops at zero strength', () => {
  assert.match(sharpenCode, /if\(amount<=0\)\{return c;\}/);
  assert.match(sharpenCode, /return clamp\(\(c\+k\*\(n\+s\+w\+e\)\)\/\(1\+4\*k\),lo,hi\);/, 'no halo: inside min/max of 5 taps');
});

test('a present step adds one 16-byte uniform at binding 1, written every frame; no step changes nothing', () => {
  const plain = rig({}),
    plainLog = plain.gpu.record(() => plain.frame());
  const sharpen = new Sharpen({ amount: 0.5 }),
    r = rig({ present: sharpen });
  const first = r.gpu.record(() => r.frame()),
    uniforms = (log) => log.filter((c) => c[0] === 'buffer' && c[2].size === 16);
  assert.equal(uniforms(first).length, uniforms(plainLog).length + 1);
  // The present groups: the resolved frame at 0 and the step's uniform at 1, one per history direction.
  const groups = first.filter(
    (c) => c[0] === 'group' && c[2].entries.length === 2 && c[2].entries[1].binding === 1 && c[2].entries[1].resource.buffer,
  );
  assert.equal(groups.length, 2, 'both history directions present with the uniform');
  const id = groups[0][2].entries[1].resource.buffer;
  assert.equal(groups[1][2].entries[1].resource.buffer, id);
  assert.ok(uniforms(first).some((c) => c[1] === id), 'a 16-byte uniform');
  assert.ok(first.some((c) => c[0] === 'module' && /margoSharpen/.test(c[2].code)));
  assert.ok(!plainLog.some((c) => c[0] === 'module' && /margoSharpen/.test(c[2].code)), 'defaults unchanged');
  sharpen.amount = 0.25;
  const second = r.gpu.record(() => r.frame()),
    write = second.filter((c) => c[0] === 'writeBuffer' && c[1] === id);
  assert.equal(write.length, 1);
  assert.equal(new Float32Array(Uint8Array.from(Buffer.from(write[0][3], 'hex')).buffer)[0], 0.25);
  const end = r.gpu.record(() => r.taa.dispose());
  assert.ok(end.some((c) => c[0] === 'destroy' && c[1] === id), 'the uniform is destroyed with TAA');
});

test('Sharpen and the present option are checked', () => {
  assert.throws(() => new Sharpen({ amount: 2 }), /0 to 1/);
  assert.throws(() => new Sharpen({ amount: Number.NaN }), /0 to 1/);
  assert.throws(() => new TAA({ present: {} }), /Invalid TAA present/);
  assert.throws(() => new TAA({ present: new Sharpen(), velocityOnly: true, depth: () => undefined }), /velocityOnly/);
  const sharpen = new Sharpen(),
    taa = new TAA({ present: sharpen });
  sharpen.amount = -1;
  assert.throws(() => taa.options.present.values(), /0 to 1/);
  assert.equal(new Sharpen().amount, 0.3);
});
