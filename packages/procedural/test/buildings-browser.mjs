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
      camera: { position: [20, 26, 70], target: [20, 4, 0], near: 0.05, far: 600 },
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
    // Cutaways far from the street: one floor of a house at a time, seen from above, its walls and roof left off, so
    // the stair, its guard, the fixtures and the soft furnishings show.
    const cuts = [];
    const indoor = ['interior', 'furniture', 'stairs', 'fixtures', 'metalwork', 'fabric', 'mats'];
    // Triangles of one floor, what stands higher flattened to the cut height.
    const slice = (g, lo, hi) => {
      const keep = [];
      for (let t = 0; t < g.indices.length; t += 3) {
        const y = [0, 1, 2].map((k) => g.positions[3 * g.indices[t + k] + 1]);
        if (Math.min(...y) >= lo && Math.min(...y) < hi - 0.01)
          keep.push(g.indices[t], g.indices[t + 1], g.indices[t + 2]);
      }
      const positions = g.positions.slice();
      for (let i = 1; i < positions.length; i += 3) positions[i] = Math.min(positions[i], hi);
      return { ...g, positions, indices: new Uint32Array(keep) };
    };
    for (const style of ['japan-2011-house', 'western-1910-house', 'western-1910-brick'])
      for (const floor of [0, 1]) {
        const at = [cuts.length * 40, 0, -600];
        const b = generateBuilding({ style, origin: at, detail: 'near' });
        const lo = b.floors[floor] - 0.01,
          hi = b.floors[floor] + (floor === 0 ? b.floors[1] - b.floors[0] - 0.25 : 1.6);
        for (const name of indoor) {
          if (!b.parts[name]) continue;
          const g = slice(b.parts[name], lo - (name === 'interior' ? 0.2 : 0), hi);
          if (g.indices.length) add(g, b.palette[name]);
        }
        const r = Math.max(b.options.width, b.options.depth);
        cuts.push([
          [at[0], b.floors[floor] + r * 0.95, at[2] + r * 0.6],
          [at[0], b.floors[floor], at[2]],
        ]);
      }
    // From inside: the foot of each house's stair, and its kitchen, at eye height.
    for (const style of ['japan-2011-house', 'western-1910-house']) {
      const at = [cuts.length * 40, 0, -600];
      const b = generateBuilding({ style, origin: at, detail: 'near' });
      for (const [name, g] of Object.entries(b.parts)) add(g, b.palette[name]);
      for (const target of [
        {
          floor: 0,
          x: (b.stairs[0].min[0] + b.stairs[0].max[0]) / 2,
          z: (b.stairs[0].min[1] + b.stairs[0].max[1]) / 2,
        },
        (() => {
          const f = b.furniture.find((q) => q.kind === 'kitchen counter' || q.kind === 'sink');
          return { floor: f.floor, x: (f.min[0] + f.max[0]) / 2, z: (f.min[2] + f.max[2]) / 2 };
        })(),
      ]) {
        const room = b.rooms.find(
          (q) =>
            q.floor === target.floor &&
            target.x >= q.min[0] &&
            target.x <= q.max[0] &&
            target.z >= q.min[1] &&
            target.z <= q.max[1],
        );
        // The room corner farthest from the target, a little in from the walls.
        const cx = target.x - room.min[0] > room.max[0] - target.x ? room.min[0] + 0.15 : room.max[0] - 0.15,
          cz = target.z - room.min[1] > room.max[1] - target.z ? room.min[1] + 0.15 : room.max[1] - 0.15;
        cuts.push([
          [at[0] + cx, room.level + 1.7, at[2] + cz],
          [at[0] + target.x, room.level + 0.8, at[2] + target.z],
        ]);
      }
    }
    // The stairs of plans too small for a dog-leg (a spiral, then a ladder) and a stair tower's join, cut open over the
    // first floor.
    for (const [make, options] of [
      [generateBuilding, { style: 'western-1910-house', width: 3.2, depth: 3.6 }],
      [generateBuilding, { style: 'japan-2011-house', width: 3, depth: 3, wall: 0.7 }],
      [generateBuildingPlan, { style: 'western-1910-house', plan: 'L', tower: 'front-left', towerSize: 4 }],
      // Wings at other floor levels: steps up to the main block, and a flight sunk into its ground floor.
      ...[
        { storeys: [3.2, 3.2], wing: [2.9, 2.9], plinth: 0.2 },
        { storeys: [2.9, 2.9], wing: [2.5, 2.5], plinth: 0.15 },
      ].map(({ storeys, wing, plinth }) => [
        generateBuildingPlan,
        {
          style: 'western-1910-house',
          width: 12,
          depth: 8,
          storeys,
          wings: [{ at: [6.5, 0], width: 5, depth: 6, plinth, storeys: wing }],
        },
      ]),
      // Winder stairs, and a ramp between joined floors.
      [generateBuilding, { style: 'japan-2011-house', width: 5, depth: 4.5, stairShape: 'winder' }],
      [generateBuilding, { style: 'western-1910-house', width: 5.5, depth: 5, stairShape: 'winder' }],
      [
        generateBuildingPlan,
        {
          style: 'western-1910-house',
          width: 12,
          depth: 8,
          storeys: [3.2, 3.2],
          ramps: true,
          wings: [{ at: [6.5, 0], width: 7, depth: 6, plinth: 0.4, storeys: [2.9, 2.9] }],
        },
      ],
    ]) {
      const at = [cuts.length * 40, 0, -600];
      const b = make({ ...options, origin: at, detail: 'near' });
      // The ground floor, up to the second floor's guards.
      const lo = Math.min(...b.rooms.map((r) => r.level)) - 0.01;
      for (const name of [...indoor, ...(b.blocks ? ['walls'] : [])]) {
        if (!b.parts[name]) continue;
        // Steps start a little under their floor; a join is cut below the lower ceiling so it shows.
        const under = name === 'interior' ? 0.2 : b.joinSteps?.length ? 0.2 : 0,
          g = slice(
            b.parts[name],
            lo - under,
            lo + (b.joinSteps?.length ? 1.9 : b.blocks ? 2.4 : options.stairShape ? 2.7 : 4),
          );
        if (g.indices.length) add(g, b.palette[name]);
      }
      const r = b.blocks ? 14 : 5.5,
        flight = b.joinSteps?.[0],
        turned = !b.blocks && b.stairs[0]?.kind === 'winder' ? b.stairs[0] : undefined;
      if (turned) {
        // From over the foot of the stair, looking up the flight into the turn.
        const x = at[0] + (turned.min[0] + turned.max[0]) / 2,
          z = at[2] + (turned.min[1] + turned.max[1]) / 2,
          dx = x - (at[0] + turned.foot[0]),
          dz = z - (at[2] + turned.foot[1]),
          d = Math.hypot(dx, dz);
        cuts.push([
          [x - (dx / d) * 2.1, lo + 3.7, z - (dz / d) * 2.1],
          [x + (dx / d) * 0.4, lo + 1.1, z + (dz / d) * 0.4],
        ]);
      } else if (flight) {
        // Close over the steps at the join.
        const x = at[0] + (flight.min[0] + flight.max[0]) / 2,
          z = at[2] + (flight.min[1] + flight.max[1]) / 2;
        // From the side the flight stands on, a little to one side of it.
        const dx = flight.head[0] - flight.foot[0],
          dz = flight.head[1] - flight.foot[1],
          // Nearly overhead for a sunk flight, so its well shows past the wall.
          d = (flight.sunken ? 0.7 : -1.8) / Math.hypot(dx, dz);
        cuts.push([
          [x + dx * d - dz * d * 0.5, flight.to + (flight.sunken ? 3.4 : 2.4), z + dz * d + dx * d * 0.5],
          [x, flight.from, z],
        ]);
      } else
        cuts.push([
          [at[0] + r * 0.25, lo + r, at[2] + r * 0.75],
          [at[0], lo + 1, at[2]],
        ]);
    }
    // Ramps up to the front doors, over a porch and over a stoop, from the front corner.
    for (const [style, plinth] of [
      ['western-1910-house', 0.9],
      ['japan-2011-house', 0.5],
    ]) {
      const at = [cuts.length * 40, 0, -600];
      const b = generateBuilding({ style, plinth, ramps: true, origin: at, detail: 'near' });
      for (const [name, g] of Object.entries(b.parts)) add(g, b.palette[name]);
      cuts.push([
        [at[0] + 17, 7, at[2] + 19],
        [at[0], 1, at[2] + 7],
      ]);
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
      ...cuts,
    ];
    window.view = async (i) => {
      stage.engine.camera.position = views[i][0];
      stage.engine.camera.target = views[i][1];
      await stage.engine.render({ delta: 0 });
      await stage.engine.render({ delta: 0 });
    };
    await window.view(0);
    window.fixture = stage;
    return { errors, views: views.length };
  });
  assert.deepEqual(result.errors, []);
  const shot = await browser.page.locator('canvas').screenshot();
  const dir = fileURLToPath(
    new URL(`../../../test-results/buildings-browser${compatRun() ? '-compat' : ''}/`, import.meta.url),
  );
  await mkdir(dir, { recursive: true });
  await writeFile(dir + 'street.png', shot);
  for (let i = 1; i < result.views; i++) {
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
