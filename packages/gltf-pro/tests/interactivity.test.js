// The graph without an engine. The published conformance suite runs in packages/animation/tests/interactivity.test.js, as
// it needs the animation sampler; these pin what the suite does not: limits, the reading of a file, and the public surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GLTFAsset } from '../dist/index.js';
import { loadBehaviorGraph } from '../dist/interactivity.js';

const asset = (graph, extra = {}) =>
  new GLTFAsset(
    {
      asset: { version: '2.0' },
      extensionsUsed: ['KHR_interactivity'],
      extensionsRequired: ['KHR_interactivity'],
      nodes: [{ name: 'parent', children: [1] }, { name: 'child' }],
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
      extensions: { KHR_interactivity: { graph: 0, graphs: [graph] } },
      ...extra,
    },
    [],
  );
const types = [{ signature: 'float4' }, { signature: 'int' }, { signature: 'float' }, { signature: 'bool' }, { signature: 'float3' }, { signature: 'ref' }];
const [INT, FLOAT3, REF] = [1, 4, 5];
const onSelect = {
  op: 'event/onSelect',
  extension: 'KHR_node_selectability',
  outputValueSockets: {
    selectedNode: { type: REF },
    selectionRayOrigin: { type: FLOAT3 },
    selectionPoint: { type: FLOAT3 },
    controllerIndex: { type: INT },
    event: { type: REF },
  },
};
const set = (declaration, value = [0, 1, 0, 1]) => ({
  declaration,
  configuration: { pointer: { value: ['/materials/0/pbrMetallicRoughness/baseColorFactor'] }, type: { value: [0] } },
  values: { value: { type: 0, value } },
});

test('a file with no graph has nothing to run, and nothing is rejected', () => {
  assert.deepEqual(loadBehaviorGraph(new GLTFAsset({ asset: { version: '2.0' } }, [])), {});
});

test('a written property reaches the live hook and reads back', () => {
  const writes = [],
    { graph } = loadBehaviorGraph(
      asset({ types, declarations: [{ op: 'event/onStart' }, { op: 'pointer/set' }], nodes: [{ declaration: 0, flows: { out: { node: 1, socket: 'in' } } }, set(1)] }),
      { live: (pointer, value) => writes.push([pointer, value]) },
    );
  graph.start();
  assert.deepEqual(writes, [['/materials/0/pbrMetallicRoughness/baseColorFactor', [0, 1, 0, 1]]]);
});

test('time moves only through tick, and the first tick starts the graph once', () => {
  let starts = 0;
  const { graph } = loadBehaviorGraph(
    asset({
      types,
      events: [{ id: 'began' }],
      declarations: [{ op: 'event/onStart' }, { op: 'event/send' }],
      nodes: [{ declaration: 0, flows: { out: { node: 1, socket: 'in' } } }, { declaration: 1, configuration: { event: { value: [0] } } }],
    }),
  );
  graph.on('began', () => starts++);
  assert.equal(graph.time, 0);
  // The first tick is at time zero: the time since the start of the graph is what the clock reads.
  graph.tick(0.25);
  assert.equal(graph.time, 0);
  graph.tick(0.25);
  assert.equal(graph.time, 0.25);
  assert.equal(starts, 1);
});

// A file is untrusted and the node set is Turing complete, so a loop that never ends must stop the graph and not the page.
test('a flow that never ends halts the graph at its activation budget and leaves the caller running', () => {
  const { graph } = loadBehaviorGraph(
    asset({
      types,
      declarations: [{ op: 'event/onStart' }, { op: 'flow/while' }],
      nodes: [
        { declaration: 0, flows: { out: { node: 1, socket: 'in' } } },
        { declaration: 1, values: { condition: { type: 3, value: [true] } } },
      ],
    }),
    { maxActivations: 1000 },
  );
  graph.start();
  assert.match(graph.halted, /activation limit/);
  graph.tick(1);
  assert.match(graph.halted, /activation limit/);
});

test('select climbs from the node to its ancestors, and an unselectable node stops it', () => {
  const graph = (selectable) =>
    loadBehaviorGraph(
      asset(
        {
          types,
          events: [{ id: 'hit' }],
          declarations: [onSelect, { op: 'event/send' }],
          nodes: [
            { declaration: 0, configuration: { nodeIndex: { value: [0] } }, flows: { out: { node: 1, socket: 'in' } } },
            { declaration: 1, configuration: { event: { value: [0] } } },
          ],
        },
        {
          nodes: [
            { name: 'parent', children: [1], extensions: { KHR_node_selectability: { selectable } } },
            { name: 'child' },
          ],
        },
      ),
    ).graph;
  for (const [selectable, hits] of [
    [true, 1],
    [false, 0],
  ]) {
    const running = graph(selectable);
    let count = 0;
    running.on('hit', () => count++);
    running.start();
    running.select(1);
    running.tick(0);
    assert.equal(count, hits, `selectable ${selectable}`);
  }
});

test('an extension the runtime does not read never reads as enabled', () => {
  const { graph } = loadBehaviorGraph(
    asset({
      types,
      variables: [
        { type: 3, value: [true] },
        { type: 3, value: [true] },
      ],
      declarations: [{ op: 'event/onStart' }, { op: 'pointer/get' }, { op: 'variable/set' }],
      nodes: [
        { declaration: 0, flows: { out: { node: 3, socket: 'in' } } },
        { declaration: 1, configuration: { pointer: { value: ['/extensionsUsed/KHR_materials_sheen'] }, type: { value: [3] } } },
        { declaration: 1, configuration: { pointer: { value: ['/extensionsUsed/KHR_made_up'] }, type: { value: [3] } } },
        {
          declaration: 2,
          configuration: { variables: { value: [0, 1] } },
          values: { 0: { node: 1, socket: 'value' }, 1: { node: 2, socket: 'value' } },
        },
      ],
    }),
  );
  assert.ok(graph);
  graph.start();
  assert.equal(graph.variable(1), false);
});
