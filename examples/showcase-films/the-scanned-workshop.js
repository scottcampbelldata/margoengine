import { AssetCache } from '@margoengine/cache';
import { ImageBackground } from '@margoengine/environment';
import { latheGeometry } from '@margoengine/geometry';
import { loadTexture, Material } from '@margoengine/materials';
import { Splats } from '@margoengine/splats';
import { parseSplat, parseSpz, transformSplats } from '@margoengine/splats/data';
import { brushTexture, surface } from './environment-films.js';
import { exampleAsset, packedAsset } from '../live/asset-base.js';
import { finishTexture, rng, shotAt } from './film.js';

const benchTop = 0.933;
const asset = (name) => exampleAsset('the-scanned-workshop/' + name);
const wood = (channel) =>
  loadTexture(packedAsset('showcase-films/assets/technical-films/wood-floor-' + channel + '.jpg'), {
    colorSpace: channel === 'diff' ? 'srgb' : 'linear',
    signal: AbortSignal.timeout(20_000),
  });

export async function buildScannedWorkshop(engine, shop) {
  const cache = new AssetCache({ name: 'margo-daylight-studio', maxBytes: 24_000_000, timeout: 20_000 });
  async function scan(name, decode, scale, bottom, x, z, yaw) {
    const signal = AbortSignal.timeout(30_000);
    const response = await cache.fetch(asset(name), { signal });
    if (!response.ok) throw new Error('The studio scan is unavailable: ' + name);
    const original = await decode(await response.arrayBuffer(), { signal });
    const c = scale * Math.cos(yaw);
    const s = scale * Math.sin(yaw);
    const data = transformSplats(original, [
      c,
      0,
      -s,
      0,
      0,
      -scale,
      0,
      0,
      -s,
      0,
      -c,
      0,
      x,
      benchTop + scale * bottom,
      z,
      1,
    ]);
    const cloud = Splats.attach(engine, data);
    cloud.antialias = true;
    return cloud;
  }

  const [cactus, succulent, concrete, map, roughnessMap, normalMap, garden] = await Promise.all([
    scan('cactus.spz', parseSpz, 0.287, 0.566, -0.57, -0.43, 0.29),
    scan('plant.splat', parseSplat, 1, 0.283, 0.69, -0.48, -0.37),
    surface('concrete_floor_02', { color: '#aaa89b', normalScale: 0.73 }),
    wood('diff'),
    wood('rough'),
    wood('nor_gl'),
    ImageBackground.load({ shape: 'sphere', images: [asset('studio-garden.jpg')], rotation: 0.38 }),
  ]);
  engine.use(garden);

  const grain = finishTexture(625193, { r: 151, grain: 16, mottling: 15, streak: true });
  const oak = new Material({ color: '#e0c297', map, roughnessMap, normalMap, normalScale: 0.52, roughness: 0.61 });
  const floor = concrete.material;
  const plaster = new Material({ color: '#f0e6d0', roughness: 0.92, roughnessMap: grain });
  const frame = new Material({ color: '#727e71', roughness: 0.56, metalness: 0.27 });
  const white = new Material({ color: '#ece6d9', roughness: 0.68, roughnessMap: grain });
  const iron = new Material({ color: '#485348', roughness: 0.51, metalness: 0.52 });
  const clay = new Material({ color: '#ad6646', roughness: 0.76, roughnessMap: grain });
  const glaze = new Material({ color: '#8c9980', roughness: 0.32, roughnessMap: grain });
  const brass = new Material({ color: '#a8996f', roughness: 0.42, metalness: 0.55, roughnessMap: grain });
  const linen = new Material({ color: '#c8c0a6', roughness: 0.86, roughnessMap: grain });
  const soil = new Material({ color: '#40372a', roughness: 0.96 });
  const { group, part, box, ring, beam, sign } = shop;

  const walls = group('Daylight potting studio');
  box([7.8, 0.18, 6.3], floor, [0, -0.11, 0], undefined, walls, 0.02);
  box([7.6, 0.22, 5.4], plaster, [0, 3.3, 0.26], undefined, walls);
  box([0.22, 3.3, 4.9], plaster, [-3.62, 1.65, 0.49], undefined, walls);
  box([0.21, 3.31, 4.9], plaster, [3.62, 1.65, 0.49], undefined, walls);
  box([7.2, 1.02, 0.24], plaster, [0, 0.512, -2.02], undefined, walls);
  box([7.2, 0.57, 0.24], plaster, [0, 3.0, -2.02], undefined, walls);
  box([1.49, 1.78, 0.24], plaster, [-2.81, 1.9, -2.02], undefined, walls);
  box([1.67, 1.78, 0.24], plaster, [2.76, 1.9, -2.02], undefined, walls);
  for (const x of [-2.03, -0.71, 0.62, 1.91])
    box([0.074, 1.75, 0.139], frame, [x, 1.89, -2.035], undefined, walls, 0.008);
  for (const y of [1.05, 1.81, 2.72]) box([4.01, 0.075, 0.14], frame, [-0.06, y, -2.035], undefined, walls, 0.008);
  box([4.19, 0.078, 0.42], white, [-0.06, 1.012, -1.968], undefined, walls, 0.016);
  box([7.42, 0.135, 0.045], frame, [0, 0.076, -1.872], undefined, walls, 0.004);
  for (const x of [-3.49, 3.49]) box([0.048, 0.14, 4.65], frame, [x, 0.078, 0.42], undefined, walls, 0.006);

  const table = group('Oak potting bench');
  box([2.94, 0.079, 0.98], oak, [-0.025, benchTop - 0.04, -0.47], undefined, table, 0.014);
  box([2.81, 0.053, 0.84], iron, [-0.025, 0.84, -0.47], undefined, table, 0.008);
  for (const x of [-1.31, 1.27])
    for (const z of [-0.867, -0.08]) {
      box([0.095, 0.831, 0.087], iron, [x, 0.437, z], undefined, table, 0.011);
      box([0.114, 0.038, 0.102], iron, [x, 0.021, z], undefined, table, 0.008);
      box([0.078, 0.17, 0.14], iron, [x, 0.743, z], undefined, table, 0.008);
      ring([0.012, 0.012, 0.01], brass, [x, 0.726, z + 0.078], [Math.PI / 2, 0, 0], table, 8);
    }
  box([2.64, 0.027, 0.78], oak, [-0.025, 0.25, -0.473], undefined, table, 0.008);
  for (const z of [-0.86, -0.075]) box([2.61, 0.048, 0.052], iron, [-0.025, 0.226, z], undefined, table, 0.006);

  const contact = brushTexture(128, 128, (ctx, w, h) => {
    const shadow = ctx.createRadialGradient(w * 0.5, h * 0.5, 6, w * 0.5, h * 0.5, w * 0.477);
    shadow.addColorStop(0, '#211d15a4');
    shadow.addColorStop(0.53, '#27201663');
    shadow.addColorStop(1, '#29201600');
    ctx.fillStyle = shadow;
    ctx.fillRect(0, 0, w, h);
  });
  const contactMaterial = new Material({ map: contact, transparent: true, color: '#ffffff', roughness: 0.94 });
  for (const [x, z, a] of [
    [-0.52, -0.4, 0.505],
    [0.75, -0.45, 0.375],
  ])
    box([a, 0.001, a * 0.68], contactMaterial, [x, benchTop + 0.0015, z], undefined, table);

  function flowerpot(x, y, z, size, material, planted = false) {
    const profile = [
      [0, 0],
      [0.086, 0],
      [0.094, 0.011],
      [0.119, 0.146],
      [0.123, 0.149],
      [0.124, 0.17],
      [0.111, 0.171],
      [0.111, 0.153],
      [0.083, 0.015],
      [0, 0.015],
    ].map(([r, h]) => [size * r, size * h]);
    part(latheGeometry(profile, 54), material, [x, y, z], undefined, table);
    if (planted) ring([0.105 * size, 0.1 * size, 0.009], soil, [x, y + size * 0.139, z], undefined, table, 42);
  }
  flowerpot(1.1, benchTop, -0.51, 0.77, clay, true);
  flowerpot(-1.16, 0.265, -0.48, 1.48, clay);
  flowerpot(-0.79, 0.265, -0.43, 0.94, glaze);
  flowerpot(0.92, 0.265, -0.6, 1.28, glaze);
  flowerpot(1.24, 0.265, -0.43, 0.78, clay);

  const can = group('Brass watering can', table, [-1.02, benchTop + 0.003, -0.62], [0, -0.3, 0]);
  part(
    latheGeometry(
      [
        [0, 0],
        [0.119, 0],
        [0.127, 0.02],
        [0.132, 0.17],
        [0.116, 0.19],
        [0.068, 0.204],
        [0.064, 0.213],
        [0.053, 0.214],
        [0.053, 0.189],
        [0.077, 0.174],
        [0.113, 0.017],
        [0, 0.013],
      ],
      54,
    ),
    glaze,
    undefined,
    undefined,
    can,
  );
  beam([0.102, 0.078, 0.031], [0.302, 0.234, 0.047], 0.037, brass, can, true);
  ring([0.035, 0.025, 0.032], brass, [0.31, 0.245, 0.049], [0, 0, -0.89], can, 32);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI;
    const b = ((i + 1) / 14) * Math.PI;
    const point = (v) => [-0.107 - 0.081 * Math.sin(v), 0.105 + 0.097 * Math.cos(v), 0];
    beam(point(a), point(b), 0.019, iron, can, true);
  }
  ring([0.011, 0.015, 0.087], brass, [0.13, benchTop + 0.021, -0.15], [1.4, 0, 0.6], table, 25);
  box([0.28, 0.013, 0.2], linen, [0.25, benchTop + 0.006, -0.217], [0, -0.08, 0], table, 0.012);
  box([0.254, 0.009, 0.189], white, [0.254, benchTop + 0.016, -0.215], [0, -0.072, 0], table, 0.004);
  sign(
    ['PLANT STUDIES', 'CACTUS   /   LEAF TEXTURE'],
    [0.239, 0.155],
    [0.254, benchTop + 0.022, -0.214],
    [-Math.PI / 2, 0, 0],
    table,
    { foreground: '#4b5645', background: '#e5dfce' },
  );

  const random = rng(13975);
  const pots = group('Propagation shelf');
  for (const y of [0.7, 1.16, 1.62]) box([1.1, 0.051, 0.32], oak, [2.68, y, -1.69], undefined, pots, 0.01);
  for (const x of [2.16, 3.2]) {
    box([0.045, 1.72, 0.044], iron, [x, 0.87, -1.84], undefined, pots, 0.007);
    box([0.045, 1.72, 0.044], iron, [x, 0.87, -1.55], undefined, pots, 0.007);
  }
  for (const y of [0.73, 1.19, 1.65])
    for (let i = 0; i < 3; i++)
      flowerpot(2.35 + i * 0.306 + 0.02 * random(), y, -1.7, 0.57 + 0.3 * random(), i === 1 ? glaze : clay);

  const shots = [
    [5.8, [-0.58, 1.5, 0.57], [-1.02, 1.45, 0.34], [-0.57, 1.38, -0.42], [-0.54, 1.4, -0.45], 33],
    [17.7, [-1.58, 1.69, 1.84], [-1.29, 1.63, 1.55], [-0.33, 1.25, -0.68], [-0.23, 1.24, -0.63], 52],
    [30.3, [-0.2, 1.79, 0.25], [-1.15, 1.7, 0.22], [-0.59, 1.4, -0.41], [-0.56, 1.37, -0.41], 36],
    [42.3, [1.31, 1.5, 0.41], [0.42, 1.57, 0.61], [0.67, 1.23, -0.48], [0.66, 1.24, -0.45], 36],
    [57.3, [-1.74, 1.51, 1.13], [1.86, 1.62, 1.38], [-0.72, 1.26, -0.5], [0.69, 1.26, -0.5], 43],
    [72.2, [0.32, 2.38, 0.57], [0.77, 2.34, 0.48], [0.09, 0.99, -0.49], [-0.02, 1.06, -0.43], 42],
    [90, [1.43, 1.58, 1.94], [1.67, 1.66, 2.13], [-0.16, 1.24, -0.65], [-0.3, 1.28, -0.59], 48],
  ];
  const cues = [
    [0.19, 5.55, 'These cactus spines are made of Gaussian splats.'],
    [7.4, 15.8, 'A real cactus scan, placed on a Margo workbench.'],
    [19.2, 27.7, 'Move in close and the fine detail stays in place.'],
    [32.3, 40.5, 'A second splat preserves thin, overlapping leaves.'],
    [44.6, 54.3, 'The objects shift at different speeds as we move past.'],
    [59.6, 69.2, 'The two splat objects share the same 3D space.'],
    [74.3, 81.1, 'Photographic splats and modeled surfaces in one shot.'],
  ];
  return {
    apply: (time) => shotAt(shots, time),
    cues,
    credit: 'Cactus capture by steam studio / 3D SCAN STUDIO iris • CC0',
    dispose() {
      cactus.dispose();
      succulent.dispose();
      concrete.dispose();
      grain.dispose();
      contact.dispose();
      garden.dispose();
      for (const texture of [map, roughnessMap, normalMap]) texture.dispose();
      cache.dispose();
    },
  };
}
