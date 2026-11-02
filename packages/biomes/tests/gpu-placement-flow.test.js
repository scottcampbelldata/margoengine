import './gpu-placement-flow-resolve.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { placementFlowModuleCode } from './gpu-placement-flow-entry.mjs';
import { placementBridges } from '../src/gpu-placement-flow-internal.ts';
import { qmul } from '../src/fixed.ts';
const m = await import('./gpu-placement-flow-source.mjs');
const { fakeDevice, installGPUConstants } = await import('./gpu-placement-flow-fake.mjs');
const { dispatchShape } = await import('../src/gpu-placement-flow-transport.ts');
const digest = (parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};
// Recorded from literal copies of git show 8744a35f5:placement.ts and hydrology.ts, before refactoring their algorithms.
const placementGoldens = [
  '80cf90dab6d8ec822e7f66fa72a2972010924e710731b12880233a0ccc440e99',
  '39099daa3d792d0ee6807add615968dd4da613a02dbcb99e6900ae283240deeb',
  'a05881e5447b72d17b46d9dfd49b9bbf4b93490f65355e5567f794b6cdb5c6dc',
];
const flowGoldens = [
  '4949f18d5a3999805749bdcc7ce05f1f4e55b4e3dd332b6fccf23eb1b1345c0b',
  '46ce09b8aa1a9392dc8e350704c8f933b2207eb72776fc206e3d9368b984066d',
  '0c06c6bc0fcff6d18762383938b8e34900310ab937cafdb1d197aff574d8568c',
  '88c2b70eb43c41a511dc6c1acc103e4e7cd512df8e50ffe723145b58ec513b63',
];
async function worldCase(s, work) {
  const w = await m.BiomeWorld.create(s.options),
    p = m.BiomePlacement.attach(w, s.placement);
  try {
    return await work(p, w);
  } finally {
    p.dispose();
    w.dispose();
  }
}

test('pre-J6 CPU goldens and fake transport parity cover clusters, stands, exclusions, strata and boundary aprons', {
  timeout: 30000,
}, async (t) => {
  installGPUConstants(t);
  for (const [i, s] of m.placementCases(m).entries())
    await worldCase(s, async (p) => {
      const cpu = await p.tile(s.x, s.z);
      assert.equal(digest(m.tileBytes(cpu)), placementGoldens[i], s.name);
      const fake = fakeDevice();
      const gpu = await m.placeTileGPU(fake.device, p, s.x, s.z);
      assert.equal(digest(m.tileBytes(gpu)), placementGoldens[i], s.name);
      fake.assertFreed();
      for (const name of ['counts', 'emit', 'accept', 'kill'])
        assert.ok(
          fake.dispatch.some((d) => d[0] === name),
          name,
        );
    });
});
test('valid wrapped cluster intensity tables retain CPU placement parity', { timeout: 10000 }, async (t) => {
  installGPUConstants(t);
  const s = m.placementCases(m)[0];
  s.options.biomes = [
    m.defineBiome({
      id: 'wrapped',
      climate: {},
      ground: [{ material: 'grass' }],
      plants: [
        {
          id: 'wrapped-thomas',
          mesh: 'oak',
          radius: 1,
          density: 35,
          cluster: { kind: 'thomas', parents: 0.0001, spread: 9 },
        },
      ],
    }),
  ];
  await worldCase(s, async (p) => {
    const plan = placementBridges.get(p)(s.x, s.z).plan;
    assert.ok(
      plan.specs.some((sp) => sp.cluster?.table.some((v) => v < 0)),
      'fixture reaches Int32 table wrapping',
    );
    const expected = await p.tile(s.x, s.z),
      fake = fakeDevice();
    const actual = await m.placeTileGPU(fake.device, p, s.x, s.z);
    assert.deepEqual(m.tileBytes(actual), m.tileBytes(expected));
    fake.assertFreed();
  });
});

test('pre-J6 hydrology byte goldens, flat drainage, sea, partial groups and signed height boundaries', {
  timeout: 15000,
}, async (t) => {
  installGPUConstants(t);
  for (const [i, s] of m.flowCases().entries()) {
    const expected = m.hydrology(s.grid, s.options);
    assert.equal(digest(m.flowBytes(expected)), flowGoldens[i], s.name);
    const fake = fakeDevice(),
      actual = await m.hydrologyGPU(fake.device, s.grid, s.options);
    assert.deepEqual(actual, expected, s.name);
    fake.assertFreed();
    assert.ok(fake.dispatch.some((d) => d[0] === 'd8'));
    assert.ok(fake.dispatch.some((d) => d[0] === 'accumulate'));
  }
});
test('auto/cpu/default retain identical bytes; world GPU remains unsupported', { timeout: 15000 }, async () => {
  const s = m.placementCases(m)[0];
  for (const backend of ['auto', 'cpu', undefined])
    await worldCase({ ...s, options: { ...s.options, backend } }, async (p) =>
      assert.equal(digest(m.tileBytes(await p.tile(s.x, s.z))), placementGoldens[0]),
    );
  await assert.rejects(
    m.BiomeWorld.create({ ...s.options, backend: 'gpu' }),
    (e) => e.name === 'MargoError' && e.code === 'unsupported',
  );
});
test('inputs are snapshotted before await', async (t) => {
  installGPUConstants(t);
  const s = m.flowCases()[1],
    expected = m.hydrology({ ...s.grid, height: s.grid.height.slice() }, s.options);
  const fake = fakeDevice({
    onPipeline: () => {
      s.grid.height.fill(-99);
      s.options.channelCells = 1000;
    },
  });
  assert.deepEqual(await m.hydrologyGPU(fake.device, s.grid, s.options), expected);
  fake.assertFreed();
});
test('every invocation and every round is accounted for', { timeout: 15000 }, async (t) => {
  installGPUConstants(t);
  for (const skip of ['d8', 'accumulate']) {
    const fake = fakeDevice({ skip }),
      s = m.flowCases()[1];
    await assert.rejects(
      m.hydrologyGPU(fake.device, s.grid, s.options),
      (e) => e.code === 'failed' && /unwritten/.test(e.message),
    );
    fake.assertFreed();
  }
  await worldCase(m.placementCases(m)[0], async (p) => {
    for (const skip of ['counts', 'emit', 'accept', 'kill']) {
      const fake = fakeDevice({ skip });
      await assert.rejects(m.placeTileGPU(fake.device, p, 0, 0), (e) => e.code === 'failed');
      fake.assertFreed();
    }
  });
});
test('already aborted requests never access the device', async () => {
  const c = new AbortController(),
    reason = { why: 'caller' };
  c.abort(reason);
  const device = new Proxy(
      {},
      {
        get() {
          assert.fail('aborted request touched device');
        },
      },
    ),
    s = m.flowCases()[0];
  await assert.rejects(m.hydrologyGPU(device, s.grid, s.options, { signal: c.signal }), (e) => e === reason);
  await assert.rejects(m.placeTileGPU(device, null, 0, 0, { signal: c.signal }), (e) => e === reason);
});
test('abort while mapping retains reason and frees all buffers and listeners', { timeout: 10000 }, async (t) => {
  installGPUConstants(t);
  const c = new AbortController(),
    reason = { abort: 17 };
  const fake = fakeDevice({
      onMap: () => {
        c.abort(reason);
        return new Promise(() => {});
      },
    }),
    s = m.flowCases()[0];
  await assert.rejects(m.hydrologyGPU(fake.device, s.grid, s.options, { signal: c.signal }), (e) => e === reason);
  fake.assertFreed();
  await worldCase(m.placementCases(m)[0], async (p) => {
    const c = new AbortController(),
      f = fakeDevice({
        onMap: () => {
          c.abort(reason);
          return new Promise(() => {});
        },
      });
    await assert.rejects(m.placeTileGPU(f.device, p, 0, 0, { signal: c.signal }), (e) => e === reason);
    f.assertFreed();
  });
});
test('compile, pipeline, dispatch, map, scope, uncaptured, allocation and device loss fail honestly', {
  timeout: 15000,
}, async (t) => {
  installGPUConstants(t);
  for (const fail of ['compile', 'pipeline', 'dispatch', 'map', 'scope', 'uncaptured', 'allocation', 'lost']) {
    const fake = fakeDevice({ fail }),
      s = m.flowCases()[1];
    await assert.rejects(
      m.hydrologyGPU(fake.device, s.grid, s.options),
      (e) =>
        e.name === 'MargoError' && e.code === 'failed' && (fail !== 'lost' || /device lost.*recreate/i.test(e.message)),
      fail,
    );
    fake.assertFreed();
    await worldCase(m.placementCases(m)[0], async (p) => {
      const f = fakeDevice({ fail });
      await assert.rejects(m.placeTileGPU(f.device, p, 0, 0), (e) => e.code === 'failed', fail);
      f.assertFreed();
    });
  }
});
test('invalid grids, plans, tile indices and device limits fail before allocation', { timeout: 10000 }, async (t) => {
  installGPUConstants(t);
  const s = m.flowCases()[0];
  for (const grid of [
    null,
    { ...s.grid, height: [] },
    { ...s.grid, nx: 2.5 },
    { ...s.grid, nz: 0 },
    { ...s.grid, step: NaN },
  ]) {
    const fake = fakeDevice();
    await assert.rejects(m.hydrologyGPU(fake.device, grid), (e) => e instanceof TypeError || e instanceof RangeError);
    assert.equal(fake.buffers.length, 0);
    fake.assertFreed();
  }
  for (const options of [{ channelCells: 0 }, { lakeDepth: 0 }, { sea: Infinity }, { multiple: 1 }]) {
    const fake = fakeDevice();
    await assert.rejects(m.hydrologyGPU(fake.device, s.grid, options), RangeError);
    assert.equal(fake.buffers.length, 0);
  }
  for (const limit of [
    'maxBufferSize',
    'maxStorageBufferBindingSize',
    'maxComputeWorkgroupsPerDimension',
    'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX',
  ]) {
    const fake = fakeDevice();
    fake.device.limits[limit] = 0;
    await assert.rejects(m.hydrologyGPU(fake.device, s.grid), RangeError);
    assert.equal(fake.buffers.length, 0);
    fake.assertFreed();
    await worldCase(m.placementCases(m)[0], async (p) => {
      await assert.rejects(m.placeTileGPU(fake.device, p, 0, 0), RangeError);
      assert.equal(fake.buffers.length, 0);
      fake.assertFreed();
    });
  }
  const fake = fakeDevice();
  await assert.rejects(m.placeTileGPU(fake.device, {}, 0, 0), TypeError);
  await worldCase(m.placementCases(m)[0], async (p) => {
    for (const x of [-1, 0.5, 2]) await assert.rejects(m.placeTileGPU(fake.device, p, x, 0), RangeError);
  });
  assert.equal(fake.buffers.length, 0);
});
test('two-dimensional flattened dispatch preserves partial groups', () => {
  const { device } = fakeDevice();
  device.limits.maxComputeWorkgroupsPerDimension = 3;
  assert.deepEqual(dispatchShape(device, 193), [3, 2]);
  assert.deepEqual(dispatchShape(device, 65), [2, 1]);
  assert.throws(() => dispatchShape(device, 577), RangeError);
});

test('synchronous pipeline failure observes every earlier rejected pipeline promise', { timeout: 10000 }, async (t) => {
  installGPUConstants(t);
  const s = m.flowCases()[0],
    fake = fakeDevice({ fail: 'sync-pipeline' });
  await assert.rejects(m.hydrologyGPU(fake.device, s.grid, s.options), (e) => e.code === 'failed');
  fake.assertFreed();
  await worldCase(m.placementCases(m)[0], async (p) => {
    const fake = fakeDevice({ fail: 'sync-pipeline' });
    await assert.rejects(m.placeTileGPU(fake.device, p, 0, 0), (e) => e.code === 'failed');
    fake.assertFreed();
  });
  await new Promise((resolve) => setImmediate(resolve));
});

test('GPU run pools survive concurrent CPU placement; edits reject stale GPU output', { timeout: 10000 }, async (t) => {
  installGPUConstants(t);
  await worldCase(m.placementCases(m)[0], async (p) => {
    const fake = fakeDevice({
      onMap: async (count) => {
        if (count === 3) await p.tile(1, 0);
      },
    });
    const actual = await m.placeTileGPU(fake.device, p, 0, 0);
    assert.equal(digest(m.tileBytes(actual)), placementGoldens[0]);
    fake.assertFreed();
    let updated = false;
    const stale = fakeDevice({
      onMap: () => {
        if (!updated) {
          updated = true;
          p.update({ conflicts: { 'thomas|matern': 0.4 } });
        }
      },
    });
    await assert.rejects(
      m.placeTileGPU(stale.device, p, 0, 0),
      (e) => e.code === 'failed' && /World changed/.test(e.message),
    );
    stale.assertFreed();
  });
});

test('an empty placement preserves off outputs without fake GPU work', { timeout: 10000 }, async (t) => {
  installGPUConstants(t);
  const s = m.placementCases(m)[0];
  s.options.biomes = [m.defineBiome({ id: 'empty', climate: {}, ground: [{ material: 'grass' }] })];
  await worldCase(s, async (p) => {
    const expected = await p.tile(0, 0),
      fake = fakeDevice();
    const actual = await m.placeTileGPU(fake.device, p, 0, 0);
    assert.equal(actual.count, 0);
    assert.equal(digest(m.tileBytes(actual)), digest(m.tileBytes(expected)));
    assert.equal(fake.dispatch.length, 0);
    fake.assertFreed();
  });
});
test('u32 limb product and signed Q16 mirror match independent BigInt at overflow boundaries', () => {
  const wide = (a, b) => {
    const p = (a & 65535) * (b & 65535),
      q = (a >>> 16) * (b & 65535) + (p >>> 16),
      r = (a & 65535) * (b >>> 16) + (q & 65535);
    return [((r << 16) | (p & 65535)) >>> 0, ((a >>> 16) * (b >>> 16) + (q >>> 16) + (r >>> 16)) >>> 0];
  };
  for (const a of [0, 1, 65535, 65536, 2147483647, 2147483648, 4294967295])
    for (const b of [1, 65536, 2147483647, 4294967295]) {
      const [lo, hi] = wide(a, b);
      assert.equal((BigInt(hi) << 32n) | BigInt(lo), BigInt(a) * BigInt(b));
    }
  for (const a of [-2147483648, -2147483647, -65537, -1, 0, 1, 2147483647])
    for (const b of [-2147483648, -1, 65536, 2147483647]) {
      const product = BigInt(a) * BigInt(b),
        floor = product >= 0n ? product / 65536n : -((-product + 65535n) / 65536n);
      const [lo, hi] = wide(Math.abs(a) >>> 0, Math.abs(b) >>> 0),
        mag = ((hi << 16) | (lo >>> 16)) >>> 0;
      const actual = (a < 0 !== b < 0 ? -mag - (lo & 65535 ? 1 : 0) : mag) | 0;
      assert.equal(actual, Number(BigInt.asIntN(32, floor)));
    }
});
test('signed cluster limbs preserve wrapped interpolation and apply the CPU cap after the entire sum', () => {
  const signed = (v) => [v >>> 0, v < 0 ? 4294967295 : 0];
  const add = (a, b) => {
    const lo = (a[0] + b[0]) >>> 0;
    return [lo, (a[1] + b[1] + (lo < a[0] ? 1 : 0)) >>> 0];
  };
  const cases = [
    [[2147483647, -2147483648, 63]],
    [[-2147483648, 2147483647, 63]],
    [
      [1000000000, 1000000000, 0],
      [-1000000000, -1000000000, 0],
      [1, 1, 0],
    ],
    [
      [2147483647, 2147483647, 0],
      [2147483647, 2147483647, 0],
      [-2147483648, -2147483648, 0],
      [-2147483648, -2147483648, 0],
    ],
    [[-123456789, 987654321, 63]],
  ];
  for (const entries of cases) {
    let sum = [0, 0],
      expected = 0;
    for (const [a, b, f] of entries) {
      // JS's >> wraps the full product. WGSL wraps each i32 operation, giving the same low bits.
      expected += a + (((b - a) * f) >> 6);
      const interpolation = Math.imul((b - a) | 0, f) >> 6;
      sum = add(sum, add(signed(a), signed(interpolation)));
    }
    const negative = (sum[1] & 2147483648) !== 0;
    const capped = (!negative && (sum[1] !== 0 || sum[0] > 262144) ? 262144 : sum[0]) | 0;
    for (const beta of [1, 32768, 65536]) assert.equal(qmul(beta, capped), qmul(beta, Math.min(262144, expected)));
  }
  // Keep this mirror attached to the shader's signed addends and single final cap.
  assert.match(m.PLACEMENT_WGSL, /let interpolation=\(\(b-a\)\*f\)>>6u;/);
  assert.match(m.PLACEMENT_WGSL, /sum=addwide\(sum,addwide\(signedwide\(a\),signedwide\(interpolation\)\)\);/);
  assert.match(m.PLACEMENT_WGSL, /let capped=select\(sum.x,262144u,!negative/);
});

test('WGSL has no float arithmetic or signed division and uses the CPU cluster cap', () => {
  for (const code of [m.PLACEMENT_WGSL, m.LUBY_WGSL, m.FLOW_WGSL]) {
    const text = code.replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(text, /\bf32\b|\bf16\b/);
    // All division/remainder operands are unsigned; no signed '/' or '%' is permitted.
    assert.doesNotMatch(text, /\b(?:i32|x|z|drop|delta|sum|value|top)\s*[/%]/);
    assert.match(text, /@workgroup_size\(64\)/);
    assert.match(text, /if \([^\n]*>=n\)/);
  }
  assert.match(m.PLACEMENT_WGSL, /qmul\(beta,bitcast<i32>\(capped\)\)/);
});
test('GPU entries stay internal; public exports are unchanged', () => {
  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8'),
    entry = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.doesNotMatch(index, /gpu-placement|gpu-flow|placeTileGPU|hydrologyGPU/);
  assert.doesNotMatch(entry, /gpu-placement|gpu-flow/);
});
test('hardware bundle exposes the literal complete proof graph', { timeout: 15000 }, async () => {
  const context = { TextEncoder };
  runInNewContext(await placementFlowModuleCode(), context, { timeout: 2000 });
  const proof = context.__margoPlacementFlowProof;
  for (const name of [
    'placeTileGPU',
    'hydrologyGPU',
    'rectFieldsGPU',
    'classifyGPU',
    'placementCases',
    'flowCases',
    'BiomePlacement',
    'hydrology',
  ])
    assert.equal(typeof proof[name], 'function', name);
  assert.equal(proof.placementCases(proof).length + proof.flowCases().length + 2, proof.PLACEMENT_FLOW_CASE_COUNT);
});
