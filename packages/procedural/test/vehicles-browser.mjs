// GPU check for the period vehicles (sheet row 14): a 2-8-0 and tender with a box car, a log car and a gondola on the
// track, a touring car, a kei truck and a vending machine, drawn through the stage facade on WebGPU or (MARGO_COMPAT=1)
// the WebGL2 compatibility layer. The frame must show vehicles across the frame and no GPU error; frames go to
// test-results/vehicles-browser/ for review.
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
    const V = await import('/packages/procedural/dist/vehicles.js');
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
      camera: { position: [-21, 6, 24], target: [-21, 1.5, 0], far: 600 },
      onError: (e) => errors.push(String(e?.message ?? e)),
    });
    const hex = (c) =>
      '#' +
      c
        .map((v) =>
          Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('');
    const place = (v, position) => {
      for (const [name, g] of Object.entries(v.parts))
        stage.mesh(toGeometry(g), {
          color: hex(v.palette[name].color),
          roughness: v.palette[name].roughness,
          metalness: v.palette[name].metalness,
          position,
        });
    };
    // The train: engine and tender, then cars coupled behind (each car's length over its couplers).
    const engine = V.generateLocomotive();
    place(engine, [0, 0, 0]);
    // The tender's rear coupler face: the length over the couplers back from the front one (the pilot's nose).
    let x = V.vehicleBounds(engine.parts).hi[0] - engine.length;
    for (const kind of ['boxcar', 'log-car', 'gondola']) {
      const car = V.generateWagon({ kind });
      x -= car.length / 2;
      place(car, [x, 0, 0]);
      x -= car.length / 2;
    }
    place(V.generateTouringCar(), [-34, 0, 7]);
    place(V.generateKeiTruck(), [-20, 0, 7]);
    place(V.generateVendingMachine(), [-8, 0, 8]);
    const views = [
      [
        [-21, 6, 24],
        [-21, 1.5, 0],
      ],
      [
        [8, 3, 8],
        [2, 2.2, 0],
      ],
      [
        [-30, 2.2, 12],
        [-34, 1, 7],
      ],
      [
        [-16, 2, 11.5],
        [-19, 1, 7],
      ],
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
  const dir = fileURLToPath(
    new URL(`../../../test-results/vehicles-browser${compatRun() ? '-compat' : ''}/`, import.meta.url),
  );
  await mkdir(dir, { recursive: true });
  await writeFile(dir + 'train.png', shot);
  for (let i = 1; i < 4; i++) {
    await browser.page.evaluate((v) => window.view(v), i);
    await writeFile(`${dir}near-${i}.png`, await browser.page.locator('canvas').screenshot());
  }
  const png = await decodePNG(shot);
  // Background is about (159, 180, 200): count pixels clearly off it, in each quarter of the frame width.
  const cols = new Array(4).fill(0);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = 4 * (y * png.width + x),
        d = Math.abs(png.data[i] - 159) + Math.abs(png.data[i + 1] - 180) + Math.abs(png.data[i + 2] - 200);
      if (d > 60) cols[Math.floor((x * 4) / png.width)]++;
    }
  for (const [i, n] of cols.entries()) assert.ok(n > 3000, `quarter ${i} of the frame shows ${n} vehicle pixels`);
  await browser.page.evaluate(() => window.fixture.dispose());
  console.log('Vehicles drawn', compatRun() ? '(WebGL2 compatibility layer)' : '(WebGPU)', cols);
} finally {
  await browser.close();
}
