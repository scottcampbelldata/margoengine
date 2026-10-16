// Synthetic CAD assembly: a few distinct part shapes, many instances, 5-level hierarchy (root > zone > module > fastener set > part).
import { PbrMaterial } from '../../../packages/core/dist/index.js';
import {
  Shape,
  Path,
  extrudeGeometry,
  cylinderGeometry,
  mergeGeometries,
  applyMatrix4,
  toGeometry,
} from '../../../packages/geometry/dist/index.js';

const hole = (x, y, r) => new Path().absarc(x, y, r, 0, Math.PI * 2, true);
const polygon = (sides, r) => {
  const s = new Shape();
  for (let i = 0; i <= sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    i ? s.lineTo(Math.cos(a) * r, Math.sin(a) * r) : s.moveTo(r, 0);
  }
  return s;
};
const upright = (data) => applyMatrix4(data, [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]); // extrude along +z, rotate so thickness runs along +y

/** Part shapes in metres. Triangle counts are reported by the benchmark. */
export function partShapes() {
  const plate = new Shape()
    .moveTo(-0.2, -0.15)
    .lineTo(0.2, -0.15)
    .lineTo(0.2, 0.15)
    .lineTo(-0.2, 0.15)
    .lineTo(-0.2, -0.15);
  for (const [x, y] of [
    [-0.16, -0.11],
    [0.16, -0.11],
    [0.16, 0.11],
    [-0.16, 0.11],
    [-0.06, -0.11],
    [0.06, -0.11],
    [0.06, 0.11],
    [-0.06, 0.11],
  ])
    plate.holes.push(hole(x, y, 0.009));
  const bracket = new Shape()
    .moveTo(0, 0)
    .lineTo(0.12, 0)
    .lineTo(0.12, 0.01)
    .lineTo(0.01, 0.01)
    .lineTo(0.01, 0.1)
    .lineTo(0, 0.1)
    .lineTo(0, 0);
  const nut = polygon(6, 0.014);
  nut.holes.push(hole(0, 0, 0.008));
  const washer = new Shape().absarc(0, 0, 0.016, 0, Math.PI * 2, false);
  washer.holes.push(hole(0, 0, 0.0085));
  const head = cylinderGeometry(0.014, 0.014, 0.008, 6),
    shaft = cylinderGeometry(0.008, 0.008, 0.05, 16);
  const bolt = mergeGeometries([
    applyMatrix4(head, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0.004, 0, 1]),
    applyMatrix4(shaft, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.025, 0, 1]),
  ]);
  return {
    plate: upright(extrudeGeometry(plate, { depth: 0.012, curveSegments: 8, bevelEnabled: false })),
    bracket: applyMatrix4(
      extrudeGeometry(bracket, { depth: 0.08, bevelEnabled: false }),
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -0.06, 0, -0.04, 1],
    ),
    bolt,
    nut: upright(
      extrudeGeometry(nut, {
        depth: 0.008,
        curveSegments: 6,
        bevelThickness: 0.001,
        bevelSize: 0.001,
        bevelSegments: 1,
      }),
    ),
    washer: upright(extrudeGeometry(washer, { depth: 0.003, curveSegments: 8, bevelEnabled: false })),
  };
}

export const PARTS_PER_MODULE = 27,
  ENTITIES_PER_MODULE = 30;
/** Builds `modules` modules (27 parts + 3 group nodes each) grouped into zones of 32 modules. Returns parts, groups and the shape table. */
export function buildAssembly(engine, modules, shapes = partShapes()) {
  const geometries = Object.fromEntries(Object.entries(shapes).map(([name, data]) => [name, toGeometry(data)]));
  const materials = {
    plate: new PbrMaterial({ color: '#8d99a6', roughness: 0.5, metalness: 0.6 }),
    bracket: new PbrMaterial({ color: '#4f7cac', roughness: 0.4, metalness: 0.2 }),
    bolt: new PbrMaterial({ color: '#c9ccd1', roughness: 0.3, metalness: 0.9 }),
    nut: new PbrMaterial({ color: '#b0a17a', roughness: 0.35, metalness: 0.9 }),
    washer: new PbrMaterial({ color: '#d8d8d8', roughness: 0.3, metalness: 0.9 }),
  };
  const parts = [],
    groups = [],
    root = engine.createMesh();
  groups.push(root);
  const columns = Math.ceil(Math.sqrt(modules)),
    spacing = 0.55;
  let zone;
  const part = (parent, name, position, rotation) => {
    const mesh = engine
      .createMesh(parent)
      .setGeometry(geometries[name])
      .setMaterial(materials[name])
      .setPosition(position);
    if (rotation) mesh.setRotation(rotation);
    mesh.name = name;
    parts.push(mesh);
    return mesh;
  };
  for (let m = 0; m < modules; m++) {
    if (m % 32 === 0) {
      zone = engine.createMesh(root);
      zone.name = 'zone';
      groups.push(zone);
    }
    const module = engine
      .createMesh(zone)
      .setPosition([((m % columns) - columns / 2) * spacing, 0, (Math.floor(m / columns) - columns / 2) * spacing])
      .setRotation([0, ((m % 4) * Math.PI) / 2, 0]);
    module.name = 'module';
    groups.push(module);
    part(module, 'plate', [0, 0, 0]);
    part(module, 'bracket', [-0.08, 0.012, 0], [0, 0, 0]);
    part(module, 'bracket', [0.08, 0.012, 0], [0, Math.PI, 0]);
    for (const side of [-1, 1]) {
      const set = engine.createMesh(module).setPosition([0, 0, side * 0.11]);
      set.name = 'fasteners';
      groups.push(set);
      for (const x of [-0.16, -0.06, 0.06, 0.16]) {
        part(set, 'bolt', [x, 0.02, 0]);
        part(set, 'washer', [x, -0.003, 0]);
        part(set, 'nut', [x, -0.013, 0]);
      }
    }
  }
  return { root, parts, groups, geometries, materials, extent: columns * spacing };
}
