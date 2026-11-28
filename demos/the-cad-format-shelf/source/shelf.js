import { box, Geometry, PbrMaterial } from '@margoengine/core';

export const deckY = .086;
export const xCentres = { step: -.72, iges: .72 };

function chamfered(width, depth, height, bevel) {
  const x = width / 2, z = depth / 2;
  const profile = [
    [-1,-1], [1,-1], [1,1], [-1,1],
  ];
  const layers = [[-height / 2, 0], [height / 2 - bevel, 0], [height / 2, bevel]].map(
    ([y, inset]) => profile.map(([sx, sz]) => [sx * (x - inset), y, sz * (z - inset)]),
  );
  const xyz = [], normals = [], indices = [];
  function face(points, normal) {
    const start = xyz.length / 3;
    for (const p of points) { xyz.push(...p); normals.push(...normal); }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  for (let level = 1; level < layers.length; level++) {
    const bottom = layers[level - 1], top = layers[level];
    for (let edge = 0; edge < 4; edge++) {
      const next = (edge + 1) % 4;
      const [a, b] = [profile[edge], profile[next]];
      const slope = level === 2 ? Math.SQRT1_2 : 1;
      face([bottom[edge], top[edge], top[next], bottom[next]], [
        slope * (a[0] + b[0]) / 2, level === 2 ? slope : 0, slope * (a[1] + b[1]) / 2,
      ]);
    }
  }
  face(layers[2].slice().reverse(), [0,1,0]);
  face(layers[0], [0,-1,0]);
  return new Geometry(xyz, normals, indices);
}

export function buildShelf(engine) {
  const coat = (color, roughness) => new PbrMaterial({ color, roughness });
  const table = coat('#1e3038', .73);
  const casework = coat('#455352', .47);
  const inset = coat('#596a67', .80);
  const rule = coat('#a68356', .52);
  const stamp = coat('#bda87e', .64);
  const mesh = (geometry, material, position) => engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  mesh(box(21, .096, 19), table, [0, -.096, .15]);
  const floor = chamfered(2.87, 1.26, .135, .048);
  const casters = [mesh(floor, casework, [0, -.007, .030])];
  const sub = chamfered(1.22, .93, .070, .029);
  const fine = box(1.17, .007, .012);
  const rail = box(1.04, .002, .006);
  const measure = box(.003, .002, .019);
  for (const x of Object.values(xCentres)) {
    casters.push(mesh(sub, inset, [x, .048, -.004]));
    mesh(fine, rule, [x, .061, .480]);
    mesh(rail, stamp, [x, .087, .345]);
    for (let tick = 0; tick <= 20; tick++) mesh(measure, stamp, [x + tick * .052 - .52, .088, .346]);
  }
  mesh(box(.015, .005, .94), rule, [0,.062,.040]);
  return casters;
}
