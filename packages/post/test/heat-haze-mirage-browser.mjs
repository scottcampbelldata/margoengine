// Real-GPU check of the hot ground of HeatHaze (@margoengine/post/heat-haze): the inferior mirage over a sunlit road.
// A dark 3 km ground under a pale sky, a red wall 2.5 km out, an eye 1 m up behind a narrow (4 degree) lens. Rays that
// leave the eye less steeply than the mirage edge acos(n_hot / n_air) (Hagen et al. 2026, equation 13) turn back up in
// the hot layer, so the ground just under the horizon shows the sky and the wall mirrored. The check measures the band's
// lower edge in pixels against the edge `inferiorMirageAngle` gives at 5 K and 20 K (within 1.5 px), finds the wall's
// mirror image below the horizon, leaves every pixel above the horizon and on a box in front alone, ripples with the
// eddies, and draws the frame of the effect off exactly at excess 0 and at strength 0. MARGO_COMPAT=1 or --compat runs it
// on the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { inferiorMirageAngle } from '../dist/heat-haze.js';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-heat-haze-mirage',
  5468,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { HeatHaze } = await import('/packages/post/dist/heat-haze.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 1, 0], target: [0, 1, -100], fov: 4, near: 0.1, far: 6000 },
      });
      engine.stop();
      engine.scene.background = '#9fc4f0';
      engine.lighting.direction.set([0.3, 0.8, 0.5, 2]);
      const ground = new PbrMaterial({ color: '#2a2a2a', roughness: 1 }),
        red = new PbrMaterial({ color: '#ff2010', roughness: 1 }),
        dark = new PbrMaterial({ color: '#101010', roughness: 1 });
      engine
        .createMesh()
        .setGeometry(box(600, 0.1, 3000))
        .setPosition([0, -0.05, -1500])
        .setMaterial(ground);
      engine
        .createMesh()
        .setGeometry(box(600, 6, 1))
        .setPosition([0, 3, -2500])
        .setMaterial(red);
      // A box in front of the hot layer's reach, low on the right.
      engine
        .createMesh()
        .setGeometry(box(0.3, 0.3, 0.3))
        .setPosition([0.35, 0.55, -20])
        .setMaterial(dark);
      const layer = { excess: 0, depth: 0.02, fluctuation: 0, time: 0 },
        haze = HeatHaze.attach(engine, { ground: layer });
      window.t = {
        engine,
        haze,
        layer,
        frame: () => (engine.render({ delta: 0 }), engine.gpu.queue.onSubmittedWorkDone()),
        project: (p) => {
          const m = engine.camera.matrix,
            c = [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
          return [((c[0] / c[3]) * 0.5 + 0.5) * 320, (0.5 - (c[1] / c[3]) * 0.5) * 240];
        },
      };
    });
    const t = (fn, arg) => page.evaluate(fn, arg);
    const frame = async (o) => {
      await t((o) => {
        Object.assign(window.t.haze.options, o.haze ?? {});
        Object.assign(window.t.layer, o.layer ?? {});
        return window.t.frame();
      }, o);
      return shot();
    };
    const px = (img, x, y) => {
      const i = 4 * (y * img.width + x);
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    const isGround = (c) => Math.max(...c) < 90 && Math.abs(c[0] - c[2]) < 20;
    const isRed = (c) => c[0] > 120 && c[0] > 2 * c[2];
    // The lowest row of the centre columns that does not show the ground: the mirage band's lower edge.
    const edge = (img) => {
      let lowest = -1;
      for (const x of [150, 160, 170])
        for (let y = 0; y < img.height; y++) if (!isGround(px(img, x, y))) lowest = Math.max(lowest, y);
      return lowest + 1;
    };
    const diff = (a, b, inside = () => true) => {
      let n = 0;
      for (let y = 0; y < a.height; y++)
        for (let x = 0; x < a.width; x++) {
          if (!inside(x, y)) continue;
          const i = 4 * (y * a.width + x);
          if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++;
        }
      return n;
    };
    const off = await frame({ haze: { enabled: false } }),
      none = await frame({ haze: { enabled: true }, layer: { excess: 0 } }),
      weak = await frame({ layer: { excess: 5 } }),
      hot = await frame({ layer: { excess: 20 } }),
      zero = await frame({ haze: { strength: 0 } }),
      moving = await frame({ haze: { strength: 1 }, layer: { fluctuation: 0.3, time: 0 } }),
      later = await frame({ layer: { time: 0.7 } });
    const rowOf = (angle) => t((a) => window.t.project([0, 1 - Math.tan(a) * 1000, -1000])[1], angle);
    const horizon = await rowOf(0),
      [boxA, boxB] = [
        await t(() => window.t.project([0.2, 0.7, -20])),
        await t(() => window.t.project([0.5, 0.4, -20])),
      ],
      onBox = (x, y) => x > boxA[0] + 1 && x < boxB[0] - 1 && y > boxA[1] + 1 && y < boxB[1] - 1,
      above = (_x, y) => y < horizon - 2;
    let redBelow = 0,
      redBelowOff = 0;
    for (let y = Math.ceil(horizon + 2); y < 240; y++)
      for (let x = 0; x < 320; x++) {
        if (isRed(px(hot, x, y))) redBelow++;
        if (isRed(px(off, x, y))) redBelowOff++;
      }
    const result = {
      compat: compatRun(),
      horizon,
      edgeOff: edge(off),
      edge5: edge(weak),
      want5: await rowOf(inferiorMirageAngle(5, { eye: 1, depth: 0.02 })),
      edge20: edge(hot),
      want20: await rowOf(inferiorMirageAngle(20, { eye: 1, depth: 0.02 })),
      redBelow,
      redBelowOff,
      none: diff(off, none),
      zero: diff(off, zero),
      aboveChanged: diff(off, hot, above),
      boxPixels: diff(off, off, onBox) === 0 ? (boxB[0] - boxA[0] - 2) * (boxB[1] - boxA[1] - 2) : -1,
      boxChanged: diff(off, hot, onBox),
      ripple: diff(moving, later),
      rippleAbove: diff(moving, later, above),
    };
    console.log(JSON.stringify(result));
    if (process.env.MIRAGE_DEBUG)
      for (let y = 110; y < 145; y++) console.log(y, px(off, 160, y).join(','), px(hot, 160, y).join(','));
    assert.equal(result.none, 0, 'no excess draws the frame of the effect off');
    assert.equal(result.zero, 0, 'strength 0 draws the frame of the effect off');
    assert.ok(
      result.edgeOff <= Math.ceil(horizon) + 3,
      `without heat the ground meets the sky at its far edge, 1.2 px under the horizon: ${result.edgeOff}`,
    );
    assert.ok(
      Math.abs(result.edge5 - result.want5) <= 1.5,
      `5 K mirage edge ${result.edge5} px against ${result.want5}`,
    );
    assert.ok(
      Math.abs(result.edge20 - result.want20) <= 1.5,
      `20 K mirage edge ${result.edge20} px against ${result.want20}`,
    );
    assert.ok(
      result.edge20 - horizon > 15,
      `the 20 K band is ${result.edge20 - horizon} px tall through a 4 degree lens`,
    );
    assert.ok(result.redBelow > 200, `the far wall shows mirrored under the horizon: ${result.redBelow} pixels`);
    assert.equal(result.redBelowOff, 0, 'without heat nothing red lies under the horizon');
    assert.equal(result.aboveChanged, 0, 'nothing above the horizon moves');
    assert.ok(result.boxPixels > 4, `the box in front is in view: ${result.boxPixels} pixels`);
    assert.equal(result.boxChanged, 0, 'the box in front of the hot layer keeps every pixel');
    assert.ok(result.ripple > 100, `the layer's eddies make the band shimmer: ${result.ripple} pixels`);
    assert.equal(result.rippleAbove, 0, 'the shimmer stays under the horizon');
    await t(() => window.t.engine.dispose());
  },
);
