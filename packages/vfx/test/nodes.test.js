import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { evaluateNodes, MAX_NODES, MAX_NODE_CONSTS } from '../dist/nodes.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};

const codeOf = (pipeline) => (pipeline.compute ?? pipeline.vertex).module.code;
const sample = {
  position: [0, 0, 0],
  velocity: [1, 0, 0],
  size: 0.2,
  color: [0.2, 0.4, 0.6],
  life: 3,
  age: 4,
};

test('nodes compile to an acceleration after fields and read literals from binding 24', () => {
  assert.equal(MAX_NODES, 32);
  assert.equal(MAX_NODE_CONSTS, 16);
  const graph = [
    { op: 'const', value: [0, 2, 0] },
    { op: 'force', inputs: [0] },
    { op: 'const', value: 0.5 },
    { op: 'drag', inputs: [2] },
  ];
  assert.deepEqual(evaluateNodes(graph, sample), [-0.5, 2, 0]);
  assert.deepEqual(
    evaluateNodes(
      [
        { op: 'const', value: [0, 0, 0] },
        { op: 'normalize', inputs: [0] },
        { op: 'force', inputs: [1] },
      ],
      sample,
    ),
    [0, 0, 0],
  );
  for (const value of [
    [1e-21, 0, 0],
    [1e20, 0, 0],
  ]) {
    assert.deepEqual(
      evaluateNodes(
        [
          { op: 'const', value },
          { op: 'normalize', inputs: [0] },
          { op: 'force', inputs: [1] },
        ],
        sample,
      ),
      [1, 0, 0],
    );
  }
  assert.deepEqual(
    evaluateNodes(
      [
        { op: 'attribute', value: 'velocity' },
        { op: 'scale', inputs: [0], value: 2 },
        { op: 'force', inputs: [1] },
      ],
      sample,
    ),
    [2, 0, 0],
  );
  assert.deepEqual(
    evaluateNodes(
      [
        { op: 'const', value: [3, 4, 0] },
        { op: 'length', inputs: [0] },
        { op: 'drag', inputs: [1] },
      ],
      sample,
    ),
    [-5, 0, 0],
  );
  assert.deepEqual(
    evaluateNodes(
      [
        { op: 'const', value: [0, 0, 0] },
        { op: 'const', value: [2, 4, 6] },
        { op: 'const', value: 0.25 },
        { op: 'mix', inputs: [0, 1, 2] },
        { op: 'force', inputs: [3] },
      ],
      sample,
    ),
    [0.5, 1, 1.5],
  );
  assert.deepEqual(
    evaluateNodes(
      [
        { op: 'attribute', value: 'age' },
        { op: 'attribute', value: 'velocity' },
        { op: 'mul', inputs: [1, 0] },
        { op: 'force', inputs: [2] },
      ],
      sample,
    ),
    [4, 0, 0],
  );

  const options = { capacity: 4, nodes: { graph }, fields: { attractors: [] } };
  const { h, effect } = attach(options);
  h.frame();
  const codes = h.pipelines.map(codeOf);
  const simulation = codes.find((code) => code.includes('fn update('));
  assert.ok(simulation.includes('+fieldForce(p.positionLife.xyz)+nodeAccel(p)'));
  assert.ok(simulation.includes('@group(0) @binding(24)'));
  assert.ok(simulation.includes('a+=n0'));
  assert.ok(simulation.includes('a-=n2*p.velocitySize.xyz'));
  const params = h.resources.find((r) => {
    if (r.size !== 32) return false;
    const data = new Float32Array(r.data);
    return data[1] === 2 && data[4] === 0.5;
  });
  assert.ok(params);
  assert.deepEqual([...new Float32Array(params.data)], [0, 2, 0, 0, 0.5, 0, 0, 0]);
  options.nodes.graph[0].value = [0, 3, 0];
  h.frame();
  assert.equal(new Float32Array(params.data)[1], 3);
  effect.options.nodes = { graph: [] };
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();

  const plain = attach({ capacity: 2, nodes: { graph: graph.slice(0, 2) } });
  plain.h.frame();
  const plainCode = plain.h.pipelines.map(codeOf).find((code) => code.includes('fn nodeAccel'));
  assert.ok(plainCode.includes('curlNoise(p.positionLife.xyz)+nodeAccel(p)'));
  assert.equal(plainCode.includes('fieldForce'), false);
  plain.effect.dispose();

  const scaled = attach({
    capacity: 1,
    nodes: {
      graph: [
        { op: 'const', value: [1e-21, 0, 0] },
        { op: 'normalize', inputs: [0] },
        { op: 'force', inputs: [1] },
      ],
    },
  });
  scaled.h.frame();
  const scaledCode = scaled.h.pipelines.map(codeOf).find((code) => code.includes('fn nodeAccel'));
  assert.match(scaledCode, /fn nodeNorm\(v:vec3f\)->vec3f\{let a=max\(abs\(v\.x\),max\(abs\(v\.y\),abs\(v\.z\)\)\);/);
  assert.equal(scaledCode.includes('1e-20'), false);
  assert.equal(scaledCode.includes('max(len'), false);
  scaled.effect.dispose();

  const cold = attach({
    capacity: 2,
    nodes: {
      graph: [
        { op: 'attribute', value: 'color' },
        { op: 'force', inputs: [0] },
      ],
    },
  });
  cold.h.frame();
  const coldCode = cold.h.pipelines.map(codeOf).find((code) => code.includes('fn nodeAccel'));
  assert.ok(coldCode.includes('particles[cold]'));
  cold.effect.dispose();

  const off = attach({ capacity: 2 });
  off.h.frame();
  assert.equal(
    off.h.pipelines.map(codeOf).some((code) => code.includes('nodeAccel')),
    false,
  );
  off.effect.dispose();
});

test('nodes rejects a bad graph and a base effect that did not import the entry', () => {
  assert.throws(() => new Base({ nodes: { graph: [] } }, {}), /needs nodes from @margoengine\/vfx\/nodes/);
  const bad = (graph) => assert.throws(() => evaluateNodes(graph, sample), TypeError);
  bad(null);
  bad([{ op: 'nope' }]);
  bad([{ op: 'add', inputs: [0] }]);
  bad([
    { op: 'add', inputs: [1, 1] },
    { op: 'add', inputs: [0, 0] },
  ]);
  bad([{ op: 'const', value: [1, 2] }]);
  bad([
    { op: 'const', value: 1 },
    { op: 'force', inputs: [0] },
  ]);
  bad(Array.from({ length: 33 }, () => ({ op: 'const', value: 1 })));
  const { h, effect } = attach({ capacity: 2, nodes: { graph: [{ op: 'const', value: 1 }] } });
  h.frame();
  effect.options.nodes.graph[0].op = 'attribute';
  effect.options.nodes.graph[0].value = 'life';
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();
});

test('nodes rejects a finite double that is not a finite f32', () => {
  const link = /https:\/\/margoengine.com\/errors#vfx-float/;
  assert.throws(
    () =>
      evaluateNodes(
        [
          { op: 'const', value: [1e40, 0, 0] },
          { op: 'force', inputs: [0] },
        ],
        sample,
      ),
    (error) => error instanceof RangeError && link.test(error.message) && /const\[0\]/.test(error.message),
  );
  assert.throws(
    () => evaluateNodes([{ op: 'const', value: NaN }, { op: 'force', inputs: [0] }], sample),
    TypeError,
  );
  assert.throws(
    () =>
      evaluateNodes(
        [
          { op: 'const', value: [1, 0, 0] },
          { op: 'scale', inputs: [0], value: 1e40 },
          { op: 'force', inputs: [1] },
        ],
        sample,
      ),
    (error) => error instanceof RangeError && link.test(error.message) && /scale/.test(error.message),
  );
  assert.deepEqual(
    evaluateNodes(
      [
        { op: 'const', value: [0, 2, 0] },
        { op: 'force', inputs: [0] },
      ],
      sample,
    ),
    [0, 2, 0],
  );
  const { h, effect } = attach({
    capacity: 1,
    nodes: {
      graph: [
        { op: 'const', value: [0, 2, 0] },
        { op: 'force', inputs: [0] },
      ],
    },
  });
  h.frame();
  effect.options.nodes.graph[0].value = [1e40, 0, 0];
  assert.throws(() => h.frame(), (error) => error instanceof RangeError && link.test(error.message));
  effect.dispose();
});
