import test from 'node:test';
import assert from 'node:assert/strict';
import { Cinematic } from '../dist/index.js';

// Every cinematic error names its fix after a '; ' clause, so the message says what to do.
const fixes =
  (pattern, type = RangeError) =>
  (error) => {
    assert.ok(error instanceof type, `${error.name}: ${error.message}`);
    assert.match(error.message, pattern);
    assert.match(error.message, /;/, `${error.message} should name a fix after a ';'`);
    return true;
  };

test('camera rig argument errors say what to pass', () => {
  assert.throws(() => new Cinematic({ damping: 0 }), fixes(/damping/));
  assert.throws(() => new Cinematic({ offset: [0, 0, 0] }), fixes(/offset/));
  const rig = new Cinematic();
  assert.throws(() => rig.setOrbitOffset(0, 0, 0), fixes(/orbit/));
  assert.throws(() => rig.shake(-1, 1), fixes(/shake/));
  assert.throws(() => rig.update(-1), fixes(/delta/));
  assert.throws(() => new Cinematic({ ground: () => 0, clearance: -1 }), fixes(/clearance/));
});
