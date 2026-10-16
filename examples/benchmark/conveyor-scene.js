// The two engines consume the same hierarchy, geometry and material definitions.
export const ROLLERS = 3000,
  ENTITY_COUNT = 12014;
export function conveyorScene() {
  const nodes = [
      {
        name: 'Conveyor_Assembly',
        parent: -1,
        position: [0, 0, 0],
        scale: [1, 1, 1],
      },
    ],
    shafts = [];
  const add = (name, position, scale, geometry, material, parent = 0) => {
    const id = nodes.length;
    nodes.push({ name, parent, position, scale, geometry, material });
    return id;
  };
  for (const z of [-1.1, 1.1]) {
    add('Rail_' + z, [0, 0.55, z], [6.5, 0.3, 0.15], 'box', 1);
    for (const x of [-2.6, 2.6]) add('Support_' + x + '_' + z, [x, -0.1, z], [0.2, 1.4, 0.2], 'box', 1);
  }
  for (let i = 0; i < ROLLERS; i++) {
    const assembly = add('Roller_Assembly_' + i, [-3 + (6 * i) / (ROLLERS - 1), 0.65, 0], [1, 1, 1]);
    shafts.push(add('Roller_' + i, [0, 0, 0], [0.18, 0.18, 2.1], 'cylinder', 0, assembly));
    for (const z of [-1.17, 1.17])
      add('Mount_Bolt_' + i + '_' + z, [0, 0, z], [0.06, 0.06, 0.12], 'cylinder', 0, assembly);
  }
  add('Conveyor_Belt', [0, 0.84, 0], [6.2, 0.06, 2.08], 'box', 2);
  const cover = add('Drive_Cover_Assembly', [-2.5, 0.8, 1.35], [1, 1, 1]);
  add('Drive_Cover', [0, 0, 0], [0.95, 0.65, 0.25], 'box', 1, cover);
  for (const x of [-0.38, 0.38]) add('Cover_Bolt_' + x, [x, 0.2, 0.16], [0.05, 0.05, 0.08], 'cylinder', 0, cover);
  add('Linear_Carriage', [0, 1.1, 0], [0.7, 0.25, 0.6], 'box', 1);
  const motor = add('Motor', [-2.5, 0.45, 1.45], [0.28, 0.28, 0.8], 'cylinder', 0);
  if (nodes.length !== ENTITY_COUNT) throw new Error('Conveyor entity count changed');
  const positions = [],
    normals = [],
    indices = [];
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI) / 12,
      b = ((i + 1) * Math.PI) / 12,
      start = positions.length / 3;
    for (const [angle, z] of [
      [a, -0.5],
      [b, -0.5],
      [b, 0.5],
      [a, 0.5],
    ]) {
      positions.push(Math.cos(angle), Math.sin(angle), z);
      normals.push(Math.cos(angle), Math.sin(angle), 0);
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    for (const z of [-0.5, 0.5]) {
      const at = positions.length / 3;
      for (const [x, y] of [
        [0, 0],
        [Math.cos(a), Math.sin(a)],
        [Math.cos(b), Math.sin(b)],
      ]) {
        positions.push(x, y, z);
        normals.push(0, 0, Math.sign(z));
      }
      indices.push(...(z > 0 ? [at, at + 1, at + 2] : [at, at + 2, at + 1]));
    }
  }
  return {
    nodes,
    shafts,
    motor,
    cylinder: {
      positions: new Float32Array(positions),
      normals: new Float32Array(normals),
      indices: new Uint32Array(indices),
    },
    materials: [
      { color: [0.45, 0.48, 0.52], roughness: 0.24, metalness: 0.85 },
      { color: [0.05, 0.15, 0.12], roughness: 0.65, metalness: 0.2 },
      { color: [0.03, 0.03, 0.03], roughness: 0.95, metalness: 0 },
    ],
  };
}
