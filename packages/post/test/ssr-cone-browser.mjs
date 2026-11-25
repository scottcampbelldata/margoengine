// Real-GPU check of SSR's roughness cone with contact hardening, built packages. Three thin white posts stand on a
// metal floor. The contrast of each post's reflection is measured just below its foot and below its top on the canvas,
// for a near-mirror floor (roughness 0.02) and a glossy one (0.3): the glossy floor keeps most of the contrast at the
// foot (the cone is narrow near the contact) and loses most of it at the top (the cone's footprint grows with the world
// distance to the hit). Until 2026-11-25 the footprint came from the ray's on-screen length, which kept the far end of
// these reflections sharp.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-ssr-cone',
  5374,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    const points = await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { SSR } = await import('/packages/post/dist/ssr.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 2.5, 9], target: [0, -0.4, 0], near: 0.1, far: 100 },
        });
      engine.stop();
      const floor = engine
        .createMesh()
        .setGeometry(box(20, 0.2, 20))
        .setPosition([0, -0.1, 0])
        .setMaterial(new PbrMaterial({ color: '#c0c0c0', roughness: 0.02, metalness: 1 }));
      for (const x of [-1.5, 0, 1.5])
        engine
          .createMesh()
          .setGeometry(box(0.15, 2, 0.15))
          .setPosition([x, 1, 0])
          .setMaterial(new PbrMaterial({ color: '#ffffff', roughness: 1 }));
      PostStack.attach(engine, [new SSR({ maxRoughness: 1 })]);
      window.t = {
        rough: async (roughness) => {
          floor.setMaterial(new PbrMaterial({ color: '#c0c0c0', roughness, metalness: 1 }));
          for (let i = 0; i < 2; i++) engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
        },
      };
      engine.render({ delta: 0 });
      const m = engine.camera.matrix,
        project = (p) => {
          const c = [0, 1, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
          return [((c[0] / c[2]) * 0.5 + 0.5) * canvas.width, (0.5 - (c[1] / c[2]) * 0.5) * canvas.height];
        };
      return [-1.5, 0, 1.5].map((x) => ({ foot: project([x, -0.08, 0]), top: project([x, -1.5, 0]) }));
    });
    const contrast = (image, [cx, cy]) => {
      const y = Math.round(cy),
        row = [];
      for (let x = Math.round(cx) - 24; x <= Math.round(cx) + 24; x++) {
        const i = (y * image.width + x) * 4;
        row.push(0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2]);
      }
      return Math.max(...row) - Math.min(...row);
    };
    const measure = async (roughness) => {
      await page.evaluate((r) => window.t.rough(r), roughness);
      const image = await shot(),
        at = (key) => points.reduce((sum, p) => sum + contrast(image, p[key]), 0) / points.length;
      return { foot: at('foot'), top: at('top') };
    };
    const mirror = await measure(0.02),
      glossy = await measure(0.3),
      foot = glossy.foot / mirror.foot,
      top = glossy.top / mirror.top;
    console.log(JSON.stringify({ mirror, glossy, foot, top }));
    assert.ok(mirror.foot > 8 && mirror.top > 8, 'the mirror floor reflects the posts');
    assert.ok(foot > 0.55, `the contact stays sharp: ${foot}`);
    assert.ok(top < 0.25, `the far end blurs: ${top}`);
    assert.ok(top < foot * 0.6, `blur grows with distance from the floor: ${foot} to ${top}`);
  },
);
