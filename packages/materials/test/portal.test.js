import test from 'node:test';
import assert from 'node:assert/strict';
import { Material } from '../dist/index.js';
import { Portals } from '../dist/portal.js';

// A stand-in engine that already holds a stencil buffer, and stand-in meshes: the portal logic edits only the
// meshes' materials and render order, which these carry.
const engine = () => ({ plugins: new Map([['materials:stencil-buffer', {}]]) });
const mesh = (options = {}) => ({ material: new Material(options), renderOrder: 0 });
const help = (e) => /errors#materials-portal/.test(e.message);

test('a mask writes its own reference and its contents test it; inverse flips the test; remove restores', () => {
  const portals = new Portals(engine()),
    mask = mesh(),
    inside = mesh({ color: '#ff0000' }),
    other = mesh(),
    a = portals.add({ mask, contents: [inside] }),
    b = portals.add({ mask: [other] });
  assert.deepEqual([a.ref, b.ref], [1, 2]);
  const m = mask.material,
    c = inside.material;
  assert.deepEqual(
    [m.colorWrite, m.depthWrite, m.stencilWrite, m.stencilRef, m.stencilFunc, m.stencilZPass],
    [false, false, true, 1, 'always', 'replace'],
  );
  assert.deepEqual([c.stencilWrite, c.stencilRef, c.stencilFunc, c.stencilWriteMask], [true, 1, 'equal', 0]);
  assert.ok(inside.renderOrder > mask.renderOrder && mask.renderOrder > 0, 'mask after opaque, contents after mask');
  assert.equal(other.material.stencilRef, 2);
  a.inverse = true;
  assert.equal(c.stencilFunc, 'not-equal');
  assert.throws(() => (a.inverse = 1), TypeError);
  a.remove();
  a.remove();
  assert.deepEqual(
    [m.colorWrite, m.depthWrite, m.stencilWrite, m.stencilRef, m.stencilFunc, m.stencilZPass, mask.renderOrder],
    [true, undefined, false, 0, 'always', 'keep', 0],
  );
  assert.deepEqual([c.stencilWrite, c.stencilFunc, c.stencilWriteMask, inside.renderOrder], [false, 'always', 255, 0]);
  assert.deepEqual(portals.portals, [b]);
  assert.equal(portals.add({ mask }).ref, 1, 'a freed reference is handed out again');
  portals[Symbol.dispose]();
  assert.equal(other.material.stencilWrite, false);
  assert.throws(
    () => portals.add({ mask: mesh() }),
    (e) => e.code === 'disposed' && help(e),
  );
});

test('references run out with a coded error; bad masks, shared materials and ranges are refused', () => {
  const portals = new Portals(engine(), { first: 7, last: 8 });
  assert.equal(portals.add({ mask: mesh() }).ref, 7);
  assert.equal(portals.add({ mask: mesh() }).ref, 8);
  assert.throws(
    () => portals.add({ mask: mesh() }),
    (e) => e.code === 'state' && /7-8 are all in use/.test(e.message) && help(e),
  );
  const shared = mesh();
  assert.throws(
    () => new Portals(engine()).add({ mask: shared, contents: [{ ...shared }] }),
    (e) => e.code === 'state',
  );
  assert.throws(() => portals.add({ mask: [] }), TypeError);
  assert.throws(() => portals.add({ mask: {} }), TypeError);
  assert.throws(() => portals.add({ mask: mesh(), scene: {}, contents: [mesh()] }), TypeError);
  for (const options of [{ first: 0 }, { last: 256 }, { first: 5, last: 4 }, { first: 1.5 }])
    assert.throws(
      () => new Portals(engine(), options),
      (e) => e instanceof RangeError && help(e),
    );
  assert.throws(() => portals.render(-1), RangeError);
  portals.dispose();
});
