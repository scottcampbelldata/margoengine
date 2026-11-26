// Real-GPU check of MeshBlend, built packages, on WebGPU and (--compat) the WebGL2 layer:
//   node scripts/run-with-timeout.mjs -- node packages/post/test/mesh-blend-browser.mjs [--compat]
// A tagged red box and an untagged blue box sit sunk into green ground, seen from below the boxes' tops so their upper
// edges stand against a magenta sky. Against a frame with nothing tagged: the tagged box's seam with the ground softens
// (pixels change, and only into red-green mixes), the untagged box's seam keeps every pixel, the sky keeps every
// pixel, and the tagged box's own pixels next to the sky or in front of far ground stay put (a silhouette is
// rejected). Untagging restores the first frame.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';

await postBrowser(
  'post-mesh-blend' + (compatRun() ? '-compat' : ''),
  compatRun() ? 5447 : 5446,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { MeshBlend } = await import('/packages/post/dist/mesh-blend.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 0.45, 2.6], target: [0, 0.3, 0] },
      });
      engine.stop();
      engine.scene.background = '#ff00ff';
      engine.lighting.direction.set([0.3, 1, 0.6, 3]);
      const mat = (color) => new PbrMaterial({ color, roughness: 1 });
      engine
        .createMesh()
        .setGeometry(box(20, 0.1, 20))
        .setPosition([0, -0.05, 0])
        .setMaterial(mat('#30a030'));
      const rock = engine
        .createMesh()
        .setGeometry(box(0.7, 0.7, 0.7))
        .setPosition([-0.55, 0.25, 0])
        .setMaterial(mat('#d04020'));
      engine
        .createMesh()
        .setGeometry(box(0.7, 0.7, 0.7))
        .setPosition([0.55, 0.25, 0])
        .setMaterial(mat('#2040d0'));
      const blend = MeshBlend.attach(engine, { depthTolerance: 0.5 });
      window.t = {
        engine,
        blend,
        rock,
        frame: () => (engine.render({ delta: 1 / 60 }), engine.gpu.queue.onSubmittedWorkDone()),
      };
    });
    await page.evaluate(() => window.t.frame());
    const base = await shot();
    await page.evaluate(() => {
      window.t.blend.tag(window.t.rock, 0.15);
      return window.t.frame();
    });
    const blended = await shot();
    const { width, height, data } = base,
      px = (image, x, y) => {
        const i = 4 * (y * width + x);
        return [image.data[i], image.data[i + 1], image.data[i + 2]];
      },
      sky = (c) => c[0] > 200 && c[1] < 60 && c[2] > 200,
      red = (c) => c[0] > c[1] + 30 && c[0] > c[2] + 30 && !sky(c);
    let changed = 0,
      right = 0,
      skyChanged = 0,
      rimChanged = 0,
      mixes = 0,
      blue = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const a = px(base, x, y),
          b = px(blended, x, y),
          diff = Math.max(...a.map((v, i) => Math.abs(v - b[i])));
        if (diff <= 3) continue;
        changed++;
        if (x >= width / 2) right++;
        if (sky(a)) skyChanged++;
        if (b[2] > Math.max(b[0], b[1])) blue++;
        if (b[0] > 40 && b[1] > 40) mixes++;
        if (red(a)) {
          let near = false;
          for (let dy = -3; dy <= 3 && !near; dy++)
            for (let dx = -3; dx <= 3; dx++) {
              const q = [x + dx, y + dy];
              if (q[0] >= 0 && q[1] >= 0 && q[0] < width && q[1] < height && sky(px(base, q[0], q[1]))) near = true;
            }
          if (near) rimChanged++;
        }
      }
    // The tagged box's sides in front of far ground, above the contact band: a silhouette, so they stay put.
    const green = (c) => c[1] > c[0] + 30 && c[1] > c[2] + 30;
    let bottom = 0,
      horizon = 0,
      sideChanged = 0;
    while (sky(px(base, 4, horizon))) horizon++;
    for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) if (red(px(base, x, y))) bottom = y;
    for (let y = horizon; y < bottom - 20; y++)
      for (let x = 3; x < width / 2; x++)
        if (red(px(base, x, y)) && [-3, 3].some((dx) => green(px(base, x + dx, y)))) {
          const a = px(base, x, y),
            b = px(blended, x, y);
          if (Math.max(...a.map((v, i) => Math.abs(v - b[i]))) > 3) sideChanged++;
        }
    console.log(
      JSON.stringify({ compat: compatRun(), changed, right, skyChanged, rimChanged, sideChanged, mixes, blue, bottom }),
    );
    assert.ok(data.length === blended.data.length);
    assert.ok(changed >= 40, `the tagged seam softens: ${changed} pixels changed`);
    assert.equal(right, 0, 'the untagged box and its seam keep every pixel');
    assert.equal(skyChanged, 0, 'the sky keeps every pixel');
    assert.equal(rimChanged, 0, "the tagged box's pixels against the sky stay put");
    assert.ok(bottom - 20 > horizon, 'the box stands above the contact band in front of far ground');
    assert.equal(sideChanged, 0, "the tagged box's sides in front of far ground stay put");
    assert.equal(blue, 0, 'nothing blends toward the untagged box');
    assert.ok(mixes >= changed * 0.9, `changed pixels are red-green mixes: ${mixes} of ${changed}`);
    // Untagged again: the frame is the first one.
    await page.evaluate(() => {
      window.t.blend.untag(window.t.rock);
      return window.t.frame();
    });
    const again = await shot();
    let left = 0;
    for (let i = 0; i < data.length; i++) if (Math.abs(again.data[i] - data[i]) > 3) left++;
    assert.equal(left, 0, 'untagging restores the unblended frame');
    await page.evaluate(() => window.t.engine.dispose());
  },
  { seconds: 150 },
);
console.log('post mesh-blend: ok' + (compatRun() ? ' (WebGL2 layer)' : ''));
