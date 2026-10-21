import test from 'node:test';
import assert from 'node:assert/strict';
import * as graphApi from '../dist/graph.js';

const fixture = () => ({
  version: 1,
  nodes: [
    { id: 'position', op: 'position', inputs: [] },
    { id: 'scale', op: 'float', inputs: [], value: 2 },
    { id: 'scaled', op: 'mul', inputs: ['position', 'scale'] },
    { id: 'bands', op: 'sin', inputs: ['scaled'] },
    { id: 'color', op: 'saturate', inputs: ['bands'] },
  ],
  outputs: { color: 'color' },
  fallback: { color: [1, 1, 1], emissive: [0, 0, 0], roughness: 0.7, metalness: 0, opacity: 1 },
});

test('serializable graphs compile native NodeMaterial and evaluate the same original coordinate expression', () => {
  const graph = fixture(),
    original = structuredClone(graph);
  const parsed = graphApi.parseSurfaceGraph(graphApi.serializeSurfaceGraph(graph));
  assert.deepEqual(parsed, original);
  const material = graphApi.createGraphMaterial(parsed);
  assert.deepEqual(graphApi.inspectSurfaceGraph(parsed).types, {
    position: 'vec3f',
    scale: 'f32',
    scaled: 'vec3f',
    bands: 'vec3f',
    color: 'vec3f',
  });
  assert.match(material.fragmentCode, /sin\(/);
  assert.match(material.fragmentCode, /s\.base/);
  const sample = graphApi.evaluateSurfaceGraph(parsed, { position: [0, Math.PI / 4, -1], normal: [0, 1, 0] });
  assert.deepEqual(sample.color, [0, 1, 0]);
  assert.deepEqual(graph, original);
});

test('all nodes including disconnected nodes reject cycles, duplicates, missing inputs and wrong surface types', () => {
  const invalid = fixture();
  invalid.nodes.push({ id: 'loop', op: 'sin', inputs: ['loop'] });
  assert.throws(() => graphApi.validateSurfaceGraph(invalid), /cycle/i);
  const duplicate = fixture();
  duplicate.nodes.push(duplicate.nodes[0]);
  assert.throws(() => graphApi.validateSurfaceGraph(duplicate), /unique/i);
  const missing = fixture();
  missing.nodes[2].inputs[1] = 'absent';
  assert.throws(() => graphApi.validateSurfaceGraph(missing), /missing/i);
  const wrong = fixture();
  wrong.outputs.roughness = 'color';
  assert.throws(() => graphApi.validateSurfaceGraph(wrong), /roughness.*f32/i);
  assert.throws(() => graphApi.parseSurfaceGraph('{"version":1}'), /nodes/i);
});

test('graph budgets and nonfinite constants fail before compilation', () => {
  const huge = fixture();
  huge.nodes.push(...Array.from({ length: 129 }, (_, i) => ({ id: `n${i}`, op: 'float', inputs: [], value: 1 })));
  assert.throws(() => graphApi.validateSurfaceGraph(huge), /128/);
  const deep = fixture();
  for (let i = 0; i < 34; i++) deep.nodes.push({ id: `n${i}`, op: 'sin', inputs: [i ? `n${i - 1}` : 'scale'] });
  assert.throws(() => graphApi.validateSurfaceGraph(deep), /depth/i);
  const bad = fixture();
  bad.nodes[1].value = Infinity;
  assert.throws(() => graphApi.validateSurfaceGraph(bad), /finite/i);
});

test('mixed scalar/vector inputs, parameters, vector channels and stable order round trip', () => {
  const graph = fixture();
  graph.nodes.push({ id: 'r', op: 'component', inputs: ['position'], value: 0 });
  graph.outputs.roughness = 'r';
  const sample = graphApi.evaluateSurfaceGraph(graph, { position: [0.25, 0, 0], normal: [0, 1, 0] });
  assert.equal(sample.roughness, 0.25);
  assert.equal(
    graphApi.serializeSurfaceGraph(graph),
    graphApi.serializeSurfaceGraph(graphApi.parseSurfaceGraph(graphApi.serializeSurfaceGraph(graph))),
  );
  const scalar = fixture();
  scalar.nodes[0] = { id: 'position', op: 'float', inputs: [], value: 0.5 };
  assert.throws(() => graphApi.validateSurfaceGraph(scalar), /color.*vec3f/i);
});

test('baking evaluates only reachable outputs, matching native material dead-node elimination', () => {
  const graph = fixture();
  graph.nodes.push(
    { id: 'zero', op: 'float', inputs: [], value: 0 },
    { id: 'unused', op: 'div', inputs: ['zero', 'zero'] },
  );
  assert.deepEqual(graphApi.evaluateSurfaceGraph(graph, { position: [0, 0, 0], normal: [0, 1, 0] }).color, [0, 0, 0]);
});
