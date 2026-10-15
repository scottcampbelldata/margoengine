import {
  boxGeometry,
  cylinderGeometry,
  extrudeGeometry,
  Shape,
  mergeGeometries,
  computeTangents,
  applyMatrix4,
  type GeometryData,
} from '@margoengine/geometry';

export type HeightField = (x: number, z: number) => number;
export const ROOF_PITCH = (35 * Math.PI) / 180;

function placed(
  data: GeometryData,
  x: number,
  y: number,
  z: number,
  sx = 1,
  sy = 1,
  sz = 1,
  yaw = 0,
  roll = 0,
): GeometryData {
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    a = Math.cos(roll),
    b = Math.sin(roll);
  return applyMatrix4(data, [
    c * a * sx,
    b * sx,
    -s * a * sx,
    0,
    -c * b * sy,
    a * sy,
    s * b * sy,
    0,
    s * sz,
    0,
    c * sz,
    0,
    x,
    y,
    z,
    1,
  ]);
}

/** Split box faces and gables preserve area-weighted face normals at every architectural edge. */
export function generateCabinMesh(height: HeightField, position: readonly [number, number] = [0, 0]) {
  const timber: GeometryData[] = [],
    slate: GeometryData[] = [],
    stone: GeometryData[] = [],
    glass: GeometryData[] = [];
  if (
    typeof height !== 'function' ||
    position.length !== 2 ||
    !Number.isFinite(Math.fround(position[0])) ||
    !Number.isFinite(Math.fround(position[1]))
  )
    throw new RangeError('Invalid cabin terrain or position');
  const [cx, cz] = position;
  const sample = (x: number, z: number) => {
    const value = height(x, z);
    if (!Number.isFinite(Math.fround(value))) throw new RangeError('Invalid cabin terrain height');
    return value;
  };
  let floor = -Infinity;
  for (let z = -4.3; z <= 6.6; z += 0.3)
    for (let x = -3.3; x <= 3.3; x += 0.3) {
      const ground = sample(cx + x, cz + z);
      floor = Math.max(floor, ground + 0.28);
    }
  const block = (
    list: GeometryData[],
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    yaw = 0,
    roll = 0,
  ) => list.push(placed(boxGeometry(w, h, d), x, y, z, 1, 1, 1, yaw, roll));
  // Openings are cut through the siding; inner panels sit behind the jambs, not on the wall surface.
  const wall = (
    width: number,
    x: number,
    z: number,
    yaw: number,
    holes: readonly (readonly [number, number, number, number, boolean])[],
  ) => {
    const c = Math.cos(yaw),
      s = Math.sin(yaw);
    const piece = (
      list: GeometryData[],
      u: number,
      y: number,
      depth: number,
      w: number,
      h: number,
      d: number,
      cladding = false,
    ) => {
      // Overlap identical wall faces to cover raster cracks at T-junctions.
      const overlap = cladding ? 0.002 : 0,
        data = boxGeometry(w + overlap, h + overlap, d);
      // shortcut: trim closes cladding edges; add interior wall returns for enterable cabins.
      if (cladding) data.indices = data.indices.filter((v) => Math.abs(data.normals[v * 3 + 2]) > 0.99);
      list.push(placed(data, x + c * u + s * depth, y, z - s * u + c * depth, 1, 1, 1, yaw));
    };
    for (let row = 0; row < 15; row++) {
      const bottom = row * 0.2,
        top = (row + 1) * 0.2;
      let start = -width / 2;
      for (const [u, v, w, h] of holes) {
        const left = u - w / 2,
          right = u + w / 2;
        if (left > start)
          piece(timber, (start + left) / 2, (bottom + top) / 2, 0, left - start, top - bottom, 0.22, true);
        const low = Math.min(top, v - h / 2),
          high = Math.max(bottom, v + h / 2);
        if (low > bottom) piece(timber, u, (bottom + low) / 2, 0, w, low - bottom, 0.22, true);
        if (high < top) piece(timber, u, (high + top) / 2, 0, w, top - high, 0.22, true);
        start = right;
      }
      if (start < width / 2)
        piece(timber, (start + width / 2) / 2, (bottom + top) / 2, 0, width / 2 - start, top - bottom, 0.22, true);
    }
    for (const [u, v, w, h, door] of holes) {
      const trim = door ? 0.075 : 0.05;
      // Flush exterior casings avoid subpixel dark edges; panes remain recessed.
      for (const side of [-1, 1]) piece(timber, u + (side * w) / 2, v, 0.01, trim, h + trim, 0.2);
      for (const side of [-1, 1]) piece(timber, u, v + (side * h) / 2, 0.01, w - trim, trim, 0.2);
      piece(door ? timber : glass, u, v, door ? -0.08 : 0.02, w - trim, h - trim, 0.02);
    }
  };
  wall(6, 0, 4, 0, [
    [-1.5, 1.85, 0.9, 1.1, false],
    [0.9, 1.15, 1.15, 2.3, true],
  ]);
  wall(6, 0, -4, Math.PI, [[0, 1.85, 0.9, 1.1, false]]);
  for (const side of [-1, 1])
    wall(8, side * 3, 0, (side * Math.PI) / 2, [
      [-1.8, 1.85, 0.9, 1.1, false],
      [1.8, 1.85, 0.9, 1.1, false],
    ]);
  for (const x of [-3, 3]) for (const z of [-4, 4]) block(timber, x, 1.5, z, 0.28, 3, 0.28);
  const rise = 3 * Math.tan(ROOF_PITCH);
  // Solid gables meet both siding faces and overlap the roof underside to close oblique sightlines.
  const peak = 3 + rise + 0.03,
    base = peak - 3.12 * Math.tan(ROOF_PITCH);
  const gable = extrudeGeometry(
    new Shape([
      [-3.12, base],
      [3.12, base],
      [0, peak],
    ]),
    { depth: 0.22, bevelEnabled: false },
  );
  for (const side of [-1, 1]) {
    timber.push(placed(gable, 0, 0, side * 4 - 0.11));
    // Overlapping courses give the roof a shingle silhouette without a texture download.
    for (let row = 0; row < 12; row++) {
      const u = ((row + 0.5) * 3.55) / 12;
      block(
        slate,
        side * u,
        3 + rise - u * Math.tan(ROOF_PITCH) + 0.05 + (12 - row) * 0.002,
        0,
        3.55 / 12 / Math.cos(ROOF_PITCH) + 0.035,
        0.1,
        9.1,
        0,
        -side * ROOF_PITCH,
      );
    }
    block(timber, side * 3.55, 3 + rise - 3.55 * Math.tan(ROOF_PITCH) - 0.07, 0, 0.14, 0.18, 9.1);
    for (const z of [-4.54, 4.54])
      block(
        timber,
        side * 1.775,
        3 + rise - 1.775 * Math.tan(ROOF_PITCH) - 0.02,
        z,
        3.55 / Math.cos(ROOF_PITCH),
        0.17,
        0.14,
        0,
        -side * ROOF_PITCH,
      );
  }
  block(slate, 0, 3 + rise + 0.1, 0, 0.22, 0.14, 9.15);
  block(timber, 0, -0.04, 0, 5.85, 0.16, 7.85);
  block(stone, 0, -0.34, 0, 6.4, 0.6, 8.4);
  block(timber, 0.9, -0.02, 5, 2.5, 0.2, 2);
  const porchPitch = Math.PI / 18,
    porchCos = Math.cos(porchPitch);
  const porchRoofAtBeam = 2.73 - (5.9 - 5.05) * Math.tan(porchPitch);
  // Buried overlaps close the pitched beam joint and the flat post caps without raster cracks.
  const beamCenter = porchRoofAtBeam - (0.1 + 0.16) / 2 / porchCos + 0.002;
  const postTop = beamCenter - 0.16 / 2 / porchCos + 0.02;
  for (const x of [-0.15, 1.95]) {
    const bottom = sample(cx + x, cz + 5.9) - floor - 0.25;
    timber.push(placed(cylinderGeometry(0.1, 0.13, postTop - bottom, 8), x, (postTop + bottom) / 2, 5.9));
  }
  block(timber, 0.9, beamCenter, 5.9, 0.18 / porchCos, 0.16, 2.5, Math.PI / 2, porchPitch);
  block(slate, 0.9, 2.73, 5.05, 2.4 / porchCos, 0.1, 2.9, Math.PI / 2, porchPitch);
  for (let z = -4; z <= 4; z += 1)
    for (const x of [-3, 3]) {
      const bottom = sample(cx + x, cz + z) - floor - 0.45;
      block(stone, x, bottom / 2 - 0.08, z, 0.55, -bottom, 1.02);
    }
  for (const z of [-4, 4])
    for (let x = -2.5; x <= 2.5; x += 1) {
      const bottom = sample(cx + x, cz + z) - floor - 0.45;
      block(stone, x, bottom / 2 - 0.08, z, 1.02, -bottom, 0.55);
    }
  for (let step = 0; step < 2; step++) {
    const z = 6.15 + step * 0.35,
      top = -0.2 - step * 0.18,
      bottom = sample(cx + 0.9, cz + z) - floor - 0.4;
    block(stone, 0.9, (top + bottom) / 2, z, 1.55, Math.max(0.12, top - bottom), 0.4);
  }
  return {
    floor,
    siding: computeTangents(mergeGeometries(timber)),
    roof: computeTangents(mergeGeometries(slate)),
    foundation: computeTangents(mergeGeometries(stone)),
    glass: computeTangents(mergeGeometries(glass)),
  };
}
