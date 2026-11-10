import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { FilterPipeline } from '../dist/pipeline.js';

function fixture() {
  const calls = [],
    released = [];
  const registry = {
    source: {
      kind: 'source',
      execute: ({ params }) => {
        calls.push('source');
        return params;
      },
    },
    timed: {
      kind: 'source',
      timeDependent: true,
      execute: ({ time }) => {
        calls.push('timed');
        return time;
      },
    },
    filter: {
      kind: 'filter',
      execute: ({ inputs, params }) => {
        calls.push('filter');
        return inputs.reduce((a, b) => a + b, 0) + (params ?? 0);
      },
    },
    layer: {
      kind: 'layer',
      execute: ({ inputs }) => {
        calls.push('layer');
        return inputs[0];
      },
      release: (v) => released.push(v),
    },
  };
  return { registry, calls, released, graph: new FilterPipeline(registry) };
}

test('lazy diamond evaluates ancestors once, invalidates only downstream and serializes concurrent demand', async () => {
  const { graph, calls } = fixture();
  graph
    .add({ id: 's', type: 'source', params: 2 })
    .add({ id: 'a', type: 'filter', inputs: ['s'], params: 3 })
    .add({ id: 'b', type: 'filter', inputs: ['s'], params: 7 })
    .add({ id: 'join', type: 'filter', inputs: ['a', 'b'] })
    .add({ id: 'unused', type: 'source', params: 100 });
  assert.deepEqual(calls, []);
  assert.deepEqual(await Promise.all([graph.run('join'), graph.run('join')]), [14, 14]);
  assert.deepEqual(calls, ['source', 'filter', 'filter', 'filter']);
  graph.setParams('a', 4);
  assert.equal(graph.isDirty('a'), true);
  assert.equal(graph.isDirty('b'), false);
  assert.equal(await graph.run('join'), 15);
  assert.deepEqual(calls, ['source', 'filter', 'filter', 'filter', 'filter', 'filter']);
  graph.invalidate('s');
  assert.equal(graph.isDirty('b'), true);
  graph.dispose();
});

test('time changes only time-sensitive ancestry and unchanged requests reuse cache', async () => {
  const { graph, calls } = fixture();
  graph
    .add({ id: 'static', type: 'source', params: 10 })
    .add({ id: 't', type: 'timed' })
    .add({ id: 'f', type: 'filter', inputs: ['static', 't'] });
  assert.equal(await graph.run('f', { time: 2 }), 12);
  assert.equal(graph.isDirty('f', 3), true);
  assert.equal(await graph.run('f', { time: 3 }), 13);
  assert.equal(await graph.run('f', { time: 3 }), 13);
  assert.deepEqual(calls, ['source', 'timed', 'filter', 'timed', 'filter']);
  graph.dispose();
});

test('JSON restores the graph, snapshots mutable params and rejects unsupported values and cycles', async () => {
  const { registry } = fixture();
  const graph = new FilterPipeline(registry);
  const params = { name: ['NASA'] };
  graph.add({ id: 's', type: 'source', params });
  params.name[0] = 'mutated';
  const restored = FilterPipeline.fromJSON(JSON.parse(JSON.stringify(graph)), registry);
  assert.deepEqual(await restored.run('s'), { name: ['NASA'] });
  assert.throws(() => graph.add({ id: 's', type: 'source' }), /unique/);
  assert.throws(() => graph.add({ id: 'x', type: 'filter', inputs: ['x'] }), /Unknown pipeline node/);
  assert.throws(() => graph.add({ id: 'x', type: 'missing' }), /register/);
  const cyclic = {};
  cyclic.self = cyclic;
  for (const value of [NaN, Infinity, undefined, new Date(), cyclic, () => 0, new Array(2)])
    assert.throws(() => graph.setParams('s', value));
  assert.deepEqual(await graph.run('s'), { name: ['NASA'] });
  assert.throws(() => FilterPipeline.fromJSON({ version: 2, nodes: [] }, registry), /version/);
  graph.dispose();
  restored.dispose();
});

test('independent temporal branches retain their own requested times', async () => {
  const { graph } = fixture();
  graph.add({ id: 'a', type: 'timed' }).add({ id: 'b', type: 'timed' });
  await graph.run('a', { time: 8 });
  await graph.run('b', { time: 9 });
  assert.equal(graph.isDirty('a', 8), false);
  assert.equal(graph.isDirty('b', 9), false);
  graph.dispose();
});

test('abort returns exact reason, preserves valid ancestors and never caches aborted output', async () => {
  let enter,
    finish,
    releases = 0;
  const started = new Promise((resolve) => {
    enter = resolve;
  });
  const graph = new FilterPipeline({
    source: { kind: 'source', execute: () => 7 },
    wait: {
      kind: 'filter',
      execute: async () => {
        enter();
        return await new Promise((resolve) => {
          finish = resolve;
        });
      },
      release: () => releases++,
    },
  });
  graph.add({ id: 's', type: 'source' }).add({ id: 'f', type: 'wait', inputs: ['s'] });
  const controller = new AbortController(),
    reason = { user: 'cancel' };
  const run = graph.run('f', { signal: controller.signal });
  await started;
  controller.abort(reason);
  finish(8);
  await assert.rejects(run, (error) => error === reason);
  assert.equal(releases, 1);
  assert.equal(graph.isDirty('s'), false);
  assert.equal(graph.isDirty('f'), true);
  assert.equal(await graph.run('s'), 7);
  graph.dispose();
});

test('mutation cancels stale work; queued cancellation does not poison later requests', async () => {
  let enter, finish;
  const started = new Promise((resolve) => {
    enter = resolve;
  });
  const graph = new FilterPipeline({
    source: { kind: 'source', execute: ({ params }) => params },
    wait: {
      kind: 'filter',
      execute: async ({ inputs }) => {
        enter();
        await new Promise((resolve) => {
          finish = resolve;
        });
        return inputs[0];
      },
    },
  });
  graph.add({ id: 's', type: 'source', params: 1 }).add({ id: 'f', type: 'wait', inputs: ['s'] });
  const run = graph.run('f');
  await started;
  const controller = new AbortController(),
    reason = 'queued cancellation';
  const queued = graph.run('s', { signal: controller.signal });
  controller.abort(reason);
  graph.setParams('s', 2);
  finish();
  await assert.rejects(run, (error) => error.code === 'state');
  await assert.rejects(queued, (error) => error === reason);
  assert.equal(await graph.run('s'), 2);
  graph.dispose();
});

test('release runs downstream first, supports undefined cache and explicit resource management', async () => {
  const released = [],
    graph = new FilterPipeline({
      s: { kind: 'source', execute: () => undefined, release: () => released.push('source') },
      f: { kind: 'filter', execute: () => undefined, release: () => released.push('filter') },
    });
  graph.add({ id: 's', type: 's' }).add({ id: 'f', type: 'f', inputs: ['s'] });
  await graph.run('f');
  assert.equal(graph.isDirty('f'), false);
  graph[Symbol.dispose]();
  graph.dispose();
  assert.deepEqual(released, ['filter', 'source']);
  assert.throws(
    () => graph.run('s'),
    (error) => error.code === 'disposed',
  );
});

test('operator failure is visible, successful source cache survives, later execution works', async () => {
  let fail = true;
  const failure = new TypeError('operator failure');
  const graph = new FilterPipeline({
    s: { kind: 'source', execute: () => 3 },
    f: {
      kind: 'filter',
      execute: ({ inputs }) => {
        if (fail) throw failure;
        return inputs[0];
      },
    },
  });
  graph.add({ id: 's', type: 's' }).add({ id: 'f', type: 'f', inputs: ['s'] });
  await assert.rejects(graph.run('f'), (error) => error === failure);
  assert.equal(graph.isDirty('s'), false);
  fail = false;
  assert.equal(await graph.run('f'), 3);
  graph.dispose();
});

test('real NASA FUN3D solution flows through source, threshold and layer sink', async () => {
  const bytes = readFileSync(new URL('../../../examples/assets/sciviz/pipeline/cf-plate.dat', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'f2995d18cb4f5d603f63ecfe609044844ef45fb3af3a7373923048eb3d364577',
  );
  const text = bytes.toString('utf8');
  let zone = false;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^zone/i.test(line)) {
      zone = /FUN3D/.test(line);
      continue;
    }
    if (zone && line.trim()) rows.push(line.trim().split(/\s+/).map(Number));
  }
  assert.equal(rows.length, 447); // Published FUN3D zone, not the 447-row CFL3D zone.
  const calls = [],
    graph = new FilterPipeline({
      nasa: {
        kind: 'source',
        execute: () => {
          calls.push('read');
          return rows;
        },
      },
      subset: { kind: 'filter', execute: ({ inputs, params }) => inputs[0].filter((row) => row[0] >= params) },
      chart: { kind: 'layer', execute: ({ inputs }) => inputs[0].length },
    });
  graph
    .add({ id: 'nasa', type: 'nasa' })
    .add({ id: 'subset', type: 'subset', inputs: ['nasa'], params: 0 })
    .add({ id: 'view', type: 'chart', inputs: ['subset'] });
  const initial = await graph.run('view');
  graph.setParams('subset', 1);
  assert.ok((await graph.run('view')) < initial);
  assert.deepEqual(calls, ['read']);
  graph.dispose();
});
