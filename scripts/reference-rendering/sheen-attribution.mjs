// Attribution of the batch 160 sheen like-for-like residual (docs/limits.md, "Sample Viewer like for like").
// Black box: the Sample Viewer is measured only through its downloaded picture; no viewer source is read. Margo's own
// sheen albedo (packages/shared/sheen.js) is the KHR_materials_sheen and Enterprise PBR directional albedo, the
// cosine-weighted hemisphere integral of the sheen BRDF in linear light. This script renders the like-for-like picture
// as shipped and with that albedo replaced, for the base darkening only, by a black-box model of the viewer's
// lookup: E read at max(sheen roughness, floor) and passed through the sRGB encode. It prints the error per roughness
// row of the SheenTestGrid spheres. The model is a measurement aid; no Margo shader uses it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { engineBenchRoot } from '../support/engine-bench.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * WGSL rewrites, as [regex source, replacement] pairs, that turn shared/sheen.js's albedo function into the viewer
 * model: the lookup reads roughness max(r, floor) and returns sRGB_encode(E). `encode: false` keeps linear E.
 */
export function viewerAlbedoRules({ floor = 0, encode = true } = {}) {
  const rules = [
    [
      esc('let sheenR=clamp(roughness,0.0001,1.0);'),
      `let sheenQ=clamp(roughness,${floor.toFixed(4)},1.0);let sheenR=clamp(sheenQ,0.0001,1.0);`,
    ],
    [esc('let sheenV=sqrt(clamp(roughness,0.0,1.0))'), 'let sheenV=sqrt(clamp(sheenQ,0.0,1.0))'],
  ];
  if (encode)
    rules.push([
      esc('return clamp(exp(sheenLog)/sheenR,0.0,1.0);'),
      'let sheenE=clamp(exp(sheenLog)/sheenR,0.0,1.0);return select(sheenE*12.92,1.055*pow(sheenE,1.0/2.4)-0.055,sheenE>=0.0031308);',
    ]);
  return rules;
}

/** Applies [regex source, replacement] pairs to `code`; `hits` counts each rule's matches. */
export function rewrite(code, rules) {
  const hits = rules.map(([source]) => code.match(new RegExp(source, 'g'))?.length ?? 0);
  for (const [source, replacement] of rules) code = code.replace(new RegExp(source, 'g'), replacement);
  return { code, hits };
}

/**
 * Pixel centres of the 16 SheenTestGrid spheres at the batch 160 sheen camera (cases.mjs), rows by sheen roughness
 * 0, 0.33, 0.66, 1 and columns by sheen colour 0, 0.33, 0.66, 1: the sample's node translations projected through the
 * 35-degree camera at [-0.18, 0, 1.8].
 */
export function sheenSpheres({ width = 512, fov = 35, eye = [-0.18, 0, 1.8] } = {}) {
  const f = width / 2 / Math.tan((fov * Math.PI) / 360);
  const project = (x, y, z) => [
    width / 2 + ((x - eye[0]) / (eye[2] - z)) * f,
    width / 2 - ((y - eye[1]) / (eye[2] - z)) * f,
  ];
  return [0.22, 0.11, 0, -0.11].map((y, row) =>
    [-0.165, -0.055, 0.055, 0.165].map((x, column) => ({ row, column, centre: project(x, y, 0.0175) })),
  );
}

/** Absolute RGB error per roughness row over the spheres with sheen colour above 0 (radius `radius` px), and the rest. */
export function sheenRows(actual, reference, radius = 25) {
  const rows = [0, 0, 0, 0];
  let total = 0;
  const spheres = sheenSpheres({ width: actual.width }).flatMap((r) => r.filter((s) => s.column > 0));
  for (let y = 0; y < actual.height; y++)
    for (let x = 0; x < actual.width; x++) {
      const i = (y * actual.width + x) * 4;
      let d = 0;
      for (let c = 0; c < 3; c++) d += Math.abs(actual.data[i + c] - reference.data[i + c]);
      total += d;
      const s = spheres.find((s) => (x + 0.5 - s.centre[0]) ** 2 + (y + 0.5 - s.centre[1]) ** 2 < radius * radius);
      if (s) rows[s.row] += d;
    }
  return { rows, outside: total - rows.reduce((a, b) => a + b, 0), total };
}

async function main() {
  const { openBrowser } = await import('../browser.js');
  const { prepareScene } = await import('./scene.mjs');
  const { referenceCase } = await import('./cases.mjs');
  const { pictureError } = await import('./compare.mjs');
  const { decodePNG } = await import('../../tests/support/png.js');
  const { GAMMA_22, SRGB_ENCODE } = await import('./viewer-transfer.mjs');
  const root = join(engineBenchRoot(), 'batch-160');
  const entry = referenceCase('sheen');
  const settings = { ...entry.settings, exactSize: [entry.settings.width, entry.settings.height] };
  const scene = prepareScene(readFileSync(join(root, entry.model, entry.model + '.glb')), entry);
  const reference = await decodePNG(readFileSync(join(root, 'sheen', 'sample-viewer.png')));
  const floor = Number(process.argv.find((a) => a.startsWith('--floor='))?.slice(8) ?? 0.25);
  const variants = [
    ['as shipped (spec E, linear)', []],
    ['viewer model: sRGB-encoded E', viewerAlbedoRules()],
    [`viewer model: sRGB-encoded E, roughness floor ${floor}`, viewerAlbedoRules({ floor })],
  ];
  for (const [name, rules] of variants) {
    const context = await openBrowser({ startPath: '/scripts/reference-rendering/margo.html', port: 'free' });
    try {
      const { page } = context;
      await page.addInitScript(
        ({ rules }) => {
          const create = GPUDevice.prototype.createShaderModule;
          window.__hits = rules.map(() => 0);
          GPUDevice.prototype.createShaderModule = function (descriptor) {
            let code = descriptor.code;
            rules.forEach(([source, replacement], i) => {
              window.__hits[i] += code.match(new RegExp(source, 'g'))?.length ?? 0;
              code = code.replace(new RegExp(source, 'g'), replacement);
            });
            return create.call(this, { ...descriptor, code });
          };
        },
        { rules: [[SRGB_ENCODE, GAMMA_22], ...rules] },
      );
      await page.reload();
      await page.setViewportSize({ width: settings.width, height: settings.height });
      await page.waitForFunction(() => window.referenceMargo, null, { timeout: 30000 });
      await page.evaluate(({ bytes, settings }) => window.referenceMargo.render(bytes, { settings }), {
        bytes: Array.from(scene.bytes),
        settings,
      });
      const hits = await page.evaluate(() => window.__hits);
      if (hits.some((h) => h === 0)) throw new Error(`A rewrite did not reach the shaders: ${hits}`);
      const actual = await decodePNG(await page.locator('canvas').screenshot());
      const { absolute, mae, max } = pictureError(actual, reference);
      console.log(JSON.stringify({ name, absolute, mae, max, ...sheenRows(actual, reference) }));
    } finally {
      await context.close();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
