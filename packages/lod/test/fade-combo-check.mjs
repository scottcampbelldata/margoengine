// Real-GPU check of LODFade and OccluderFade on the same mesh, on WebGPU and then on the WebGL2 compatibility layer.
// Run from the repository root after `npm run build:packages`:
//   node scripts/run-with-timeout.mjs -- node packages/lod/test/fade-combo-check.mjs
//   MARGO_COMPAT=1 node packages/lod/test/fade-combo-check.mjs   (the compatibility layer only)
// A wall with two levels (red, then blue) stands between the camera and a green target. Every pixel of a 32 by 32
// block is compared with the two CPU tests: a pixel draws when the occluder fade keeps it AND the level's cross-fade
// keeps it (the two discards are independent, so the keep sets intersect). The levels' cross-fade values are t and -t,
// so the wall's kept pixels are exactly the occluder fade's, each from one level, and the target shows in the rest.
// Each fade is also checked alone, on core meshes, materials meshes (the model route) and Geometry levels.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';
import { fadeKeeps } from '../dist/fade.js';
import { occluderKeeps } from '../dist/occluder-fade.js';

process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));

/** The block read back: 32 by 32 pixels (four whole tiles) from (112, 112) of a 256 by 256 canvas. */
const AT = 112,
  SIDE = 32;
const noise = (x, y) => {
  const fract = (v) => v - Math.floor(v);
  return fract(52.9829189 * fract(x * 0.06711056 + y * 0.00583715));
};
// The cross-fade value sits in the middle of the widest gap between the block's noise values near one half, so no
// pixel's float32 noise on the GPU can land on the other side of it.
const sorted = [];
for (let y = 0; y < SIDE; y++) for (let x = 0; x < SIDE; x++) sorted.push(noise(AT + x, AT + y));
sorted.sort((a, b) => a - b);
let T = 0,
  gap = 0;
for (let i = 400; i < 624; i++)
  if (sorted[i + 1] - sorted[i] > gap) {
    gap = sorted[i + 1] - sorted[i];
    T = (sorted[i + 1] + sorted[i]) / 2;
  }
assert.ok(gap > 2e-3, `the cross-fade value needs a clear gap in the noise: ${gap}`);

/** The block's expected picture: `level(x, y)` names the level's colour where the wall draws at `opacity`. */
const picture = (opacity, level) => {
  let out = '';
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++) out += occluderKeeps(AT + x, AT + y, opacity) ? level(AT + x, AT + y) : 'g';
  return out;
};
/** Level 0 (red) leaving for level 1 (blue) at cross-fade value T, and the way back. */
const toBlue = (x, y) => (fadeKeeps(x, y, T) ? 'b' : 'r'),
  toRed = (x, y) => (fadeKeeps(x, y, T) ? 'r' : 'b');
const same = (got, want, label) => {
  let wrong = 0,
    first = '';
  for (let i = 0; i < want.length; i++)
    if (got[i] !== want[i] && !wrong++)
      first = `first at (${AT + (i % SIDE)}, ${AT + Math.floor(i / SIDE)}): '${got[i]}', expected '${want[i]}'`;
  assert.equal(wrong, 0, `${label}: ${wrong} of ${want.length} pixels differ; ${first}`);
};

const timer = setTimeout(() => {
  console.error('lod fade-combo-check: over its 4 minute limit');
  process.exit(1); // process.exit: the watchdog ends a run that is still going past its hard limit
}, 240_000);
try {
  for (const compat of compatRun() ? [true] : [false, true]) {
    const browser = await openBrowser({ port: 'free', compat }),
      { page } = browser,
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    const leg = compat ? 'compat' : 'webgpu';
    try {
      await page.waitForFunction(() => window.modern, null, { timeout: 30000 });
      const out = await page.evaluate(
        async ({ T, AT, SIDE }) => {
          const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
            { UnlitMaterial, createMesh } = await import('/packages/materials/dist/index.js'),
            { LODSystem } = await import('/packages/lod/dist/index.js'),
            { LODFade } = await import('/packages/lod/dist/fade.js'),
            { OccluderFade } = await import('/packages/lod/dist/occluder-fade.js');
          const size = 256,
            canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          canvas.style.cssText = `width:${size}px;height:${size}px;display:block`;
          document.body.prepend(canvas);
          const engine = await Engine.create(canvas, {
              backend: 'webgpu',
              camera: { position: [0, 0, 5], target: [0, 0, 0], fov: 60 },
            }),
            gpu = [];
          engine.stop();
          engine.gpu.addEventListener('uncapturederror', (e) => gpu.push(e.error.message));
          // The block, a letter per pixel: r, g or b for the colour that leads, ? for none.
          const grab = async () => {
            await (await import('/scripts/support/gpu-ready.js')).waitForPipelines(async () => {
              engine.render({ delta: 0 });
              await engine.gpu.queue.onSubmittedWorkDone();
            });
            engine.render({ delta: 0 });
            const copy = new OffscreenCanvas(size, size).getContext('2d', {
              willReadFrequently: true,
            });
            copy.drawImage(canvas, 0, 0);
            const d = copy.getImageData(AT, AT, SIDE, SIDE).data;
            let s = '';
            for (let i = 0; i < d.length; i += 4)
              s +=
                d[i] > d[i + 1] + 20 && d[i] > d[i + 2] + 20
                  ? 'r'
                  : d[i + 1] > d[i] + 20 && d[i + 1] > d[i + 2] + 20
                    ? 'g'
                    : d[i + 2] > d[i] + 20 && d[i + 2] > d[i + 1] + 20
                      ? 'b'
                      : '?';
            return s;
          };
          const red = [0.9, 0.02, 0.02],
            green = [0.02, 0.9, 0.02],
            blue = [0.02, 0.02, 0.9],
            solid = (color) => new PbrMaterial({ color, roughness: 1 });
          const target = engine
              .createMesh()
              .setGeometry(box(1, 1, 1))
              .setMaterial(solid(green)),
            // The levels switch 10 from the anchor, which is 5 from the camera: `bias` 4 shows level 1, 1 level 0.
            system = LODSystem.attach(engine),
            lods = LODFade.attach(engine, system, { duration: 1 }),
            occ = OccluderFade.attach(engine, {
              targets: [],
              fadeTime: 1,
              minOpacity: 0.25,
            });
          const to = (level) => {
            system.bias = level ? 4 : 1;
            system.update();
            const begun = lods.active;
            lods.onPreUpdate(T);
            return begun;
          };
          // One wall of two levels through every case; `hide` takes it out of the picture afterwards.
          const walk = async (lod, hide) => {
            const r = { solid: await grab() };
            // The cross-fade alone, there and back.
            r.begun = to(1);
            r.lodAlone = await grab();
            lods.onPreUpdate(10);
            r.lodEnd = await grab();
            to(0);
            r.lodBack = await grab();
            lods.onPreUpdate(10);
            // The occluder fade alone, at its end.
            occ.targets = [target];
            occ.update(10);
            r.occAlone = await grab();
            // Both: the faded wall switches level.
            to(1);
            r.both = await grab();
            r.active = occ.active;
            lods.onPreUpdate(10);
            r.bothEnd = await grab();
            // The view clears while the wall switches back: both levels return together.
            occ.targets = [];
            to(0);
            occ.update(0.5);
            r.returning = await grab();
            occ.update(10);
            r.returned = await grab();
            lods.onPreUpdate(10);
            // The wall starts to fade, switches level halfway, and both levels go on fading together.
            occ.targets = [target];
            occ.update(0.5);
            to(1);
            r.half = await grab();
            occ.update(0.25);
            r.later = await grab();
            lods.onPreUpdate(10);
            occ.targets = [];
            occ.update(10);
            r.left = [lods.active, occ.active];
            lod.remove();
            hide();
            system.bias = 1;
            return r;
          };
          const result = { gpu },
            anchor = engine.createMesh(),
            levels = (a, b) =>
              system.add(anchor, [{ object: a }, { object: b, distance: 10 }], {
                radius: 1,
              });
          // Core meshes.
          const wall = (color) =>
              engine
                .createMesh()
                .setGeometry(box(1.6, 1.6, 0.1))
                .setMaterial(solid(color))
                .setPosition([0, 0, 2]),
            a = wall(red),
            b = wall(blue);
          result.core = await walk(levels(a, b), () => (a.visible = b.visible = false));
          // Materials meshes: the model route.
          const h = 0.8,
            quad = {
              positions: [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0],
              normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
              indices: [0, 1, 2, 0, 2, 3],
            },
            pane = (color) => {
              const mesh = createMesh(engine, quad, new UnlitMaterial({ color }));
              mesh.root.setPosition([0, 0, 2]);
              return mesh;
            },
            m = pane([1, 0, 0]),
            n = pane([0, 0, 1]);
          const models = levels(m, n);
          lods.prepare(models);
          result.model = await walk(models, () => (m.root.visible = n.root.visible = false));
          // Geometry levels on one mesh: a ghost draws the old geometry in the mesh's own colour.
          const shape = engine.createMesh().setMaterial(solid(red)).setPosition([0, 0, 2]),
            geometries = system.add(
              shape,
              [{ object: box(1.6, 1.6, 0.1) }, { object: box(1.6, 1.6, 0.1), distance: 6 }],
              { radius: 1 },
            );
          system.update();
          const g = (result.geometry = { solid: await grab() });
          const swap = (level) => {
            system.bias = level ? 4 : 1;
            system.update();
            lods.onPreUpdate(T);
          };
          swap(1);
          g.lodAlone = await grab();
          lods.onPreUpdate(10);
          occ.targets = [target];
          occ.update(10);
          g.occAlone = await grab();
          swap(0);
          g.both = await grab();
          lods.onPreUpdate(10);
          g.bothEnd = await grab();
          // The view clears: the next switch is solid, ghost and mesh.
          occ.targets = [];
          occ.update(10);
          swap(1);
          g.reused = await grab();
          lods.onPreUpdate(10);
          geometries.remove();
          occ.dispose();
          lods.dispose();
          engine.dispose();
          return result;
        },
        { T, AT, SIDE },
      );
      assert.deepEqual(out.gpu, [], `${leg}: GPU errors`);
      const wallAt = (opacity, level) => picture(opacity, level),
        all = (letter) => wallAt(1, () => letter);
      for (const route of ['core', 'model']) {
        const r = out[route],
          at = `${leg} ${route}`;
        same(r.solid, all('r'), `${at}: the wall hides the target`);
        assert.equal(r.begun, 1, `${at}: the switch starts a cross-fade`);
        same(r.lodAlone, wallAt(1, toBlue), `${at}: the cross-fade alone, each pixel from one level`);
        same(r.lodEnd, all('b'), `${at}: the new level alone at the end`);
        same(r.lodBack, wallAt(1, toRed), `${at}: the cross-fade back`);
        same(
          r.occAlone,
          wallAt(0.25, () => 'r'),
          `${at}: the occluder fade alone`,
        );
        assert.equal(r.active, 2, `${at}: both levels are fading with the occluder fade`);
        same(r.both, wallAt(0.25, toBlue), `${at}: both fades, the target through every pixel the occluder fade drops`);
        same(
          r.bothEnd,
          wallAt(0.25, () => 'b'),
          `${at}: the new level keeps the occluder fade after the switch`,
        );
        same(r.returning, wallAt(0.625, toRed), `${at}: both levels fade back in together`);
        same(r.returned, wallAt(1, toRed), `${at}: and are solid again, still cross-fading`);
        same(r.half, wallAt(0.625, toBlue), `${at}: a level shown mid fade starts at the other's opacity`);
        same(r.later, wallAt(0.4375, toBlue), `${at}: and both go on fading together`);
        assert.deepEqual(r.left, [0, 0], `${at}: every fade ends`);
      }
      const g = out.geometry,
        at = `${leg} geometry`;
      same(g.solid, all('r'), `${at}: the wall hides the target`);
      same(g.lodAlone, all('r'), `${at}: the ghost and the mesh share every pixel, with no hole`);
      same(
        g.occAlone,
        wallAt(0.25, () => 'r'),
        `${at}: the occluder fade alone`,
      );
      same(
        g.both,
        wallAt(0.25, () => 'r'),
        `${at}: the ghost of a faded mesh is faded with it`,
      );
      same(
        g.bothEnd,
        wallAt(0.25, () => 'r'),
        `${at}: and the mesh stays faded at the end`,
      );
      same(g.reused, all('r'), `${at}: with the view clear the next switch is solid`);
      assert.deepEqual(errors, [], `${leg}: page errors`);
      console.log(`${leg}: 3 routes, ${SIDE * SIDE} pixels each, exact at cross-fade value ${T}`);
    } finally {
      await browser.close?.();
    }
  }
} finally {
  clearTimeout(timer);
}
