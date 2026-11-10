/** Colour and covalent radius in angstroms of the common elements. Other elements draw pink at 1.5. */
const ELEMENTS: Record<string, [number, number]> = Object.assign(Object.create(null), {
  H: [0xffffff, 0.31],
  C: [0x909090, 0.76],
  N: [0x3050f8, 0.71],
  O: [0xff0d0d, 0.66],
  F: [0x90e050, 0.57],
  NA: [0xab5cf2, 1.66],
  MG: [0x8aff00, 1.41],
  P: [0xff8000, 1.07],
  S: [0xffff30, 1.05],
  CL: [0x1ff01f, 1.02],
  K: [0x8f40d4, 2.03],
  CA: [0x3dff00, 1.76],
  MN: [0x9c7ac7, 1.39],
  FE: [0xe06633, 1.32],
  CO: [0xf090a0, 1.26],
  NI: [0x50d050, 1.24],
  CU: [0xc88033, 1.32],
  ZN: [0x7d80b0, 1.22],
  SE: [0xffa100, 1.2],
  BR: [0xa62929, 1.2],
  I: [0x940094, 1.39],
});
const OTHER: [number, number] = [0xff1493, 1.5];
/** Slack added to two covalent radii when finding bonds by distance. */
const BOND_SLACK = 0.45;

/** Every pair of atoms close enough for their radii, through a grid of the largest bond length. */
export function nearbyPairs(positions: Float32Array, radii: Float32Array, add: (a: number, b: number) => void): void {
  let largest = 0;
  for (const radius of radii) largest = Math.max(largest, radius);
  const cell = largest * 2 + BOND_SLACK,
    grid = new Map<string, number[]>(),
    id = (x: number, y: number, z: number): string => `${x} ${y} ${z}`;
  for (let i = 0; i < radii.length; i++) {
    const x = Math.floor(positions[i * 3] / cell),
      y = Math.floor(positions[i * 3 + 1] / cell),
      z = Math.floor(positions[i * 3 + 2] / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(id(x + dx, y + dy, z + dz)) ?? []) {
            const limit = radii[i] + radii[j] + BOND_SLACK,
              distance = Math.hypot(
                positions[i * 3] - positions[j * 3],
                positions[i * 3 + 1] - positions[j * 3 + 1],
                positions[i * 3 + 2] - positions[j * 3 + 2],
              );
            if (distance > 0.4 && distance <= limit) add(j, i);
          }
    const own = id(x, y, z),
      list = grid.get(own);
    if (list) list.push(i);
    else grid.set(own, [i]);
  }
}

/** Internal element display style and Cordero covalent radius; unknowns use pink and 1.5 angstrom. */
export function elementProperties(symbol: string): [number, number] {
  return ELEMENTS[symbol.toUpperCase()] ?? OTHER;
}
