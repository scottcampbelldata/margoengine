// GPU check for joined plans (sheet row 14): L, T, U and cross plans with dormers and a corner tower, and rooms seen
// through the windows, drawn through the stage facade on WebGPU or (MARGO_COMPAT=1) the WebGL2 compatibility layer. The
// frame must show every building across the street and no GPU error; frames go to test-results/building-plans-browser/.
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { compatRun } from '../../../scripts/support/compat-shim.js';

// The dev server serves the working directory: run from the repository root whichever folder started the test.
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const browser = await openBrowser({ startPath: '/tests/fog-all.html', port: 'free' });
try {
  const result = await browser.page.evaluate(async () => {
    const { createStage } = await import('/packages/stage/dist/index.js');
    const { toGeometry } = await import('/packages/geometry/dist/utils.js');
    const { generateBuildingPlan } = await import('/packages/procedural/dist/building-plans.js');
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 540;
    canvas.style.width = '960px';
    canvas.style.height = '540px';
    document.body.replaceChildren(canvas);
    const errors = [];
    const stage = await createStage(canvas, {
      autoStart: false,
      controls: false,
      background: '#9fb4c8',
      exactSize: [960, 540],
      capacity: 4096,
      camera: { position: [24, 22, 52], target: [24, 4, 0], far: 600 },
      onError: (e) => errors.push(String(e?.message ?? e)),
    });
    const hex = (c) =>
      '#' + c.map((v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)).toString(16).padStart(2, '0')).join('');
    const add = (g, m) => stage.mesh(toGeometry(g), { color: hex(m.color), roughness: m.roughness, metalness: m.metalness });
    const plans = [
      { style: 'western-1910-house', plan: 'L', ridge: 'x', width: 11, depth: 8, dormers: 2, tower: 'front-right' },
      { style: 'japan-2011-house', plan: 'T' },
      { style: 'western-1910-depot', plan: 'U', detail: 'far' },
      { style: 'western-1910-house', plan: 'cross', ridge: 'x', width: 10, depth: 7.5, dormers: 1, dormerKind: 'hip', detail: 'near' },
    ];
    let x = -12;
    for (const p of plans) {
      const b = generateBuildingPlan({ ...p, origin: [x, 0, 0] });
      for (const [name, g] of Object.entries(b.parts)) add(g, b.palette[name]);
      const span = Math.max(...b.blocks.flatMap((k) => k.footprint.map((q) => q[0]))) - x;
      x += span + 20;
    }
    const views = [
      [[24, 22, 52], [24, 4, 0]],
      [[2, 7, 14], [-2, 4, 0]],
      [[60, 5, 16], [56, 4, 0]],
    ];
    window.view = async (i) => {
      stage.engine.camera.position = views[i][0];
      stage.engine.camera.target = views[i][1];
      await stage.engine.render({ delta: 0 });
      await stage.engine.render({ delta: 0 });
    };
    await window.view(0);
    window.fixture = stage;
    return { errors };
  });
  assert.deepEqual(result.errors, []);
  const shot = await browser.page.locator('canvas').screenshot();
  const dir = fileURLToPath(new URL(`../../../test-results/building-plans-browser${compatRun() ? '-compat' : ''}/`, import.meta.url));
  await mkdir(dir, { recursive: true });
  await writeFile(dir + 'street.png', shot);
  for (let i = 1; i < 3; i++) {
    await browser.page.evaluate((v) => window.view(v), i);
    await writeFile(`${dir}near-${i}.png`, await browser.page.locator('canvas').screenshot());
  }
  const png = await decodePNG(shot);
  // Background is about (159, 180, 200): count pixels clearly off it in each quarter of the frame width.
  const cols = new Array(4).fill(0);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = 4 * (y * png.width + x),
        d = Math.abs(png.data[i] - 159) + Math.abs(png.data[i + 1] - 180) + Math.abs(png.data[i + 2] - 200);
      if (d > 60) cols[Math.floor((x * 4) / png.width)]++;
    }
  for (const [i, n] of cols.entries()) assert.ok(n > 3000, `quarter ${i} of the frame shows ${n} building pixels`);
  await browser.page.evaluate(() => window.fixture.dispose());
  console.log('Joined plans drawn', compatRun() ? '(WebGL2 compatibility layer)' : '(WebGPU)', cols);
} finally {
  await browser.close();
}
