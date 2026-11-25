// Real-GPU check of SurfaceCaustics (@margoengine/post/caustics), built packages: a 2 x 2 m refracting surface (index
// 1.333) 1 m over a grey floor, the sun straight down, the camera straight down from 5 m. The light added at each floor
// pixel over its colour without the effect is the flux reaching it. A flat surface sends every beam straight down
// unchanged: under it the floor gains 1 - Fresnel(0) = 0.980 of the sun (radiance 1, strength 1), and nothing past its
// edge. A rippled surface of the same footprint focuses the light into brighter lines and darker gaps but delivers the
// same total (the beams carry the flux the surface takes in, which for a height field is its footprint times the
// transmission, here within 1% of flat). Disabled, the effect passes the picture through bit for bit. MARGO_COMPAT=1
// runs it on the WebGL2 compatibility layer.
import assert from 'node:assert/strict';
import { launchBrowser } from '../../../scripts/lib/browser.mjs';
import { postBrowser } from './post-browser.mjs';

await postBrowser(
  'post-surface-caustics',
  5481,
  () => launchBrowser({ headless: true }),
  async (page, shot) => {
    await page.evaluate(async () => {
      const { Engine, PbrMaterial, box } = await import('/packages/core/dist/index.js'),
        { SurfaceCaustics } = await import('/packages/post/dist/caustics.js');
      const engine = await Engine.create(document.querySelector('canvas'), {
        backend: 'webgpu',
        camera: { position: [0, 5, 0], target: [0, 0, 0], fov: 60 },
      });
      engine.stop();
      engine.camera.up = [0, 0, -1];
      engine.lighting.direction.set([0, 1, 0, 1]);
      engine.lighting.radiance.set([1, 1, 1, 0]);
      engine
        .createMesh()
        .setGeometry(box(8, 0.2, 8))
        .setPosition([0, -0.1, 0])
        .setMaterial(new PbrMaterial({ color: '#808080', roughness: 1 }));
      // A 32 x 32 grid over x and z in -1..1 at height 1 + ripple(x, z), with its exact normals.
      const surface = (amplitude) => {
        const n = 32,
          positions = [],
          normals = [],
          indices = [],
          k = 3 * Math.PI;
        for (let j = 0; j <= n; j++)
          for (let i = 0; i <= n; i++) {
            const x = -1 + (2 * i) / n,
              z = -1 + (2 * j) / n;
            positions.push(x, 1 + amplitude * Math.sin(k * x) * Math.sin(k * z), z);
            const dx = amplitude * k * Math.cos(k * x) * Math.sin(k * z),
              dz = amplitude * k * Math.sin(k * x) * Math.cos(k * z);
            normals.push(-dx, 1, -dz);
          }
        for (let j = 0; j < n; j++)
          for (let i = 0; i < n; i++) {
            const a = j * (n + 1) + i;
            indices.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
          }
        return { positions, normals, indices };
      };
      const caustics = SurfaceCaustics.attach(engine, {
        geometry: surface(0),
        enabled: false,
        layers: 3,
        heightRange: [-0.5, 0.5],
      });
      window.t = {
        frame: async (options) => {
          if (options.amplitude !== undefined) caustics.setGeometry(surface(options.amplitude));
          caustics.options.enabled = options.enabled;
          engine.render({ delta: 1 / 60 });
          await engine.gpu.queue.onSubmittedWorkDone();
        },
        // Floor x, z under a pixel centre (the floor plane through a 60 degree lens, 5 m down).
        floor: (px, py) => {
          const t = Math.tan(Math.PI / 6) * 5;
          return [((px + 0.5) / 320 - 0.5) * 2 * t * (320 / 240), ((py + 0.5) / 240 - 0.5) * 2 * t];
        },
      };
    });
    const frame = async (options) => {
      await page.evaluate((o) => window.t.frame(o), options);
      return shot();
    };
    const off = await frame({ enabled: false }),
      again = await frame({ enabled: false }),
      flat = await frame({ enabled: true }),
      rippled = await frame({ enabled: true, amplitude: 0.03 });
    assert.deepEqual(off.data, again.data, 'two frames without the effect match');
    // Display bytes back to the tone mapper's input: the sRGB decode, then PBR Neutral's 0.04 offset (below 0.76).
    const linear = (b) => {
      const v = b / 255;
      return (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) + 0.04;
    };
    const floors = await page.evaluate(() =>
      Array.from({ length: 240 }, (_, y) => Array.from({ length: 320 }, (_, x) => window.t.floor(x, y))),
    );
    const added = (image) => {
      const out = [];
      for (let y = 0; y < 240; y++)
        for (let x = 0; x < 320; x++) {
          const k = (y * 320 + x) * 4,
            base = linear(off.data[k + 1]),
            lit = linear(image.data[k + 1]);
          assert.ok(lit < 0.76, `pixel ${x},${y} stays in the tone mapper's linear part: ${lit}`);
          out.push({ x, y, at: floors[y][x], flux: lit / base - 1 });
        }
      return out;
    };
    const under = (p, margin) => Math.abs(p.at[0]) < 1 - margin && Math.abs(p.at[1]) < 1 - margin,
      flatFlux = added(flat),
      inner = flatFlux.filter((p) => under(p, 0.1)),
      outer = flatFlux.filter((p) => !under(p, -0.1) && Math.abs(p.at[0]) < 2 && Math.abs(p.at[1]) < 2);
    const mean = (list) => list.reduce((s, p) => s + p.flux, 0) / list.length,
      transmission = 1 - ((1.333 - 1) / (1.333 + 1)) ** 2;
    console.log(
      `flat: ${mean(inner).toFixed(4)} under the surface (want ${transmission.toFixed(4)}), ${mean(outer).toFixed(4)} past it`,
    );
    for (const p of inner) assert.ok(Math.abs(p.flux - transmission) < 0.03, `flat flux at ${p.x},${p.y}: ${p.flux}`);
    for (const p of outer) assert.ok(Math.abs(p.flux) < 0.01, `no light past the surface at ${p.x},${p.y}: ${p.flux}`);
    const rippledFlux = added(rippled),
      total = (list) => list.filter((p) => under(p, -0.3)).reduce((s, p) => s + p.flux, 0),
      peak = Math.max(...rippledFlux.map((p) => p.flux)),
      ratio = total(rippledFlux) / total(flatFlux);
    console.log(`rippled: total ${ratio.toFixed(4)} of flat, peak ${peak.toFixed(3)}`);
    assert.ok(Math.abs(ratio - 1) < 0.03, `the ripples move light without making or losing it: ${ratio}`);
    assert.ok(peak > 1.5 * transmission, `the ripples focus light into bright lines: ${peak}`);
  },
);
console.log('surface caustics check passed');
