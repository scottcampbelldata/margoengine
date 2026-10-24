import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB, exportGLTF } from '../dist/index.js';
import { readGLB } from './helpers.js';

const geometry = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] };
const scene = () => ({
  nodes: [
    {
      name: 'Helper-colonly',
      geometry,
      retainedVisibility: false,
      extras: { id: 'helper' },
      children: [
        { name: 'Child', geometry, retainedVisibility: true },
        { name: 'Socket', translation: [0, 2, 0], extras: { id: 'socket' } },
      ],
    },
    { name: 'Art', geometry },
  ],
});

test('retainedVisibility emits optional KHR_node_visibility without filtering triangles or descendants', () => {
  const { json, bin } = readGLB(exportGLB(scene()));
  assert.deepEqual(
    json.nodes.map((node) => node.name),
    ['Helper-colonly', 'Child', 'Socket', 'Art'],
  );
  assert.deepEqual(json.nodes[0].extensions, { KHR_node_visibility: { visible: false } });
  assert.deepEqual(json.nodes[1].extensions, { KHR_node_visibility: { visible: true } });
  assert.equal(json.nodes[2].extensions, undefined);
  assert.equal(json.nodes[3].extensions, undefined);
  assert.deepEqual(json.extensionsUsed, ['KHR_node_visibility']);
  assert.equal(json.extensionsRequired, undefined, 'viewers may use the normal visible fallback');
  assert.equal(json.nodes.filter((node) => node.mesh !== undefined).length, 3);
  assert.ok(bin.length > 0);
  assert.deepEqual(exportGLTF(scene()).json.nodes, json.nodes);
  assert.deepEqual(exportGLTF(scene()).json.extensionsUsed, json.extensionsUsed);
});

test('visible filtering keeps its existing meaning independently of retainedVisibility', () => {
  const data = scene();
  data.nodes[0].visible = false;
  const filtered = readGLB(exportGLB(data)).json;
  assert.deepEqual(
    filtered.nodes.map((node) => node.name),
    ['Art'],
  );
  assert.equal(filtered.extensionsUsed, undefined);
  const retained = readGLB(exportGLB(data, { onlyVisible: false })).json;
  assert.equal(retained.nodes.length, 4);
  assert.deepEqual(retained.nodes[0].extensions?.KHR_node_visibility, { visible: false });
  const legacy = readGLB(exportGLB({ nodes: [{ geometry, visible: false }] }, { onlyVisible: false })).json;
  assert.equal(legacy.nodes[0].extensions, undefined, 'legacy onlyVisible:false exports remain visible');
});

test('retained visibility merges with other node extensions and requires the hierarchy', () => {
  const data = scene();
  data.nodes[0].light = { type: 'point', intensity: 2, color: [1, 1, 1] };
  const { json } = readGLB(exportGLB(data));
  assert.deepEqual(json.nodes[0].extensions, {
    KHR_lights_punctual: { light: 0 },
    KHR_node_visibility: { visible: false },
  });
  assert.ok(json.extensionsUsed.includes('KHR_lights_punctual'));
  assert.ok(json.extensionsUsed.includes('KHR_node_visibility'));
  assert.throws(() => exportGLB(scene(), { flatten: true }), {
    name: 'TypeError',
    message: /retainedVisibility.*hierarchy/,
  });
  for (const retainedVisibility of [null, 0, 'false', {}])
    assert.throws(() => exportGLB({ nodes: [{ geometry, retainedVisibility }] }), {
      name: 'TypeError',
      message: /retainedVisibility must be boolean/,
    });
});
