import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transformWithOxc } from 'vite';
import { readmeEntries } from '../scripts/support/readme-types.mjs';
import { PhysicalCamera } from '../packages/cameras/dist/physical.js';

test('physical camera README shares one HDR capture and supplies stack depth to TAA', async () => {
  const example = readmeEntries(readFileSync('packages/cameras/README.md', 'utf8')).find(({ code }) =>
    code.includes('new PhysicalCamera('),
  );
  assert.ok(example);
  let standalone,
    stack,
    taa,
    starts = 0;
  const engine = {
    camera: { fov: 0 },
    start() {
      starts++;
      assert.ok(stack, 'a single stack captures all effects');
      assert.equal(taa.options.depth(), stack.depthTexture, 'TAA reads the stack depth');
      assert.equal(stack.effects[1].options.velocity(), taa.velocity);
    },
  };
  class Effect {
    constructor(options = {}) {
      this.options = options;
    }
    static attach(host, options) {
      assert.equal(host, engine);
      assert.equal(standalone, undefined, 'put HDR owners in the shared PostStack');
      return (standalone = new this(options));
    }
  }
  class DOF extends Effect {}
  class Tonemap extends Effect {}
  class MotionBlur extends Effect {}
  const globals = {
    document: { querySelector: () => ({}) },
    Engine: { create: async () => engine },
    DOF,
    Tonemap,
    MotionBlur,
    PhysicalCamera,
    TAA: {
      attach(host, options = {}) {
        assert.equal(host, engine);
        return (taa = { options, velocity: { texture: {} } });
      },
    },
    PostStack: {
      attach(host, effects) {
        assert.equal(host, engine);
        assert.equal(standalone, undefined, 'members are unattached before joining');
        assert.deepEqual(
          Array.from(effects, (e) => e.constructor.name),
          ['DOF', 'MotionBlur', 'Tonemap'],
        );
        return (stack = { effects, depthTexture: {} });
      },
    },
  };
  const source = example.code.replace(/^import[^\n]*\n/gm, '').replace(/^export \{\};\s*$/gm, '');
  const { code } = await transformWithOxc(source, 'physical-readme.ts', { target: 'es2022' });
  await runInNewContext(`(async()=>{${code}})()`, globals, { timeout: 5000 });
  assert.equal(starts, 1, 'the complete physical-camera picture is rendered');
  assert.equal(stack.effects[0].options.aperture, 5.6);
  assert.equal(stack.effects[0].options.focalDistance, 3);
  assert.equal(stack.effects[1].options.shutter, 0.5);
  assert.ok(Number.isFinite(stack.effects[2].options.exposure));
});
