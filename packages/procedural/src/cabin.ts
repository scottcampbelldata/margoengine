import { boxGeometry, cylinderGeometry } from '@margoengine/geometry/primitives';
import { extrudeGeometry } from '@margoengine/geometry/extrude';
import { Shape } from '@margoengine/geometry/shapes';
import { mergeGeometries, computeTangents, applyMatrix4, type GeometryData } from '@margoengine/geometry/utils';

import type { HeightField } from '@margoengine/math';

export type { HeightField };
/** Cabin placement metadata and independently materialled geometry parts. */
export interface CabinMesh {
  /** World Y of the local floor origin. Apply [position.x, floorElevation, position.z] to every part. */
  floorElevation: number;
  /** Every value is GeometryData, safe to iterate without filtering metadata. */
  parts: { siding: GeometryData; roof: GeometryData; foundation: GeometryData; glass: GeometryData };
}
/** Roof slope of `generateCabinMesh` in radians (35 degrees). */
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

/** A log of `segments` facets, `length` long along local Y, cut flat to keep only `lo <= x <= hi` of its cross-section
 * (x across the log, relative to its axis; `placed` with roll pi / 2 turns local x into world Y). The facets are the
 * full log's, so the cut log continues its neighbours; its sides shade as the log's (the circle's vertex normals) and
 * the cut is a flat face. */
function cutLog(r: number, segments: number, length: number, lo: number, hi: number): GeometryData {
  // Cross-section vertices [x, z, nx, nz, cut], placed as cylinderGeometry places them: (r sin a, r cos a). `cut` is
  // 1 on the lower cut, -1 on the upper one, 0 on the circle.
  let ring: number[][] = [];
  for (let k = 0; k < segments; k++) {
    const a = (k / segments) * 2 * Math.PI;
    ring.push([r * Math.sin(a), r * Math.cos(a), Math.sin(a), Math.cos(a), 0]);
  }
  // Sutherland and Hodgman (1974): clip the convex polygon against x >= lo, then x <= hi.
  for (const [edge, side] of [
    [lo, 1],
    [hi, -1],
  ]) {
    const out: number[][] = [];
    for (let k = 0; k < ring.length; k++) {
      const p = ring[k],
        q = ring[(k + 1) % ring.length],
        pin = side * (p[0] - edge) >= 0,
        qin = side * (q[0] - edge) >= 0;
      if (pin) out.push(p);
      if (pin !== qin) {
        const t = (edge - p[0]) / (q[0] - p[0]),
          nx = p[2] + t * (q[2] - p[2]),
          nz = p[3] + t * (q[3] - p[3]),
          n = Math.hypot(nx, nz);
        out.push([edge, p[1] + t * (q[1] - p[1]), nx / n, nz / n, side]);
      }
    }
    ring = out;
  }
  const positions: number[] = [],
    normals: number[] = [],
    uvs: number[] = [],
    indices: number[] = [],
    h = length / 2;
  const vertex = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number) => {
    positions.push(x, y, z);
    normals.push(nx, ny, nz);
    uvs.push(u, v);
    return positions.length / 3 - 1;
  };
  // A triangle wound counter-clockwise seen from the side `n` points to.
  const tri = (a: number, b: number, c: number, n: readonly number[]) => {
    const P = (i: number, k: number) => positions[i * 3 + k],
      e1 = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)],
      e2 = [P(c, 0) - P(a, 0), P(c, 1) - P(a, 1), P(c, 2) - P(a, 2)],
      d =
        (e1[1] * e2[2] - e1[2] * e2[1]) * n[0] +
        (e1[2] * e2[0] - e1[0] * e2[2]) * n[1] +
        (e1[0] * e2[1] - e1[1] * e2[0]) * n[2];
    indices.push(...(d >= 0 ? [a, b, c] : [a, c, b]));
  };
  for (let k = 0; k < ring.length; k++) {
    const p = ring[k],
      q = ring[(k + 1) % ring.length],
      cut = p[4] !== 0 && p[4] === q[4],
      // The flat cut faces away from the kept part: -x on the lower cut, +x on the upper one.
      np = cut ? [-p[4], 0, 0] : [p[2], 0, p[3]],
      nq = cut ? np : [q[2], 0, q[3]],
      u0 = k / ring.length,
      u1 = (k + 1) / ring.length,
      a = vertex(p[0], -h, p[1], np[0], 0, np[2], u0, 0),
      b = vertex(q[0], -h, q[1], nq[0], 0, nq[2], u1, 0),
      c = vertex(q[0], h, q[1], nq[0], 0, nq[2], u1, 1),
      d = vertex(p[0], h, p[1], np[0], 0, np[2], u0, 1),
      out = cut ? np : [p[0] + q[0], 0, p[1] + q[1]];
    tri(a, b, c, out);
    tri(a, c, d, out);
  }
  for (const sign of [-1, 1]) {
    const first = positions.length / 3;
    for (const p of ring) vertex(p[0], sign * h, p[1], 0, sign, 0, 0.5 + p[0] / (2 * r), 0.5 - (sign * p[1]) / (2 * r));
    for (let k = 1; k + 1 < ring.length; k++) tri(first, first + k, first + k + 1, [0, sign, 0]);
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint32Array(indices),
  };
}

/** Options of `generateLogWall`. Lengths are metres in the wall's local frame: logs run along X, Y is up, Z is the
 * wall's thickness centred on 0. */
export interface LogWallOptions {
  /** Each course's `[start, end]` along X, bottom course first. A course whose end is not past its start is left
   * empty, so a gable's courses can stop before the list does. 1..256 courses. */
  courses: readonly (readonly [number, number])[];
  /** Log diameter, which is also the course pitch, 0.01..10. Default 0.3. */
  diameter?: number;
  /** Centre height of the bottom course. Default `diameter / 2`, the bottom log resting on y = 0. */
  bottom?: number;
  /** Openings `[x0, x1, y0, y1]` (use -Infinity for a door's sill), cut out exactly: a log wholly inside `y0..y1` is
   * cut away over `x0..x1`, and a log the opening's top or bottom edge crosses keeps the part outside it, cut flat
   * along the edge, as a builder notches a log over a door. At most 64, not overlapping. Default none. */
  openings?: readonly (readonly [number, number, number, number])[];
  /** Radial segments of each log, 3..64. Default 14. */
  segments?: number;
  /** Close the wall down to y = 0 when it stands on the ground (its bottom course's underside less than a diameter
   * up). Notched corners raise two of a cabin's four walls half a log, and builders start those walls on a sill: a
   * log hewn flat underneath (the half-log starter course), so the default puts one under the bottom course, cut
   * to y = 0 and chinked to the course above. A bottom course resting on y = 0 is chinked to the ground under its
   * facets. `false` leaves the gap for a foundation built up to the bottom course (stone piers or a raised
   * foundation). A wall whose bottom course is a diameter or more up (a gable set on another wall) never gets one.
   * Default true. */
  sill?: boolean;
}

/** A log wall: stacked round logs with chinking between the courses, as one geometry. A faceted log's flat sits
 * `g = r (1 - cos(pi / segments))` inside its circle, so logs stacked at a pitch of `2r` leave a straight slit up to
 * `2g` high through the wall at every course line (0.75 cm for 0.3 m logs of 14 segments), and the sky showed through
 * it as one-pixel lines. Chinking, the strip a log builder packs between courses (Bomberger 1991), closes it: a box
 * `4g` high runs along each course line wherever both logs exist, as deep as fits inside both logs' inscribed
 * circles. It is hidden except where it fills the slit, and every line through the wall between two courses hits it.
 * Pieces shorter than a tenth of the diameter are dropped. */
export function generateLogWall(options: LogWallOptions): GeometryData {
  const { courses, diameter = 0.3, openings = [], segments = 14, sill = true } = options ?? ({} as LogWallOptions),
    bottom = options?.bottom ?? diameter / 2,
    finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (
    !Array.isArray(courses) ||
    courses.length < 1 ||
    courses.length > 256 ||
    !courses.every((c) => c?.length === 2 && finite(c[0]) && finite(c[1])) ||
    !finite(diameter) ||
    diameter < 0.01 ||
    diameter > 10 ||
    !finite(bottom) ||
    !Number.isInteger(segments) ||
    segments < 3 ||
    segments > 64 ||
    !Array.isArray(openings) ||
    openings.length > 64 ||
    !openings.every(
      (o) => o?.length === 4 && finite(o[0]) && finite(o[1]) && !Number.isNaN(o[2]) && !Number.isNaN(o[3]),
    )
  )
    throw new RangeError(
      'Invalid log wall; pass 1..256 finite [start, end] courses, a diameter of 0.01..10, 3..64 segments and at most 64 [x0, x1, y0, y1] openings.',
    );
  const r = diameter / 2,
    c = Math.cos(Math.PI / segments),
    gap = r * (1 - c),
    // A corner (depth / 2, 2 gap) of the chink lies inside the inscribed circle of radius r c centred r above it.
    depth = 1.6 * r * Math.sqrt((1 - c) * (3 * c - 1)),
    parts: GeometryData[] = [],
    pieces: (readonly [number, number])[][] = [],
    // KB-CABIN-SIDEWALL-LEAK1: Cabin Hearth's side walls start half a log up, notched over the front and back walls,
    // and the firelight showed on the snow through the gap under them. A wall standing on the ground is closed down
    // to y = 0: `lift` is its bottom course's underside above y = 0. Above a facet's depth a sill log, a log one
    // pitch below the bottom course hewn flat at y = 0 (`lo`, its kept cross-section's lower edge), fills the gap;
    // under that, chinking beds the bottom course on the ground.
    lift = bottom - r,
    ground = sill && lift > -1e-9 * diameter && lift < diameter,
    rows: [y: number, span: readonly [number, number], lo: number][] = courses.map((span, i) => [
      bottom + i * diameter,
      span,
      -r,
    ]);
  if (ground && lift > gap) rows.unshift([bottom - diameter, courses[0], diameter - bottom]);
  rows.forEach(([y, [start, end], base], i) => {
    let spans: [number, number][] = end > start ? [[start, end]] : [];
    // KB-CABIN-DOORLEAK1: a log only partly inside an opening was cut away whole, so Cabin Hearth's door to 2.15 m in
    // 0.3 m courses opened to 2.4 m and the lit room showed through a strip above the door. Such a log now keeps the
    // part outside the opening: [x0, x1, lo, hi], its kept cross-section relative to the log's axis.
    const notches: [number, number, number, number][] = [];
    for (const [x0, x1, y0, y1] of openings)
      if (y + r > y0 && y + base < y1) {
        spans = spans.flatMap(([a, b]): [number, number][] =>
          x1 <= a || x0 >= b
            ? [[a, b]]
            : [
                [a, Math.max(a, x0)],
                [Math.min(b, x1), b],
              ],
        );
        const from = Math.max(x0, start),
          to = Math.min(x1, end);
        if (to - from < diameter / 10) continue;
        if (y0 > y + base) notches.push([from, to, base, y0 - y]);
        if (y1 < y + r) notches.push([from, to, Math.max(base, y1 - y), r]);
      }
    const kept = spans.filter(([a, b]) => b - a >= diameter / 10);
    for (const [a, b] of kept)
      parts.push(
        placed(
          base > -r ? cutLog(r, segments, b - a, base, r) : cylinderGeometry(r, r, b - a, segments, 1),
          (a + b) / 2,
          y,
          0,
          1,
          1,
          1,
          0,
          Math.PI / 2,
        ),
      );
    for (const [a, b, lo, hi] of notches)
      parts.push(placed(cutLog(r, segments, b - a, lo, hi), (a + b) / 2, y, 0, 1, 1, 1, 0, Math.PI / 2));
    // Chinking joins a log's top to the next course's underside wherever both are there.
    const span = ([a, b]: readonly number[]): [number, number] => [a, b],
      top = [...kept, ...notches.filter((n) => n[3] === r).map(span)],
      under = [...(base > -r ? [] : kept), ...notches.filter((n) => n[2] === -r).map(span)];
    pieces.push(top);
    if (i > 0)
      for (const [a, b] of pieces[i - 1])
        for (const [p, q] of under) {
          const from = Math.max(a, p),
            to = Math.min(b, q);
          if (to > from) parts.push(placed(boxGeometry(to - from, 4 * gap, depth), (from + to) / 2, y - r, 0));
        }
    // The bottom course on the ground: its lowest facet sits up to `lift + gap` above y = 0, and a chink as deep as
    // the course chinks, up to `lift + 2 gap`, fills that and stays inside the log's inscribed circle.
    else if (ground && lift <= gap)
      for (const [a, b] of under)
        parts.push(placed(boxGeometry(b - a, lift + 2 * gap, depth), (a + b) / 2, (lift + 2 * gap) / 2, 0));
  });
  if (!parts.length) throw new RangeError('Invalid log wall; every course is empty or cut away by the openings.');
  return mergeGeometries(parts);
}

/** Split box faces and gables preserve area-weighted face normals at every architectural edge. */
export function generateCabinMesh(height: HeightField, position: readonly [number, number] = [0, 0]): CabinMesh {
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
    throw new RangeError(
      'Invalid cabin terrain or position; pass a height(x, z) function and a finite [x, z] position.',
    );
  const [cx, cz] = position;
  const sample = (x: number, z: number) => {
    const value = height(x, z);
    if (!Number.isFinite(Math.fround(value)))
      throw new RangeError('Invalid cabin terrain height; height(x, z) must return a finite number.');
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
    floorElevation: floor,
    parts: {
      siding: computeTangents(mergeGeometries(timber)),
      roof: computeTangents(mergeGeometries(slate)),
      foundation: computeTangents(mergeGeometries(stone)),
      glass: computeTangents(mergeGeometries(glass)),
    },
  };
}
