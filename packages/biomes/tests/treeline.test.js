import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGraph } from '../dist/graph.js';
import { alpineTreelineGraph } from '../dist/treeline.js';

const options = {
  elevation: 3450,
  mature: ['wood/fir'],
  young: ['wood/young-fir'],
  stunted: ['edge/krummholz'],
  seed: 71,
};

function tile(height, exposure = 50, curvature = 0, x = 0) {
  const cells = 64;
  const layers = { height: height * 1000, exposure, curvature };
  return {
    x,
    z: 0,
    cells,
    resolution: 4,
    layer(name) {
      return { data: new Int32Array(cells * cells).fill(layers[name]) };
    },
  };
}

test('the alpine transition changes from mature forest to patches of shorter trees to bare ground', () => {
  const graph = alpineTreelineGraph(options);
  assert.deepEqual(graph.outputs, {
    'wood/fir': 'mature',
    'wood/young-fir': 'young',
    'edge/krummholz': 'stunted',
  });
  const mask = (role, height, exposure, curvature) => evaluateGraph(graph, role, tile(height, exposure, curvature));
  assert.ok(mask('mature', 3250).every((value) => value === 255));
  assert.ok(mask('stunted', 3250).every((value) => value === 0));
  assert.ok(mask('mature', 3590).every((value) => value === 0));
  assert.ok(mask('young', 3470).some((value) => value > 40));
  const sheltered = mask('stunted', 3480, 50, -40);
  const exposed = mask('stunted', 3480, 224, 40);
  assert.ok(Math.max(...sheltered) - Math.min(...sheltered) > 45, 'one elevation has distinct patches');
  assert.ok(
    sheltered.some((value, i) => value > exposed[i] + 70),
    'hollows shelter trees that an exposed ridge cannot',
  );
  assert.ok(mask('stunted', 3670).every((value) => value === 0));
  const repeated = alpineTreelineGraph(options);
  assert.deepEqual(evaluateGraph(repeated, 'stunted', tile(3480)), mask('stunted', 3480));
  assert.notDeepEqual(
    evaluateGraph(alpineTreelineGraph({ ...options, seed: 99 }), 'stunted', tile(3480)),
    mask('stunted', 3480),
  );
});

test('the alpine transition validates its extents and cohort selectors', () => {
  assert.throws(() => alpineTreelineGraph({ ...options, elevation: Infinity }), RangeError);
  assert.throws(() => alpineTreelineGraph({ ...options, patchSize: 11 }), RangeError);
  assert.throws(() => alpineTreelineGraph({ ...options, mature: [] }), RangeError);
  assert.throws(() => alpineTreelineGraph({ ...options, young: options.mature }), RangeError);
});
