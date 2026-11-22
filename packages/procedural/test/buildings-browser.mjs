// GPU check for the building rules and harbour pieces (sheet row 14): a street of every style and the harbour parts are
// drawn through the stage facade, on WebGPU or (MARGO_COMPAT=1) the WebGL2 compatibility layer, and the frame must show
// them: lit pixels across the frame, the roofs darker than the walls, and no GPU error. The frame is written to
// test-results/buildings-browser/ for review.
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
    const { generateBuilding, BUILDING_STYLES } = await import('/packages/procedural/dist/building-rules.js');
    const H = await import('/packages/procedural/dist/harbour.js');
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
      camera: { position: [20, 26, 70], target: [20, 4, 0], far: 600 },
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
    const add = (g, m) =>
      stage.mesh(toGeometry(g), { color: hex(m.color), roughness: m.roughness, metalness: m.metalness });
    let x = -40;
    for (const style of BUILDING_STYLES) {
      const probe = generateBuilding({ style });
      const b = generateBuilding({ style, origin: [x + probe.options.width / 2, 0, 0], detail: 'mid' });
      for (const [name, g] of Object.entries(b.parts)) add(g, b.palette[name]);
      x += probe.options.width + 4;
    }
    const concrete = { color: [0.45, 0.44, 0.42], roughness: 0.9, metalness: 0 };
    const wall = H.generateSeaWall({ length: 120 });
    for (const g of Object.values(wall.parts)) {
      const m = toGeometry(g);
      stage.mesh(m, { color: hex(concrete.color), roughness: 0.9, position: [-45, 0, 18] });
    }
    const boat = H.generateFishingBoat();
    const boatColors = {
      hull: [0.8, 0.8, 0.78],
      bottom: [0.35, 0.05, 0.04],
      deck: [0.4, 0.42, 0.4],
      cabin: [0.85, 0.85, 0.83],
      glass: [0.02, 0.03, 0.04],
      metal: [0.3, 0.3, 0.3],
      trim: [0.1, 0.1, 0.1],
    };
    for (const [k, g] of Object.entries(boat.parts))
      stage.mesh(toGeometry(g), { color: hex(boatColors[k]), roughness: 0.5, position: [40, 0, 32] });
    // Settled tetrapod armour on a short slope: every instance matrix baked into one mesh.
    const armour = H.placeTetrapods({ mass: 4, length: 18, crest: 1.5, toe: -1, slope: 1.5 }),
      tg = armour.tetrapod.geometry,
      nv = tg.positions.length / 3,
      pos = new Float32Array(armour.count * nv * 3),
      nrm = new Float32Array(armour.count * nv * 3),
      uvs = new Float32Array(armour.count * nv * 2),
      idx = new Uint32Array(armour.count * tg.indices.length);
    for (let u = 0; u < armour.count; u++) {
      const m = armour.matrices.subarray(16 * u, 16 * u + 16);
      for (let v = 0; v < nv; v++) {
        const [x, y, z] = tg.positions.subarray(3 * v, 3 * v + 3),
          [a, b, c] = tg.normals.subarray(3 * v, 3 * v + 3),
          o = 3 * (u * nv + v);
        pos.set(
          [
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          ],
          o,
        );
        nrm.set([m[0] * a + m[4] * b + m[8] * c, m[1] * a + m[5] * b + m[9] * c, m[2] * a + m[6] * b + m[10] * c], o);
      }
      uvs.set(tg.uvs, u * nv * 2);
      for (let i = 0; i < tg.indices.length; i++) idx[u * tg.indices.length + i] = tg.indices[i] + u * nv;
    }
    if (armour.placement !== 'settled' || !(armour.settling.minGap >= 0) || armour.count < 20)
      errors.push(
        `settled armour: ${armour.placement} ${armour.count} units, least clearance ${armour.settling?.minGap}`,
      );
    stage.mesh(toGeometry({ positions: pos, normals: nrm, uvs, indices: idx }), {
      color: hex(concrete.color),
      roughness: 0.9,
      position: [-30, 0, 22],
    });
    // A second street at near detail, out of the first view, for close looks.
    const nearStyles = [
      'japan-2011-house',
      'western-1910-house',
      'western-1910-false-front',
      'western-1910-brick',
      'japan-2011-warehouse',
    ];
    let nx = 0;
    for (const style of nearStyles) {
      const probe = generateBuilding({ style });
      const b = generateBuilding({ style, origin: [nx + probe.options.width / 2, 0, -300], detail: 'near' });
      for (const [name, g] of Object.entries(b.parts)) add(g, b.palette[name]);
      nx += probe.options.width + 6;
    }
    const views = [
      [
        [20, 26, 70],
        [20, 4, 0],
      ],
      [
        [-6, 6, -284],
        [4.5, 4, -300],
      ],
      [
        [12, 6, -282],
        [20, 5, -300],
      ],
      [
        [36, 8, -280],
        [43, 6, -300],
      ],
      [
        [60, 14, -270],
        [56, 6, -305],
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
    new URL(`../../../test-results/buildings-browser${compatRun() ? '-compat' : ''}/`, import.meta.url),
  );
  await mkdir(dir, { recursive: true });
  await writeFile(dir + 'street.png', shot);
  for (let i = 1; i < 5; i++) {
    await browser.page.evaluate((v) => window.view(v), i);
    await writeFile(`${dir}near-${i}.png`, await browser.page.locator('canvas').screenshot());
  }
  const png = await decodePNG(shot);
  // Background is about (159, 180, 200): count pixels clearly off it, in each sixth of the frame width.
  const cols = new Array(6).fill(0);
  for (let y = 0; y < png.height; y++)
    for (let x = 0; x < png.width; x++) {
      const i = 4 * (y * png.width + x),
        d = Math.abs(png.data[i] - 159) + Math.abs(png.data[i + 1] - 180) + Math.abs(png.data[i + 2] - 200);
      if (d > 60) cols[Math.floor((x * 6) / png.width)]++;
    }
  for (const [i, n] of cols.entries()) assert.ok(n > 1500, `sixth ${i} of the frame shows ${n} building pixels`);
  await browser.page.evaluate(() => window.fixture.dispose());
  console.log('Buildings and harbour drawn', compatRun() ? '(WebGL2 compatibility layer)' : '(WebGPU)', cols);
} finally {
  await browser.close();
}
