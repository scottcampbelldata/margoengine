import { latheGeometry, sphereGeometry } from '@margoengine/geometry';
import { Material } from '@margoengine/materials';
import { surface, texturedGround } from './environment-films.js';

const centre = -166.55;
const deck = (x) => 10.29 + 0.0118 * x;
const railGrade = (z) => 4.02 + (z + 140) * 0.047;

async function buildRailCut(engine, shop) {
  const ballast = await surface('gravelly_sand', { color: '#b9af9d', normalScale: 0.6 });
  const bed = texturedGround(
    engine,
    (_x, z) => railGrade(z),
    ballast.material,
    { origin: [38.0, -250], size: [53, 175], resolution: 45 },
    3.2,
  );
  const tracks = shop.group('Illinois Central rail cut');
  const ties = new Material({ color: '#4d433a', roughness: 0.92 });
  const tops = new Material({ color: '#6f6d66', roughness: 0.34, metalness: 0.63 });
  const sides = new Material({ color: '#54463c', roughness: 0.75, metalness: 0.3 });
  const grade = [-Math.atan(0.047), 0, 0];
  for (const centre of [44.8, 50.65, 56.4, 62.2, 68.1, 74.3, 80.15, 86.25]) {
    for (let z = -248; z < -76; z += 0.61) {
      shop.box([2.52, 0.137, 0.227], ties, [centre, railGrade(z) + 0.041, z], grade, tracks);
    }
    for (const side of [-1, 1]) {
      const x = centre + side * 0.718;
      const z = -162.5;
      shop.box([0.064, 0.11, 173], sides, [x, railGrade(z) + 0.159, z], grade, tracks);
      shop.box([0.078, 0.037, 173], tops, [x, railGrade(z) + 0.23, z], grade, tracks);
    }
  }
  return { bed, dispose: ballast.dispose };
}

export async function buildBalboDrive(engine, shop) {
  const [road, concrete, railway] = await Promise.all([
    surface('asphalt_02', { color: '#a3a5a2', normalScale: 0.83 }),
    surface('concrete_floor_02', { color: '#eee9d8', normalScale: 0.31 }),
    buildRailCut(engine, shop),
  ]);
  const { group, part, box, ring } = shop;
  const bridge = group('Balbo Drive viaduct');
  const roadway = texturedGround(
    engine,
    deck,
    road.material,
    { origin: [-54.5, centre - 6.4], size: [205, 12.8], resolution: 40 },
    4.2,
  );
  const deckPaint = new Material({ color: '#c6a461', roughness: 0.87, roughnessMap: road.material.roughnessMap });
  const chalk = new Material({ color: '#c8c7b6', roughness: 0.8 });
  const iron = new Material({ color: '#3c3e3a', roughness: 0.58, metalness: 0.63 });
  const castStone = new Material({ color: '#d9d3c1', roughness: 0.88 });
  const glass = new Material({ color: '#e6e1d1', roughness: 0.36, metalness: 0.03 });
  const angle = Math.atan(0.0118);
  const models = [roadway, railway.bed];
  box([205, 1.3, 19.3], castStone, [48, deck(48) - 0.81, centre], [0, 0, angle], bridge, 0.042);
  for (const x of [18, 43, 89, 114]) {
    box([2.45, 7.45, 16.9], castStone, [x, deck(x) - 4.85, centre], undefined, bridge, 0.075);
    box([3.35, 0.52, 17.35], castStone, [x, deck(x) - 1.77, centre], undefined, bridge, 0.066);
  }
  for (const side of [-1, 1]) {
    const z = centre + side * 8.15;
    box([205, 0.28, 3.29], castStone, [48, deck(48) + 0.019, z], [0, 0, angle], bridge, 0.025);
    models.push(
      texturedGround(
        engine,
        (x) => deck(x) + 0.163,
        concrete.material,
        { origin: [-54.5, z - 1.61], size: [205, 3.22], resolution: 36 },
        3.1,
      ),
    );
    box([205, 0.2, 0.27], castStone, [48, deck(48) + 0.076, centre + side * 6.47], [0, 0, angle], bridge, 0.019);
    box([205, 0.44, 0.31], castStone, [48, deck(48) + 0.25, centre + side * 9.66], [0, 0, angle], bridge, 0.025);
    box([205, 0.16, 0.34], castStone, [48, deck(48) + 1.03, centre + side * 9.65], [0, 0, angle], bridge, 0.023);
    for (let x = -53.5; x < 150; x += 1.17) {
      const position = [x, deck(x) + 0.33, centre + side * 9.66];
      if (Math.abs((x + 53.5) % 9.36) < 1.05) {
        box([0.51, 0.91, 0.5], castStone, [x, position[1] + 0.33, position[2]], undefined, bridge, 0.024);
        continue;
      }
      part(
        latheGeometry(
          [
            [0.105, 0],
            [0.103, 0.071],
            [0.073, 0.125],
            [0.062, 0.28],
            [0.088, 0.44],
            [0.09, 0.62],
          ],
          14,
        ),
        castStone,
        position,
        undefined,
        bridge,
      );
    }
    for (const x of [-27, 19, 71, 119]) {
      const post = group('Balbo promenade lantern', bridge, [x, deck(x) + 0.14, z - side * 0.4]);
      ring([0.16, 0.23, 0.48], iron, [0, 0.24, 0], undefined, post, 22);
      ring([0.054, 0.096, 4.43], iron, [0, 2.51, 0], undefined, post, 22);
      ring([0.125, 0.055, 0.115], iron, [0, 4.76, 0], undefined, post, 22);
      part(sphereGeometry(0.174, 32, 20), glass, [0, 4.945, 0], undefined, post);
      ring([0.012, 0.075, 0.122], iron, [0, 5.135, 0], undefined, post, 20);
    }
  }
  for (const z of [centre - 0.111, centre + 0.111])
    box([202, 0.012, 0.115], deckPaint, [48, deck(48) + 0.016, z], [0, 0, angle], bridge, 0.001);
  for (const side of [-1, 1])
    for (let x = -51; x < 150; x += 8.6)
      box([3.26, 0.009, 0.085], chalk, [x, deck(x) + 0.016, centre + side * 3.17], [0, 0, angle], bridge, 0.001);

  for (const side of [-1, 1]) {
    const x = 27.3;
    const pylon = group('Ornamental concrete pylon', bridge, [x, deck(x), centre + side * 10.54]);
    for (const [y, w, h] of [
      [0.24, 3.05, 0.48],
      [1.01, 2.73, 1.19],
      [1.73, 2.86, 0.25],
      [4.35, 2.26, 5.12],
      [7.14, 2.69, 0.29],
      [7.49, 2.76, 0.39],
      [7.83, 2.91, 0.19],
    ]) {
      box([w, h, w * 0.88], castStone, [0, y, 0], undefined, pylon, 0.056);
    }
    const cap = latheGeometry(
      [
        [1.44, 0],
        [1.33, 0.29],
        [1.02, 0.98],
        [0.91, 1.11],
        [0, 1.11],
      ],
      4,
    );
    part(cap, castStone, [0, 7.91, 0], [0, Math.PI / 4, 0], pylon);
    for (const z of [-0.72, 0.72]) {
      ring([0.17, 0.21, 4.8], castStone, [-1.18, 4.48, z], undefined, pylon, 24);
      box([0.56, 0.18, 0.49], castStone, [-1.19, 2.02, z], undefined, pylon, 0.024);
      box([0.52, 0.18, 0.47], castStone, [-1.19, 6.98, z], undefined, pylon, 0.025);
    }
  }
  return {
    models,
    dispose() {
      road.dispose();
      concrete.dispose();
      railway.dispose();
    },
  };
}
