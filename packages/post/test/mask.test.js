import test from 'node:test';
import assert from 'node:assert/strict';
import { EffectMask } from '@margoengine/post/mask';
import { Bloom } from '@margoengine/post/bloom';
import { SSAO } from '@margoengine/post/ssao';
import { Blur } from '@margoengine/post/blur';
import { Lens } from '@margoengine/post/lens';
import { harness, modules } from './support.js';

for (const [name, make] of [
  ['Bloom', () => new Bloom()],
  ['SSAO', () => new SSAO()],
  ['Blur', () => new Blur()],
  ['Lens', () => new Lens()],
]) {
  test(`EffectMask wraps ${name}, shares scene depth and restores/releases both resource owners`, async () => {
    const h = harness(),
      mask = h.gpu.device.createTexture({ size: [8, 8], format: 'rgba8unorm', usage: 4 });
    const inner = make(),
      effect = EffectMask.attach(h.engine, inner, { mask: () => mask, inverted: true, opacity: 0.5 });
    const log = h.gpu.record(() => h.frame());
    assert.ok(modules(log).some((s) => s.includes('return mix(s,e,w*u.z)')));
    assert.ok(h.engine.hasPlugin(inner.name));
    h.engine.restore();
    h.frame();
    inner.dispose();
    h.frame();
    effect.dispose();
    await null;
    assert.equal(h.engine.hasPlugin(inner.name), false);
    assert.deepEqual(
      h.live().filter((r) => r !== mask),
      [],
    );
    mask.destroy();
  });
}
test('EffectMask invokes custom effects with the shared host and validates options', () => {
  const h = harness();
  let host,
    called = 0;
  const custom = {
    name: 'custom-mask-test',
    setup() {},
    joinStack(value) {
      host = value;
      return {
        kind: 'ldr',
        render(_c, input) {
          called++;
          assert.ok(host.depthTexture);
          return input;
        },
      };
    },
  };
  EffectMask.attach(h.engine, custom, { mask: () => undefined });
  h.frame();
  assert.equal(called, 1);
  h.engine.removePlugin('post:stack');
  for (const o of [
    { mask: 1 },
    { mask: () => undefined, inverted: 1 },
    { mask: () => undefined, maskId: NaN },
    { mask: () => undefined, opacity: 2 },
  ])
    assert.throws(() => new EffectMask(new Bloom(), o));
  assert.throws(() => new EffectMask({ name: 'not-a-stack-effect' }, { mask: () => undefined }), TypeError);
});
