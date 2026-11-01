import test from 'node:test';
import assert from 'node:assert/strict';
import { ContactShadows } from '@margoengine/post/contact-shadows';

test('ContactShadows checks its options and needs a stack', () => {
  for (const bad of [{ distance: 0 }, { thickness: -1 }, { strength: 2 }, { steps: 0 }, { steps: 65 }, { steps: 1.5 }])
    assert.throws(() => new ContactShadows(bad), RangeError);
  assert.throws(() => new ContactShadows({ enabled: 1 }), TypeError);
  assert.throws(() => new ContactShadows().setup({ gpu: {} }), /PostStack/);
  const effect = new ContactShadows();
  effect.dispose();
  effect.dispose();
  assert.throws(() => effect.setup({ gpu: {} }), /disposed/);
});
