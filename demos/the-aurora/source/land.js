// The land: snowy fells round a frozen lake, a low shore under the camera and a stand of firs along it. Heights come
// from @margoengine/procedural/noise, the mesh from @margoengine/terrain, the trees from procedural/conifers and the
// ice from environment/reflector-pbr; the snow on all of it is weather/snow.
import { PbrMaterial } from '@margoengine/core';
import { heightfield } from '@margoengine/terrain';
import { Noise, fbm, ridged } from '@margoengine/procedural/noise';
import { generateConiferMesh } from '@margoengine/procedural/conifers';
import { toGeometry } from '@margoengine/geometry/utils';
import { PBRReflector } from '@margoengine/environment/reflector-pbr';

const noise = new Noise(1902);
const rolling = fbm((x, y) => noise.simplex2(x, y), { octaves: 6 });
const crests = ridged((x, y, z = 0) => noise.simplex(x, y, z), { octaves: 5 });
/** The lake: an ellipse north-northwest of the shore, metres. */
const lake = { x: -110, z: -430, rx: 470, rz: 380 };

/** Ground height in metres: the lake bed, a snowy shore and fells rising to the north. */
export function ground(x, z) {
  const reach = Math.hypot((x - lake.x) / lake.rx, (z - lake.z) / lake.rz);
  const shore = Math.min(1, Math.max(0, (reach - 0.9) / 0.45));
  const fell = Math.max(0, (-z - 650) / 900);
  const swell = rolling(x * 0.0024, z * 0.0024) * 0.5 + 0.5;
  return -2.5 + shore * shore * (3 + 7 * swell) + fell * fell * 150 * (0.55 * swell + 0.45 * crests(x * 0.0009, z * 0.0009));
}

/** The land's square: 3.6 km a side, the shore near its south edge. */
const area = { size: [3600, 3600], origin: [-1800, -2600], resolution: 448 };

/** Heights on an n x n grid over the land, row by row from its minimum corner, for the far shadows' march. */
function heightGrid(n) {
  const heights = new Float32Array(n * n), [w, d] = area.size, [x0, z0] = area.origin;
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) heights[r * n + c] = ground(x0 + (c / (n - 1)) * w, z0 + (r / (n - 1)) * d);
  return { heights, columns: n, rows: n, origin: area.origin, size: area.size };
}

/** Firs along the shore: [x, z, height m, seed]. */
const stand = [
  [14, -22, 12, 1], [21, -34, 15, 2], [29, -19, 10, 3], [36, -44, 17, 4], [-30, -16, 11, 5], [-41, -27, 14, 6],
  [-52, -14, 16, 7], [-47, -40, 9, 8], [70, -90, 15, 9], [82, -104, 12, 10], [-150, -70, 14, 11], [-164, -58, 17, 12],
  [-178, -82, 12, 13], [180, -160, 16, 14], [196, -150, 13, 15], [-300, -120, 15, 16],
];

export function buildLandscape(engine) {
  const paint = (color, roughness) => new PbrMaterial({ color, roughness });
  const snowfield = paint('#dfe5ee', 0.78), needles = paint('#1c2a22', 0.86), bark = paint('#3b2d24', 0.92);
  engine.createMesh().setGeometry(heightfield(ground, area)).setMaterial(snowfield);
  for (const [x, z, height, seed] of stand) {
    const fir = generateConiferMesh(seed % 3 ? 'grand-fir' : 'douglas-fir', { age: 'mature', height, detail: 2, seed });
    const at = [x, ground(x, z) - 0.2, z];
    engine.createMesh().setGeometry(toGeometry(fir.trunk)).setMaterial(bark).setPosition(at);
    engine.createMesh().setGeometry(toGeometry(fir.canopy)).setMaterial(needles).setPosition(at);
  }
  // Lake ice: black, glassy where the wind cleared the snow, so it mirrors the curtains and the Moon.
  const ice = PBRReflector.attach(engine, { width: lake.rx * 2.2, height: lake.rz * 2.2, roughness: 0.02, contactHardening: true, baseColor: '#0b1119', ior: 1.31 });
  ice.node.setRotation([-Math.PI / 2, 0, 0]);
  ice.node.setPosition([lake.x, 0, lake.z]);
  return { ice, field: heightGrid(256) };
}
