import { parseOBJ } from '@margoengine/loaders';
import { computeVertexNormals } from '@margoengine/geometry';
import { createMesh, loadTexture, Material } from '@margoengine/materials';
import { Figure } from '@margoengine/sciviz';
import { TransferFunction, bindTransfer } from '@margoengine/sciviz/transfer';
import { finishTexture, mix, ramp, shotAt } from './film.js';
import { asset as libraryAsset } from './assets.js';

const source = (name) => new URL(libraryAsset(`showcase-12-15-inputs/meteorite/${name}`));
const dims = [131, 185, 176];
const extent = [1310, 1854, 1758].map((count) => (count * 0.0000675) / 2);
const bounds = extent.flatMap((half) => [-half, half]);

async function data(name, signal) {
  const response = await fetch(source(name), { signal });
  if (!response.ok) throw new Error(`Cannot open NASA sample data ${name}`);
  return response.arrayBuffer();
}

export async function buildMeteorite(engine, shop, cluster) {
  const signal = AbortSignal.timeout(35_000);
  const [obj, bytes, scanColor] = await Promise.all([
    data('sample.obj', signal).then((raw) => parseOBJ(raw, { signal })),
    data('volume.u8', signal),
    loadTexture(source('texture.jpg').href, { colorSpace: 'srgb', signal }),
  ]);
  const measured = new Uint8Array(bytes);
  if (measured.length !== dims.reduce((a, b) => a * b, 1)) throw new Error('Unexpected NASA XCT grid size');
  for (let i = 0; i < obj.positions.length; i += 3) {
    const north = obj.positions[i + 1];
    obj.positions[i + 1] = obj.positions[i + 2];
    obj.positions[i + 2] = -north;
  }
  const specimen = createMesh(
    engine,
    computeVertexNormals(obj),
    new Material({ map: scanColor, color: '#e5e0d5', roughness: 0.82 }),
  );
  const fig = Figure.attach(engine, { axes: false, limits: bounds, aspect: extent });
  const samples = Float32Array.from(measured);
  const volume = await fig.volume(samples, {
    dims,
    bounds,
    range: [0, 178],
    opacity: [
      [0, 0],
      [1, 0.8],
    ],
    colormap: 'gray',
    density: 1.1,
    quality: 2,
    shading: true,
  });
  const transfer = new TransferFunction({
    range: [0, 178],
    gradientMax: 1,
    points: [
      { value: 0, rgba: [0, 0, 0, 0] },
      { value: 83, rgba: [0.008, 0.13, 0.22, 0] },
      { value: 105, rgba: [0.024, 0.25, 0.39, 0.025] },
      { value: 118, rgba: [0.13, 0.53, 0.64, 0.12] },
      { value: 140, rgba: [0.73, 0.76, 0.6, 0.48] },
      { value: 178, rgba: [1, 0.88, 0.58, 0.98] },
    ],
  });
  const binding = bindTransfer(volume, transfer);
  const slice = volume.slice('z', 0.5, { opacity: 1 });
  const dense = await fig.isosurface(samples, 127, { dims, bounds, range: [0, 178], color: '#deb174', signal });
  const densest = await fig.isosurface(samples, 137, { dims, bounds, range: [0, 178], color: '#f4ce7c', signal });
  await fig.ready();
  const satin = finishTexture(1704, { r: 145, grain: 14, streak: true, mottling: 14 });
  const iron = new Material({ color: '#192631', metalness: 0.61, roughness: 0.42, roughnessMap: satin });
  const panel = new Material({ color: '#263749', roughness: 0.92, roughnessMap: satin });
  const backing = new Material({ color: '#33424a', roughness: 0.84, roughnessMap: satin });
  const felt = new Material({ color: '#313d42', roughness: 0.84 });
  const glazing = new Material({ color: '#9bb5c4', transparent: true, opacity: 0.068, roughness: 0.22 });
  const brass = new Material({ color: '#877257', metalness: 0.75, roughness: 0.39, roughnessMap: satin });
  const led = new Material({ color: '#e7dcb9', emissive: '#fee3ae', emissiveIntensity: 1.12 });
  const casework = shop.group('Conservation display');
  shop.box([2.68, 0.12, 1.65], panel, [0, -0.38, 0], undefined, casework, 0.032);
  shop.box([2.85, 1.67, 0.1], backing, [0, 0.36, -0.56], undefined, casework, 0.02);
  for (const x of [-0.48, 0.48]) {
    shop.box([0.007, 1.5, 0.003], iron, [x, 0.38, -0.508], undefined, casework);
  }
  shop.box([0.42, 0.23, 0.36], iron, [0, -0.196, 0], undefined, casework, 0.015);
  shop.box([0.28, 0.017, 0.205], felt, [0, -0.071, 0], undefined, casework, 0.004);
  for (const x of [-0.126, 0.126]) {
    shop.box([0.006, 0.219, 0.213], glazing, [x, 0.052, 0], undefined, casework, 0.001);
    for (const z of [-0.105, 0.105]) shop.box([0.006, 0.225, 0.006], brass, [x, 0.051, z], undefined, casework, 0.0012);
  }
  shop.box([0.263, 0.006, 0.227], glazing, [0, 0.166, 0], undefined, casework, 0.001);
  shop.box([0.255, 0.004, 0.009], led, [0, 0.157, -0.093], undefined, casework, 0.001);
  shop.sign(['EET 79001,2', 'MARTIAN SHERGOTTITE'], [0.136, 0.034], [0, -0.114, 0.182], undefined, casework, {
    background: '#202a31',
    foreground: '#f2e3c7',
    lit: 0.2,
  });
  const cradle = shop.group('Specimen cradle');
  shop.box([0.089, 0.008, 0.094], felt, [-0.004, -0.059, -0.007], undefined, cradle, 0.003);
  shop.box([0.013, 0.009, 0.029], brass, [-0.024, -0.059, -0.012], undefined, cradle, 0.002);
  const rim = shop.group('Analysis scale plate');
  shop.box([0.155, 0.006, 0.019], iron, [0, -0.076, 0.071], undefined, rim, 0.001);
  for (let step = -6; step <= 6; step++) {
    shop.box([0.00055, 0.0008, step % 2 === 0 ? 0.013 : 0.007], led, [step * 0.01, -0.0728, 0.071], undefined, rim);
  }
  cluster.setLights([
    { position: [0.13, 0.15, 0.08], color: [1, 0.89, 0.71], intensity: 0.16, range: 0.56 },
    { position: [-0.34, 0.2, -0.08], color: [0.55, 0.79, 1], intensity: 0.7, range: 0.85 },
  ]);
  const shots = [
    [5.7, [0.14, 0.031, 0.166], [0.122, 0.035, 0.134], [0, -0.006, 0], [0, 0.001, 0], 44],
    [18.2, [0.38, 0.142, 0.41], [0.275, 0.123, 0.37], [0, -0.035, 0], [0, -0.019, 0], 42],
    [31.6, [0.165, 0.075, 0.132], [0.125, 0.074, 0.175], [0, 0, 0], [0, 0.008, 0], 43],
    [46.7, [0.06, 0.21, 0.071], [0.034, 0.224, 0.053], [0, 0.0, 0], [0, 0.0, 0], 47],
    [76.5, [-0.151, 0.08, 0.15], [-0.113, 0.093, 0.125], [0, 0.003, 0], [0.001, 0.008, 0], 41],
    [90, [0.23, 0.069, 0.25], [0.32, 0.125, 0.37], [0, -0.029, 0], [0, -0.046, 0], 45],
  ];
  return {
    apply(time) {
      const analyze = time >= 18.2 && time < 76.5;
      specimen.root.visible = !analyze;
      cradle.visible = !analyze;
      rim.visible = analyze;
      volume.visible = time >= 18.2 && time < 31.6;
      volume.density = mix(0.85, 0.55, ramp(time, 22, 30));
      slice.visible = time >= 31.6 && time < 46.7;
      slice.position = mix(0.16, 0.85, ramp(time, 31.6, 46.6));
      dense.visible = time >= 46.7 && time < 61.6;
      densest.visible = time >= 61.6 && time < 76.5;
      return shotAt(shots, time);
    },
    cues: [
      [0.2, 5.4, 'A piece of Mars, recovered in Antarctica.'],
      [6.6, 15.1, 'EET 79001,2 • NASA’s Antarctic Meteorite Collection'],
      [19.1, 28.3, 'X-ray CT reveals the rock’s interior without cutting it.'],
      [33.2, 43.9, 'Each slice records how strongly the rock absorbs X-rays.'],
      [47.5, 57.2, 'Brighter areas in the scan appear in three dimensions.'],
      [63.1, 72.7, 'Raise the threshold and only the brightest areas remain.'],
      [77.8, 82.7, 'Exterior photographs and CT come from the same sample.'],
    ],
    credit: 'NASA Astromaterials 3D • EET 79001,2',
    musicCredit: 'Music: Interstellar Space • John Bartmann • CC0',
    models: [specimen],
    dispose() {
      binding.dispose();
      fig.dispose();
      specimen.dispose();
      scanColor.dispose();
      satin.dispose();
    },
    inspection: { scanDimensions: dims, surfaces: [dense.triangles, densest.triangles] },
  };
}
