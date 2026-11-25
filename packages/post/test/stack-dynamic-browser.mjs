// Real-GPU check (GAP-POST-ADD1): a PostStack changed after setup with addEffect, moveEffect and removeEffect draws
// the same frame, within 0 levels, as a PostStack constructed with the same final list. Three final lists mix HDR
// (Bloom, Anamorphic), display (Tonemap) and LDR (FXAA) effects; a device restore after the changes draws the same
// frame again. Run natively and with MARGO_COMPAT=1.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-stack-dynamic',
  5397,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { Bloom } = await import('/packages/post/dist/bloom.js'),
        { Anamorphic } = await import('/packages/post/dist/anamorphic.js'),
        { FXAA } = await import('/packages/post/dist/fxaa.js'),
        { Tonemap } = await import('/packages/tonemap/dist/index.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [3, 2, 5], target: [0, 0, 0] },
      });
      engine.stop();
      engine
        .createMesh()
        .setGeometry(box(2, 2, 2))
        .setMaterial(new PbrMaterial({ color: '#ffffff' }));
      const make = {
        bloom: () => new Bloom({ strength: 1, threshold: 0.3 }),
        anamorphic: () => new Anamorphic(),
        tonemap: () => new Tonemap(),
        fxaa: () => new FXAA(),
      };
      window.t = { engine, PostStack, make };
    });
    const frame = () =>
      page.evaluate(async () => {
        const { engine } = window.t;
        engine.render({ delta: 1 / 60 });
        await engine.gpu.queue.onSubmittedWorkDone();
      });
    // The same final list, constructed at once.
    const built = async (names) => {
      await page.evaluate((names) => {
        const t = window.t;
        t.built = t.PostStack.attach(
          t.engine,
          names.map((name) => t.make[name]()),
        );
      }, names);
      await frame();
      await frame();
      const image = await shot();
      await page.evaluate(() => window.t.built.dispose());
      return image;
    };
    const changed = async (step) => {
      await page.evaluate((step) => {
        const t = window.t;
        if (step === 'add') {
          t.effects = { tonemap: t.make.tonemap() };
          t.stack = t.PostStack.attach(t.engine, [t.effects.tonemap]);
        }
        const e = t.effects,
          s = t.stack;
        if (step === 'add') {
          s.addEffect((e.fxaa = t.make.fxaa()));
          s.addEffect((e.anamorphic = t.make.anamorphic()));
          s.addEffect((e.bloom = t.make.bloom()), 0);
        } else if (step === 'move') s.moveEffect(e.bloom, 1);
        else {
          s.removeEffect(e.anamorphic);
          s.removeEffect(e.fxaa);
        }
        return s.effects.map((effect) => effect.name);
      }, step);
      await frame();
      await frame();
      return shot();
    };
    const differ = (a, b) => {
      let worst = 0;
      for (let i = 0; i < a.data.length; i++) worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
      return worst;
    };
    const steps = [
        ['add', ['bloom', 'anamorphic', 'tonemap', 'fxaa']],
        ['move', ['anamorphic', 'bloom', 'tonemap', 'fxaa']],
        ['remove', ['bloom', 'tonemap']],
      ],
      images = [];
    for (const [step] of steps) images.push(await changed(step));
    const listed = await page.evaluate(() => window.t.stack.effects.map((effect) => effect.name));
    assert.deepEqual(listed, steps[2][1]);
    // A device restore after the changes draws the same frame as before it.
    const before = await shot();
    await page.evaluate(() => window.t.engine.rebootDevice());
    await frame();
    await frame();
    const after = await shot();
    await page.evaluate(() => window.t.stack.dispose());
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const [step, names] = steps[i],
        image = images[i];
      results.push({
        step,
        names,
        worst: differ(image, await built(names)),
        lit: image.data.some((v, j) => j % 4 === 0 && v > 200),
      });
    }
    await page.evaluate(() => window.t.engine.dispose());
    console.log(JSON.stringify({ results, restore: differ(before, after) }));
    for (const r of results) {
      assert.ok(r.lit, `${r.step}: the lit box is drawn`);
      assert.equal(r.worst, 0, `${r.step} (${r.names.join(', ')}) equals the constructed stack within 0 levels`);
    }
    assert.equal(differ(before, after), 0, 'the changed stack draws the same frame after a device restore');
  },
);
