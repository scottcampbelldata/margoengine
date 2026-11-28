// Real-GPU check of SSR's march on a street seen from above, built packages (KB-POST-SSRSTREET1). A glossy road with
// white crossing stripes runs between raised kerbs with lamp posts and building fronts. Before the fix, rays reflected
// low over the road and kerbs spent their whole iteration budget re-testing Hi-Z cells they had already been sent down
// from, so neighbouring pixels flipped between a reflection and none (stair-stepped streaks), and rays passing a hair
// above a surface hit it from behind and copied the road above them (smeared stripes).
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-ssr-street',
  5376,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { PostStack } = await import('/packages/post/dist/stack.js'),
        { SSR } = await import('/packages/post/dist/ssr.js');
      const canvas = document.querySelector('canvas'),
        engine = await Engine.create(canvas, {
          backend: 'webgpu',
          camera: { position: [0, 7, 24], target: [0, 4, -80], near: 0.5, far: 400, fov: 54 },
        });
      engine.stop();
      const add = (size, position, color, roughness = 1, metalness = 0) =>
        engine
          .createMesh()
          .setGeometry(box(...size))
          .setPosition(position)
          .setMaterial(new PbrMaterial({ color, roughness, metalness }));
      add([20, 0.2, 240], [0, -0.1, -80], '#808080', 0.1, 1);
      for (const z of [8, -12, -40]) for (let x = -8; x <= 8; x += 2) add([1, 0.03, 3], [x, 0.015, z], '#ffffff');
      for (const side of [-1, 1]) {
        add([4, 0.3, 240], [side * 12, 0.15, -80], '#b8a890');
        for (let z = 20; z > -200; z -= 8) add([0.2, 6, 0.2], [side * 10.6, 3, z], '#d0d0d0');
        add([2, 30, 240], [side * 15, 15, -80], '#c8b49a');
      }
      const ssr = new SSR({ maxRoughness: 0.6, thickness: 1.35, maxDistance: 180 });
      PostStack.attach(engine, [ssr]);
      window.t = {
        draw: async (options) => {
          Object.assign(ssr.options, options);
          for (let i = 0; i < 2; i++) engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
        },
      };
    });
    const draw = async (options) => {
      await page.evaluate((o) => window.t.draw(o), options);
      return shot();
    };
    const off = await draw({ enabled: false }),
      reference = await draw({ enabled: true, steps: 256 }),
      lum = (image, x, y) => {
        const i = (y * image.width + x) * 4;
        return 0.2126 * image.data[i] + 0.7152 * image.data[i + 1] + 0.0722 * image.data[i + 2];
      },
      // Over the road and kerbs (rows 130 down): how far a frame is from the 256-step one, and how much that difference
      // jumps between neighbouring pixels (the streaks), both mean luminance steps out of 255.
      compare = (image) => {
        let far = 0,
          jumps = 0,
          n = 0;
        for (let y = 130; y < image.height; y++)
          for (let x = 0; x + 1 < image.width; x++) {
            const d = lum(image, x, y) - lum(reference, x, y);
            far += Math.abs(d);
            jumps += Math.abs(d - (lum(image, x + 1, y) - lum(reference, x + 1, y)));
            n++;
          }
        return { far: far / n, jumps: jumps / n };
      },
      reflected = compare(off),
      tight = compare(await draw({ steps: 28 })),
      standard = compare(await draw({ steps: undefined }));
    console.log(JSON.stringify({ reflected, tight, standard }));
    assert.ok(reflected.far > 8, `the road reflects the street: ${reflected.far}`);
    // Before the fix 28 steps left 3.1 (far) and 3.1 (jumps); now 1.2 and 1.4.
    assert.ok(tight.far < 2 && tight.jumps < 2, `28 steps finish nearly every ray: ${JSON.stringify(tight)}`);
    // The default budget (128) gives the 256-step frame.
    assert.ok(
      standard.far < 0.1 && standard.jumps < 0.1,
      `the default finishes every ray: ${JSON.stringify(standard)}`,
    );
  },
);
