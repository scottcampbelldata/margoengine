// trussGeometry: member count per pattern, the section's extent, taper, validity and option checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cylinderGeometry } from '../dist/index.js';
import { trussGeometry } from '../dist/extras.js';
import { assertValid } from './support/mesh-checks.js';

const perMember = (sides = 8) => cylinderGeometry(1, 1, 1, sides, 1, false).positions.length / 3;
const members = (data, sides) => data.positions.length / 3 / perMember(sides);
const extent = (data, axis) => {
  let min = Infinity, max = -Infinity;
  for (let i = axis; i < data.positions.length; i += 3) (min = Math.min(min, data.positions[i])), (max = Math.max(max, data.positions[i]));
  return [min, max];
};

test('each pattern has four chords, battens at every panel point and its diagonals', () => {
  const bays = 5;
  assert.equal(members(trussGeometry({ bays })), 4 + 4 * (bays + 1) + 4 * bays);
  assert.equal(members(trussGeometry({ bays, pattern: 'pratt' })), 4 + 4 * (bays + 1) + 4 * bays);
  assert.equal(members(trussGeometry({ bays, pattern: 'x' })), 4 + 4 * (bays + 1) + 8 * bays);
  assert.equal(members(trussGeometry({ bays, battens: false })), 4 + 4 * bays);
  assert.equal(members(trussGeometry({ bays, radialSegments: 5 }), 5), 4 + 4 * (bays + 1) + 4 * bays);
});

test('the girder runs from y = 0 to its length inside its section plus the chord radius', () => {
  const data = trussGeometry({ length: 2, width: 0.3, depth: 0.2, chordRadius: 0.01, lacingRadius: 0.005 });
  assertValid(data);
  const [y0, y1] = extent(data, 1), [x0, x1] = extent(data, 0), [z0, z1] = extent(data, 2);
  assert.ok(y0 < 0 && y0 > -0.011 && y1 > 2 && y1 < 2.011, `y ${y0}..${y1}`);
  assert.ok(Math.abs(x1 - 0.16) < 1e-6 && Math.abs(x0 + 0.16) < 1e-6, `x ${x0}..${x1}`);
  assert.ok(Math.abs(z1 - 0.11) < 1e-6 && Math.abs(z0 + 0.11) < 1e-6, `z ${z0}..${z1}`);
  for (const n of [data.normals]) for (let i = 0; i < n.length; i += 3) assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-4);
});

test('a tapered girder narrows toward its top', () => {
  const data = trussGeometry({ length: 1, width: 0.2, taper: 0.5, bays: 4, chordRadius: 0.004 });
  let top = 0;
  for (let i = 0; i < data.positions.length; i += 3) if (data.positions[i + 1] > 0.999) top = Math.max(top, Math.abs(data.positions[i]));
  assert.ok(top < 0.055 && top > 0.045, `top half-width ${top}`);
});

test('invalid options throw RangeError', () => {
  for (const options of [{ length: 0 }, { width: -1 }, { bays: 0 }, { bays: 1.5 }, { chordRadius: 0.2 }, { radialSegments: 2 }, { pattern: 'k' }, { taper: 0 }])
    assert.throws(() => trussGeometry(options), RangeError, JSON.stringify(options));
});

test('a chain link is a round wire on a stadium of its outside length and width', async () => {
  const { chainLinkGeometry } = await import('../dist/extras.js');
  const data = chainLinkGeometry({ length: 0.06, width: 0.024, wire: 0.003 });
  assertValid(data);
  const [x0, x1] = extent(data, 0), [y0, y1] = extent(data, 1), [z0, z1] = extent(data, 2);
  assert.ok(Math.abs(x1 - 0.012) < 2e-4 && Math.abs(x0 + 0.012) < 2e-4, `x ${x0}..${x1}`);
  assert.ok(Math.abs(y1 - 0.03) < 2e-4 && Math.abs(y0 + 0.03) < 2e-4, `y ${y0}..${y1}`);
  assert.ok(Math.abs(z1 - 0.003) < 1e-4 && Math.abs(z0 + 0.003) < 1e-4, `z ${z0}..${z1}`);
  for (const options of [{ length: 0 }, { width: 0.1 }, { wire: 0.01 }]) assert.throws(() => chainLinkGeometry(options), RangeError);
});
