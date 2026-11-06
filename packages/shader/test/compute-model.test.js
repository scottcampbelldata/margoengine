import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComputePass,
  If,
  Loop,
  NodeMaterial,
  block,
  float,
  globalId,
  instanceIndex,
  localId,
  localIndex,
  storage,
  storageBarrier,
  textureBarrier,
  uint,
  workgroup,
  workgroupBarrier,
  workgroupCount,
  workgroupId,
} from '../dist/index.js';

const count = (text, part) => text.split(part).length - 1;

test('a 1D pass keeps its exact shape', () => {
  const out = storage(10, 'u32'),
    pass = new ComputePass(10, (i) => out.store(i, i));
  assert.match(pass.code, /@compute @workgroup_size\(64\) fn main\(@builtin\(global_invocation_id\) gid:vec3u\) \{\n {2}if \(gid\.x >= 10u\) \{ return; \}/);
});

test('2D and 3D passes guard each axis and number invocations row by row', () => {
  const out = storage(6 * 5, 'u32'),
    two = new ComputePass([6, 5], (i) => out.store(i, globalId.x.add(globalId.y)));
  assert.match(two.code, /@workgroup_size\(8, 8\)/);
  assert.match(two.code, /if \(any\(gid\.xy >= vec2u\(6u, 5u\)\)\) \{ return; \}/);
  assert.match(two.code, /\(gid\.y \* 6u \+ gid\.x\)/);
  const three = new ComputePass([2, 3, 4], (i) => out.store(i, 1));
  assert.match(three.code, /@workgroup_size\(4, 4, 4\)/);
  assert.match(three.code, /if \(any\(gid >= vec3u\(2u, 3u, 4u\)\)\) \{ return; \}/);
  assert.match(three.code, /\(\(gid\.z \* 3u \+ gid\.y\) \* 2u \+ gid\.x\)/);
  assert.match(new ComputePass([8, 8], () => out.store(0, 1), { workgroupSize: [16, 4] }).code, /@workgroup_size\(16, 4\)/);
});

test('a dispatch asks for the right workgroups on each axis', () => {
  const groups = [],
    pass = new ComputePass([100, 9, 3], () => storage(1, 'u32').store(0, 1), { workgroupSize: [8, 8, 1] }),
    device = {
      createShaderModule: () => ({}),
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createBuffer: (d) => ({ ...d }),
      queue: { writeBuffer() {} },
    };
  globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32, INDIRECT: 256 };
  pass.encode(
    device,
    {
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups: (...a) => groups.push(a),
        end() {},
      }),
    },
    { width: 1, height: 1 },
  );
  assert.deepEqual(groups, [[13, 2, 3]]);
});

test('sizes outside the limits are refused', () => {
  const out = storage(1, 'u32'),
    body = () => out.store(0, 1);
  assert.throws(() => new ComputePass(0, body), RangeError);
  assert.throws(() => new ComputePass([4, 0], body), RangeError);
  assert.throws(() => new ComputePass([4, 1.5], body), RangeError);
  assert.throws(() => new ComputePass(4, body, { workgroupSize: 257 }), RangeError);
  assert.throws(() => new ComputePass([4, 4], body, { workgroupSize: [32, 32] }), RangeError);
  assert.throws(() => new ComputePass([4, 4, 4], body, { workgroupSize: [1, 1, 65] }), RangeError);
  assert.throws(() => new ComputePass(65536 * 64, body), RangeError);
  assert.doesNotThrow(() => new ComputePass([65535 * 8, 8], body));
});

test('invocation inputs reach the entry point only when used', () => {
  const out = storage(64, 'u32'),
    pass = new ComputePass(64, (i) =>
      out.store(i, localId.x.add(localIndex).add(workgroupId.x).add(workgroupCount.x)),
    );
  for (const part of ['local_invocation_id) lid', 'local_invocation_index) lix', 'workgroup_id) wid', 'num_workgroups) nwg'])
    assert.match(pass.code, new RegExp(part.replace(')', '\\)')));
  assert.doesNotMatch(new ComputePass(64, (i) => out.store(i, i)).code, /lid|lix|wid|nwg/);
  assert.throws(() => new NodeMaterial({ roughnessNode: localIndex.toFloat() }), /not available in fragment/);
  assert.equal(instanceIndex.type, 'u32');
});

test('workgroup memory is declared once, written in order, and a barrier drops the early return', () => {
  const tile = workgroup(64, 'f32'),
    out = storage(64, 'f32'),
    pass = new ComputePass(64, (i) => {
      tile.store(localIndex, i.toFloat());
      workgroupBarrier();
      return out.store(i, tile.element(localIndex.add(1).mod(64)));
    });
  assert.match(pass.code, /var<workgroup> ndg\d+:array<f32, 64>;/);
  assert.equal(count(pass.code, 'var<workgroup>'), 1);
  assert.doesNotMatch(pass.code, /return;/);
  assert.ok(pass.code.indexOf('] = f32(gid.x);') < pass.code.indexOf('workgroupBarrier();'));
  assert.equal(
    pass.program.resources.reduce((n, r) => n + r.resource.bindings, 0),
    1,
    'workgroup memory takes no binding',
  );
});

test('a barrier needs whole workgroups', () => {
  const out = storage(100, 'u32');
  assert.throws(
    () =>
      new ComputePass(100, (i) => {
        workgroupBarrier();
        return out.store(i, 1);
      }),
    /multiple of workgroupSize/,
  );
  assert.doesNotThrow(
    () =>
      new ComputePass(
        96,
        (i) => {
          storageBarrier();
          return out.store(i, 1);
        },
        { workgroupSize: 32 },
      ),
  );
});

// A barrier orders what came before it, so a write the body made first must not slide to the end of the body.
test('a storage write made before a barrier happens before it, once', () => {
  const out = storage(64, 'u32'),
    other = storage(64, 'u32'),
    pass = new ComputePass(64, (i) => {
      const first = out.store(i, 1);
      storageBarrier();
      other.store(i, out.element(i));
      return first;
    });
  assert.equal(count(pass.code, '] = 1u;'), 1);
  assert.ok(pass.code.indexOf('] = 1u;') < pass.code.indexOf('storageBarrier();'));
  assert.ok(pass.code.indexOf('storageBarrier();') < pass.code.lastIndexOf('] = ndb'));
});

test('a value read before a barrier is read again after it', () => {
  const tile = workgroup(64, 'u32'),
    out = storage(64, 'u32'),
    pass = new ComputePass(64, (i) => {
      const v = tile.element(0).add(1);
      out.store(0, v.add(v));
      workgroupBarrier();
      return out.store(i, v.add(v));
    });
  assert.equal(count(pass.code, 'ndg'), 3, pass.code);
});

test('a storage value written in a statement is read again', () => {
  const a = storage(4, 'u32'),
    pass = new ComputePass(4, (i) => {
      const v = a.element(0).add(1);
      Loop(2, () => {
        a.store(0, v.add(v));
      });
    });
  assert.ok(pass.code.indexOf('for (') < pass.code.indexOf('ndb0[0u] + 1u'), pass.code);
});

// Bug: the docs promised every read before any write, but two writes were emitted with their reads inline, so the second
// read the first's result.
test('with several writes, every read happens before any write', () => {
  const a = storage(4, 'u32'),
    b = storage(4, 'u32'),
    pass = new ComputePass(4, (i) => [a.store(i, b.element(i)), b.store(i, a.element(i))]);
  const reads = [...pass.code.matchAll(/let nd\d+ = ndb\d+\[gid\.x\];/g)].length;
  assert.equal(reads, 2, pass.code);
  assert.ok(pass.code.lastIndexOf('let nd') < pass.code.indexOf(`[gid.x] = nd`));
});

test('every atomic operation exists on storage and workgroup memory', () => {
  const s = storage(8, 'u32', { atomic: true }),
    w = workgroup(8, 'i32', { atomic: true }),
    out = storage(1, 'u32'),
    pass = new ComputePass(64, () => {
      for (const target of [s, w]) {
        const v = target === s ? uint(1) : 1;
        target.atomicSub(0, v);
        target.atomicAnd(1, v);
        target.atomicOr(2, v);
        target.atomicXor(3, v);
        target.atomicExchange(4, v);
        target.atomicMax(5, v);
        target.atomicMin(6, v);
        target.atomicAdd(7, v);
      }
      w.atomicStore(0, 2);
      out.store(0, w.atomicLoad(0).toUint());
    });
  for (const op of ['atomicSub', 'atomicAnd', 'atomicOr', 'atomicXor', 'atomicExchange', 'atomicMax', 'atomicMin', 'atomicAdd'])
    assert.equal(count(pass.code, op + '('), 2, op);
  assert.match(pass.code, /var<workgroup> ndg\d+:array<atomic<i32>, 8>;/);
  assert.match(pass.code, /atomicStore\(&ndg\d+\[0u\], 2i\);/);
});

test('compareExchange gives the old value and whether it swapped', () => {
  const lock = storage(1, 'u32', { atomic: true }),
    out = storage(64, 'u32'),
    pass = new ComputePass(64, (i) => {
      const { old, exchanged } = lock.atomicCompareExchange(0, 0, 1);
      If(exchanged, () => out.store(i, old.add(1)));
    });
  assert.match(pass.code, /let (nd\d+) = atomicCompareExchangeWeak\(&ndb\d+\[0u\], 0u, 1u\);/);
  assert.match(pass.code, /if \(nd\d+\.exchanged\)/);
  assert.match(pass.code, /nd\d+\.old_value \+ 1u/);
  assert.equal(count(pass.code, 'atomicCompareExchangeWeak'), 1);
});

test('atomics on plain memory are refused', () => {
  assert.throws(() => workgroup(4, 'u32').atomicAdd(0, 1), /needs workgroup\(n, 'u32', \{atomic: true\}\)/);
  assert.throws(() => storage(4, 'u32').atomicSub(0, 1), /needs storage/);
  assert.throws(() => workgroup(4, 'f32', { atomic: true }), /must be u32 or i32/);
  assert.throws(() => workgroup(0, 'u32'), /at least 1/);
});

test('workgroupUniformLoad gives a branch a value the whole group agrees on', () => {
  const flag = workgroup(1, 'u32'),
    out = storage(64, 'u32'),
    pass = new ComputePass(64, (i) => {
      const go = flag.uniformLoad(0);
      If(go.equal(1), () => {
        workgroupBarrier();
        out.store(i, 1);
      });
    });
  assert.match(pass.code, /let nd\d+ = workgroupUniformLoad\(&ndg\d+\[0u\]\);/);
  assert.throws(() => workgroup(1, 'u32', { atomic: true }).uniformLoad(0), /plain workgroup memory/);
});

test('indirect dispatch reads three u32 and needs a buffer that holds them', () => {
  const args = storage(new Uint32Array([1, 1, 1, 2, 1, 1]), 'u32'),
    out = storage(256, 'u32'),
    calls = [];
  globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_DST: 8, COPY_SRC: 4, VERTEX: 32, INDIRECT: 256 };
  const buffers = [],
    device = {
      createShaderModule: () => ({}),
      createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
      createBindGroup: () => ({}),
      createBuffer: (d) => (buffers.push(d), { ...d }),
      queue: { writeBuffer() {} },
    };
  const pass = new ComputePass(256, (i) => out.store(i, 1), { indirect: args, indirectOffset: 3 });
  pass.encode(
    device,
    {
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroupsIndirect: (b, offset) => calls.push([b.size, offset]),
        end() {},
      }),
    },
    { width: 1, height: 1 },
  );
  assert.deepEqual(calls, [[24, 12]]);
  assert.ok(buffers.every((b) => b.usage & GPUBufferUsage.INDIRECT));
  assert.match(pass.code, /if \(gid\.x >= 256u\) \{ return; \}/);
  const body = (i) => out.store(i, 1);
  assert.throws(() => new ComputePass(4, body, { indirect: storage(2, 'u32') }), /three elements/);
  assert.throws(() => new ComputePass(4, body, { indirect: storage(3, 'f32') }), /u32 storage/);
  assert.throws(() => new ComputePass(4, body, { indirect: args, indirectOffset: 4 }), /three elements/);
  assert.doesNotThrow(() => new ComputePass(65536 * 64, body, { indirect: args }));
});

test('barriers and workgroup memory stay out of other stages', () => {
  assert.throws(
    () =>
      new NodeMaterial({
        roughnessNode: block(() => {
          workgroupBarrier();
          return float(0);
        }),
      }),
    /only available in ComputePass/,
  );
  assert.throws(() => new NodeMaterial({ roughnessNode: workgroup(1, 'f32').element(0) }), /only available in ComputePass/);
  assert.throws(() => textureBarrier(), /textureBarrier runs inside/);
});
