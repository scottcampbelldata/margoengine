import { materialEngine as headless } from './helpers.js';
// exportModel retainedVisibility: a loaded model's KHR_node_visibility is copied only when asked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGLTFAsync } from '@margoengine/gltf-pro';
import { exportGLB } from '../dist/index.js';
import { exportModel } from '../dist/model.js';
import { headlessModels } from '../../../tests/support/pbr-snapshot.js';

test('retainedVisibility copies source node visibility; the default leaves it out', () =>
  headlessModels(async () => {
    const geometry = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
      source = exportGLB({
        nodes: [
          { name: 'shown', geometry, retainedVisibility: true },
          { name: 'helper', geometry, retainedVisibility: false },
          { name: 'plain', geometry },
        ],
      }),
      model = await parseGLTFAsync(await headless(), source);
    const out = await exportModel(model, { retainedVisibility: true, onlyVisible: false }),
      nodes = Object.fromEntries(out.json.nodes.map((node) => [node.name, node.extensions?.KHR_node_visibility]));
    assert.deepEqual(nodes, { shown: { visible: true }, helper: { visible: false }, plain: undefined });
    assert.deepEqual(out.json.extensionsUsed, ['KHR_node_visibility']);
    const plain = await exportModel(model);
    assert.ok(plain.json.nodes.every((node) => node.extensions === undefined));
    await assert.rejects(exportModel(model, { retainedVisibility: 1 }), TypeError);
  }));
