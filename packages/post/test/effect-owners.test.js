import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { engine } from '../../../tests/support/review56-engine.js';
import * as post from '../dist/index.js';
import { Blur } from '../dist/blur.js';
import { Lens } from '../dist/lens.js';
import { Anamorphic } from '../dist/anamorphic.js';
import { ContactShadows } from '../dist/contact-shadows.js';
import { SSS } from '../dist/sss.js';
import { Outline } from '../dist/outline.js';
import { Decals } from '../dist/decals.js';
import { MaterialDecals } from '../dist/material-decals.js';
import { SceneTargets } from '../dist/mrt.js';
import { DepthTexture } from '../dist/depth.js';

const types = {
  Bloom: post.Bloom,
  SSAO: post.SSAO,
  GTAO: post.GTAO,
  SSR: post.SSR,
  SSGI: post.SSGI,
  SMAA: post.SMAA,
  Glitch: post.Glitch,
  Afterimage: post.Afterimage,
  LensFlare: post.LensFlare,
  MotionBlur: post.MotionBlur,
  ImagePost: post.ImagePost,
  SceneFade: post.SceneFade,
  Blur,
  Lens,
  Anamorphic,
  ContactShadows,
  SSS,
  Outline,
  Decals,
  MaterialDecals,
  SceneTargets,
  DepthTexture,
};

test('post cleanup never removes a plugin through the active-scene engine facade', () => {
  const folder = new URL('../src/', import.meta.url);
  for (const file of readdirSync(folder))
    if (file.endsWith('.ts'))
      assert.doesNotMatch(readFileSync(new URL(file, folder), 'utf8'), /\bengine\??\.removePlugin\(/, file);
});
for (const [name, Type] of Object.entries(types))
  for (const remove of [false, true])
    test(`${name} ${remove ? 'owner removal' : 'direct disposal'} preserves other scenes`, async (t) => {
      const e = await engine(t),
        owner = e.createScene('post-effect-owner');
      e.gpu.createComputePipeline = () => ({ getBindGroupLayout: () => ({}) });
      e.canvas.getContext('webgpu').getConfiguration = () => ({
        device: e.gpu,
        format: 'bgra8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      const make = () =>
        new Type(
          Type === post.MotionBlur
            ? { velocity: () => undefined }
            : Type === SceneTargets
              ? { outputs: { base: 'albedo' } }
              : undefined,
        );
      const primary = make(),
        effect = make();
      const attach = (scene, child) =>
        scene.use(typeof child.joinStack === 'function' ? new post.PostStack([child]) : child);
      attach(e, primary);
      attach(owner, effect);
      if (remove) owner.removePlugin(effect.name);
      else effect.dispose();
      effect.dispose();
      assert.equal(e.sceneOf(effect) === undefined, true, 'effect remains registered');
      assert.equal(owner.plugins.has(effect.name), false);
      assert.equal(e.scene.plugins.get(primary.name) === primary, true, 'default effect was removed');
      owner.removePlugin('post:stack');
      assert.equal(owner.plugins.size, 0, 'owned helper effects remain registered');
      const replacement = make();
      attach(owner, replacement);
      replacement.dispose();
      owner.removePlugin('post:stack');
      assert.equal(owner.plugins.size, 0);
    });
