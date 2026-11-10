import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeUSDFiles, parseUSDFiles } from '../dist/compose.js';
import { valueClips, valueClipFrames, ValueClipPlayer } from '../dist/clips.js';
import { headless, headlessModels } from '../../../tests/support/pbr-snapshot.js';
const folder = new URL('./fixtures/clips/', import.meta.url),
  truth = JSON.parse(readFileSync(new URL('openusd.json', folder), 'utf8'));
const read = (id) => {
  try {
    return new Uint8Array(readFileSync(new URL(id, folder)));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};
for (const [name, cases] of Object.entries(truth))
  test(name + ' value clip poses match OpenUSD 26.11', async () => {
    for (const [time, expected] of Object.entries(cases)) {
      const stage = await composeUSDFiles(name + '.usda', read, {
        extensions: [valueClips({ timeCode: Number(time) })],
      });
      const actual = stage.specs[(name === 'reference' ? '/World' : '/Cache') + '.value']?.fields.default;
      if (expected === null) assert.equal(actual ?? null, null, name + ' ' + time);
      else assert.ok(Math.abs(actual - expected) < 1e-8, `${name} ${time}: ${actual} != ${expected}`);
      assert.equal(stage.specs['/Cache.ignored'], undefined);
    }
  });
test('manifest-backed queries read only the current and adjacent clips', async () => {
  const seen = [];
  await composeUSDFiles(
    'explicit.usda',
    (id) => {
      seen.push(id);
      return read(id);
    },
    { extensions: [valueClips({ timeCode: 2 })] },
  );
  assert.deepEqual(seen, ['explicit.usda', 'manifest.usda', 'a.usda', 'b.usda']);
});
test('an empty local timeSamples declaration does not block weaker values or clips', async () => {
  const source = readFileSync(new URL('explicit.usda', folder), 'utf8').replace(
    'double value\n',
    'double value.timeSamples={}\n',
  );
  const stage = await composeUSDFiles(
    'explicit.usda',
    (id) => (id === 'explicit.usda' ? new TextEncoder().encode(source) : read(id)),
    { extensions: [valueClips({ timeCode: 2 })] },
  );
  assert.equal(stage.specs['/Cache.value'].fields.default, 2);
});
test('topology-changing cache frames match OpenUSD and replace complete models', () =>
  headlessModels(async () => {
    const want = JSON.parse(readFileSync(new URL('topology-openusd.json', folder), 'utf8'));
    const engine = await headless(),
      player = new ValueClipPlayer(engine, 'topology.usda', read);
    try {
      for (const [time, counts] of Object.entries(want)) {
        const model = await player.setTimeCode(Number(time));
        assert.equal(model.primitives[0].indices.length, (counts[0] - 2) * 3);
      }
    } finally {
      player.dispose();
      engine.dispose();
    }
  }));
test('prototype-like clip set names remain own dictionary keys', async () => {
  for (const name of ['constructor', '__proto__']) {
    const source = readFileSync(new URL('explicit.usda', folder), 'utf8').replace(
      'dictionary default=',
      'dictionary ' + name + '=',
    );
    const stage = await composeUSDFiles(
      'explicit.usda',
      (id) => (id === 'explicit.usda' ? new TextEncoder().encode(source) : read(id)),
      { extensions: [valueClips({ timeCode: 2 })] },
    );
    assert.equal(stage.specs['/Cache.value'].fields.default, 2);
    assert.equal(Object.getPrototypeOf(stage.specs['/Cache'].fields.clips), null);
  }
  assert.equal(Object.hasOwn(Object, 'assetPaths'), false);
});
test('frame iteration resolves mesh caches, bounds encoded cache and respects abort', async () => {
  const frames = [];
  for await (const frame of valueClipFrames('explicit.usda', read, {
    startTimeCode: 0,
    endTimeCode: 12,
    step: 4,
    cacheBytes: 4096,
  }))
    frames.push([frame.timeCode, frame.asset.meshes[0].positions[0]]);
  assert.deepEqual(frames, [
    [0, 0],
    [4, 4],
    [8, 14],
    [12, 21],
  ]);
  const signal = AbortSignal.abort();
  await assert.rejects(
    async () => {
      for await (const _ of valueClipFrames('explicit.usda', read, { startTimeCode: 0, endTimeCode: 1, signal }))
        assert.fail('aborted iterator must not yield');
    },
    (error) => error.name === 'AbortError',
  );
});
test('clip player replaces and disposes frames, retaining the previous frame on a failed request', () =>
  headlessModels(async () => {
    const engine = await headless(),
      player = new ValueClipPlayer(engine, 'explicit.usda', read);
    try {
      const first = await player.setTimeCode(0);
      assert.equal(first.disposed, false);
      const next = await player.setTimeCode(8);
      assert.equal(first.disposed, true);
      assert.equal(player.model, next);
      await assert.rejects(
        player.setTimeCode(10, { signal: AbortSignal.abort() }),
        (error) => error.name === 'AbortError',
      );
      assert.equal(player.model, next);
      assert.equal(next.disposed, false);
      player.dispose();
      assert.equal(next.disposed, true);
      await assert.rejects(player.setTimeCode(0), /disposed/);
    } finally {
      player.dispose();
      engine.dispose();
    }
  }));
test('bad clip limits, template metadata and out-of-range active indices reject', async () => {
  assert.throws(() => valueClips({ maxClips: 0 }), RangeError);
  assert.throws(() => valueClips({ timeCode: Infinity }), RangeError);
  await assert.rejects(
    composeUSDFiles('template.usda', read, { extensions: [valueClips({ maxClips: 2 })] }),
    /too many/,
  );
  const root = readFileSync(new URL('explicit.usda', folder), 'utf8').replace('(10,1)', '(10,9)');
  await assert.rejects(
    composeUSDFiles('explicit.usda', (id) => (id === 'explicit.usda' ? new TextEncoder().encode(root) : read(id)), {
      extensions: [valueClips()],
    }),
    /index out of range/,
  );
});
