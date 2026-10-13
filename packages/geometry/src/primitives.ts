import {geometryData, type GeometryData, type GeometryGroup} from './data.js';
import type {Curve} from './curve.js';
import {finiteNumber, type Vec, type Vec2} from './math.js';

const TAU = Math.PI * 2;
const segments = (value: number, min: number) => Math.max(min, Math.floor(finiteNumber(value)));

class Builder {
  p: number[] = []; n: number[] = []; uv: number[] = []; idx: number[] = []; groups: GeometryGroup[] = [];
  get count(): number {return this.p.length / 3;}
  vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  /** Pushes a normalized normal. */
  vertexN(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    const l = Math.hypot(nx, ny, nz) || 1;
    return this.vertex(x, y, z, nx / l, ny / l, nz / l, u, v);
  }
  group(start: number, materialIndex: number): void {this.groups.push({start, count: this.idx.length - start, materialIndex});}
  build(withGroups = false): GeometryData {return geometryData(this.p, this.n, this.uv, this.idx, withGroups ? this.groups : undefined);}
}

/** Three.js `BoxGeometry`. Six groups, one per face (+x, -x, +y, -y, +z, -z). */
export function boxGeometry(width = 1, height = 1, depth = 1, widthSegments = 1, heightSegments = 1, depthSegments = 1): GeometryData {
  const b = new Builder();
  widthSegments = segments(widthSegments, 1); heightSegments = segments(heightSegments, 1); depthSegments = segments(depthSegments, 1);
  const plane = (u: number, v: number, w: number, udir: number, vdir: number, pw: number, ph: number, pd: number, gridX: number, gridY: number, material: number) => {
    const start = b.idx.length, base = b.count, gridX1 = gridX + 1;
    for (let iy = 0; iy <= gridY; iy++) {
      const y = iy * ph / gridY - ph / 2;
      for (let ix = 0; ix <= gridX; ix++) {
        const x = ix * pw / gridX - pw / 2, p = [0, 0, 0], n = [0, 0, 0];
        p[u] = x * udir; p[v] = y * vdir; p[w] = pd / 2; n[w] = pd > 0 ? 1 : -1;
        b.vertex(p[0], p[1], p[2], n[0], n[1], n[2], ix / gridX, 1 - iy / gridY);
      }
    }
    for (let iy = 0; iy < gridY; iy++) for (let ix = 0; ix < gridX; ix++) {
      const a = base + ix + gridX1 * iy, bb = base + ix + gridX1 * (iy + 1), c = base + ix + 1 + gridX1 * (iy + 1), d = base + ix + 1 + gridX1 * iy;
      b.idx.push(a, bb, d, bb, c, d);
    }
    b.group(start, material);
  };
  plane(2, 1, 0, -1, -1, depth, height, width, depthSegments, heightSegments, 0);
  plane(2, 1, 0, 1, -1, depth, height, -width, depthSegments, heightSegments, 1);
  plane(0, 2, 1, 1, 1, width, depth, height, widthSegments, depthSegments, 2);
  plane(0, 2, 1, 1, -1, width, depth, -height, widthSegments, depthSegments, 3);
  plane(0, 1, 2, 1, -1, width, height, depth, widthSegments, heightSegments, 4);
  plane(0, 1, 2, -1, -1, width, height, -depth, widthSegments, heightSegments, 5);
  return b.build(true);
}

/** Three.js `PlaneGeometry`, in the XY plane facing +z. */
export function planeGeometry(width = 1, height = 1, widthSegments = 1, heightSegments = 1): GeometryData {
  const b = new Builder(), gridX = segments(widthSegments, 1), gridY = segments(heightSegments, 1), gridX1 = gridX + 1;
  for (let iy = 0; iy <= gridY; iy++) {
    const y = iy * height / gridY - height / 2;
    for (let ix = 0; ix <= gridX; ix++) b.vertex(ix * width / gridX - width / 2, -y, 0, 0, 0, 1, ix / gridX, 1 - iy / gridY);
  }
  for (let iy = 0; iy < gridY; iy++) for (let ix = 0; ix < gridX; ix++) {
    const a = ix + gridX1 * iy, bb = ix + gridX1 * (iy + 1), c = ix + 1 + gridX1 * (iy + 1), d = ix + 1 + gridX1 * iy;
    b.idx.push(a, bb, d, bb, c, d);
  }
  return b.build();
}

/** Three.js `CircleGeometry`: a center vertex plus `segments + 1` rim vertices, facing +z. */
export function circleGeometry(radius = 1, segmentCount = 32, thetaStart = 0, thetaLength = TAU): GeometryData {
  const b = new Builder(), n = segments(segmentCount, 3);
  b.vertex(0, 0, 0, 0, 0, 1, 0.5, 0.5);
  for (let s = 0; s <= n; s++) {
    const a = thetaStart + s / n * thetaLength, x = radius * Math.cos(a), y = radius * Math.sin(a);
    b.vertex(x, y, 0, 0, 0, 1, (x / radius + 1) / 2, (y / radius + 1) / 2);
  }
  for (let i = 1; i <= n; i++) b.idx.push(i, i + 1, 0);
  return b.build();
}

/** Three.js `RingGeometry`, facing +z. */
export function ringGeometry(innerRadius = 0.5, outerRadius = 1, thetaSegments = 32, phiSegments = 1, thetaStart = 0, thetaLength = TAU): GeometryData {
  const b = new Builder(), ts = segments(thetaSegments, 3), ps = segments(phiSegments, 1), step = (outerRadius - innerRadius) / ps;
  let radius = innerRadius;
  for (let j = 0; j <= ps; j++) {
    for (let i = 0; i <= ts; i++) {
      const a = thetaStart + i / ts * thetaLength, x = radius * Math.cos(a), y = radius * Math.sin(a);
      b.vertex(x, y, 0, 0, 0, 1, (x / outerRadius + 1) / 2, (y / outerRadius + 1) / 2);
    }
    radius += step;
  }
  for (let j = 0; j < ps; j++) for (let i = 0; i < ts; i++) {
    const s = i + j * (ts + 1), a = s, bb = s + ts + 1, c = s + ts + 2, d = s + 1;
    b.idx.push(a, bb, d, bb, c, d);
  }
  return b.build();
}

/**
 * Three.js `CylinderGeometry` along +y. Groups: 0 side, 1 top cap, 2 bottom cap. A zero radius drops that cap and
 * the degenerate side triangles, so a cone has a single apex row of triangles.
 */
export function cylinderGeometry(radiusTop = 1, radiusBottom = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = TAU): GeometryData {
  const b = new Builder(), rs = segments(radialSegments, 1), hs = segments(heightSegments, 1), half = height / 2, slope = (radiusBottom - radiusTop) / height;
  const rows: number[][] = [];
  for (let y = 0; y <= hs; y++) {
    const row: number[] = [], v = y / hs, radius = v * (radiusBottom - radiusTop) + radiusTop;
    for (let x = 0; x <= rs; x++) {
      const u = x / rs, theta = u * thetaLength + thetaStart, s = Math.sin(theta), c = Math.cos(theta);
      row.push(b.vertexN(radius * s, -v * height + half, radius * c, s, slope, c, u, 1 - v));
    }
    rows.push(row);
  }
  for (let x = 0; x < rs; x++) for (let y = 0; y < hs; y++) {
    const a = rows[y][x], bb = rows[y + 1][x], c = rows[y + 1][x + 1], d = rows[y][x + 1];
    if (radiusTop > 0 || y !== 0) b.idx.push(a, bb, d);
    if (radiusBottom > 0 || y !== hs - 1) b.idx.push(bb, c, d);
  }
  b.group(0, 0);
  const cap = (top: boolean) => {
    const start = b.idx.length, radius = top ? radiusTop : radiusBottom, sign = top ? 1 : -1, centers = b.count;
    for (let x = 1; x <= rs; x++) b.vertex(0, half * sign, 0, 0, sign, 0, 0.5, 0.5);
    const rim = b.count;
    for (let x = 0; x <= rs; x++) {
      const theta = x / rs * thetaLength + thetaStart, s = Math.sin(theta), c = Math.cos(theta);
      b.vertex(radius * s, half * sign, radius * c, 0, sign, 0, c * 0.5 + 0.5, s * 0.5 * sign + 0.5);
    }
    for (let x = 0; x < rs; x++) {
      const c = centers + x, i = rim + x;
      if (top) b.idx.push(i, i + 1, c); else b.idx.push(i + 1, i, c);
    }
    b.group(start, top ? 1 : 2);
  };
  if (!openEnded) {if (radiusTop > 0) cap(true); if (radiusBottom > 0) cap(false);}
  return b.build(true);
}

/** Three.js `ConeGeometry`: a cylinder with a zero top radius. */
export function coneGeometry(radius = 1, height = 1, radialSegments = 32, heightSegments = 1, openEnded = false, thetaStart = 0, thetaLength = TAU): GeometryData {
  return cylinderGeometry(0, radius, height, radialSegments, heightSegments, openEnded, thetaStart, thetaLength);
}

/** Three.js `SphereGeometry`. Pole rows emit one triangle per quad, so the full sphere has no degenerate triangles. */
export function sphereGeometry(radius = 1, widthSegments = 32, heightSegments = 16, phiStart = 0, phiLength = TAU, thetaStart = 0, thetaLength = Math.PI): GeometryData {
  const b = new Builder(), w = segments(widthSegments, 3), h = segments(heightSegments, 2), thetaEnd = Math.min(thetaStart + thetaLength, Math.PI);
  const grid: number[][] = [];
  for (let iy = 0; iy <= h; iy++) {
    const row: number[] = [], v = iy / h;
    const uOffset = iy === 0 && thetaStart === 0 ? 0.5 / w : iy === h && thetaEnd === Math.PI ? -0.5 / w : 0;
    for (let ix = 0; ix <= w; ix++) {
      const u = ix / w, phi = phiStart + u * phiLength, theta = thetaStart + v * thetaLength;
      const x = -radius * Math.cos(phi) * Math.sin(theta), y = radius * Math.cos(theta), z = radius * Math.sin(phi) * Math.sin(theta);
      const nx = -Math.cos(phi) * Math.sin(theta), ny = Math.cos(theta), nz = Math.sin(phi) * Math.sin(theta);
      row.push(b.vertexN(x, y, z, nx, ny, nz, u + uOffset, 1 - v));
    }
    grid.push(row);
  }
  for (let iy = 0; iy < h; iy++) for (let ix = 0; ix < w; ix++) {
    const a = grid[iy][ix + 1], bb = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1];
    if (iy !== 0 || thetaStart > 0) b.idx.push(a, bb, d);
    if (iy !== h - 1 || thetaEnd < Math.PI) b.idx.push(bb, c, d);
  }
  return b.build();
}

/**
 * Three.js `CapsuleGeometry` (r170 layout): hemispherical caps of `capSegments` rows joined by a cylinder of
 * `heightSegments` rows, along +y. `height` is the length of the middle section. UVs follow arc length.
 */
export function capsuleGeometry(radius = 1, height = 1, capSegments = 4, radialSegments = 8, heightSegments = 1): GeometryData {
  const b = new Builder();
  height = Math.max(0, height);
  const cs = segments(capSegments, 1), rs = segments(radialSegments, 3), hs = segments(heightSegments, 1);
  const half = height / 2, capArc = Math.PI / 2 * radius, total = 2 * capArc + height, rows = cs * 2 + hs, perRow = rs + 1;
  for (let iy = 0; iy <= rows; iy++) {
    let y: number, r: number, ny: number, arc: number;
    if (iy <= cs) {
      const t = iy / cs, angle = t * Math.PI / 2;
      y = -half - radius * Math.cos(angle); r = radius * Math.sin(angle); ny = -radius * Math.cos(angle); arc = t * capArc;
    } else if (iy <= cs + hs) {
      const t = (iy - cs) / hs;
      y = -half + t * height; r = radius; ny = 0; arc = capArc + t * height;
    } else {
      const t = (iy - cs - hs) / cs, angle = t * Math.PI / 2;
      y = half + radius * Math.sin(angle); r = radius * Math.cos(angle); ny = radius * Math.sin(angle); arc = capArc + height + t * capArc;
    }
    const v = Math.max(0, Math.min(1, arc / total)), uOffset = iy === 0 ? 0.5 / rs : iy === rows ? -0.5 / rs : 0;
    for (let ix = 0; ix <= rs; ix++) {
      const u = ix / rs, theta = u * TAU, s = Math.sin(theta), c = Math.cos(theta);
      b.vertexN(-r * c, y, r * s, -r * c, ny, r * s, u + uOffset, v);
    }
    if (iy > 0) {
      const prev = (iy - 1) * perRow;
      for (let ix = 0; ix < rs; ix++) {
        const i1 = prev + ix, i2 = prev + ix + 1, i3 = iy * perRow + ix, i4 = iy * perRow + ix + 1;
        b.idx.push(i1, i2, i3, i2, i4, i3);
      }
    }
  }
  return b.build();
}

/** Three.js `TorusGeometry` in the XY plane. */
export function torusGeometry(radius = 1, tube = 0.4, radialSegments = 12, tubularSegments = 48, arc = TAU): GeometryData {
  const b = new Builder(), rs = segments(radialSegments, 1), ts = segments(tubularSegments, 1);
  for (let j = 0; j <= rs; j++) for (let i = 0; i <= ts; i++) {
    const u = i / ts * arc, v = j / rs * TAU, cu = Math.cos(u), su = Math.sin(u), cv = Math.cos(v), sv = Math.sin(v);
    b.vertexN((radius + tube * cv) * cu, (radius + tube * cv) * su, tube * sv, cv * cu, cv * su, sv, i / ts, j / rs);
  }
  for (let j = 1; j <= rs; j++) for (let i = 1; i <= ts; i++) {
    const a = (ts + 1) * j + i - 1, bb = (ts + 1) * (j - 1) + i - 1, c = (ts + 1) * (j - 1) + i, d = (ts + 1) * j + i;
    b.idx.push(a, bb, d, bb, c, d);
  }
  return b.build();
}

/** Three.js `TorusKnotGeometry` for a (p, q) torus knot. */
export function torusKnotGeometry(radius = 1, tube = 0.4, tubularSegments = 64, radialSegments = 8, p = 2, q = 3): GeometryData {
  const b = new Builder(), ts = Math.floor(finiteNumber(tubularSegments)), rs = Math.floor(finiteNumber(radialSegments));
  const knot = (u: number): [number, number, number] => {
    const cs = Math.cos(q / p * u);
    return [radius * (2 + cs) * 0.5 * Math.cos(u), radius * (2 + cs) * Math.sin(u) * 0.5, radius * Math.sin(q / p * u) * 0.5];
  };
  for (let i = 0; i <= ts; i++) {
    const u = i / ts * p * TAU, p1 = knot(u), p2 = knot(u + 0.01);
    const t = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]], s = [p2[0] + p1[0], p2[1] + p1[1], p2[2] + p1[2]];
    let bn = [t[1] * s[2] - t[2] * s[1], t[2] * s[0] - t[0] * s[2], t[0] * s[1] - t[1] * s[0]];
    let n = [bn[1] * t[2] - bn[2] * t[1], bn[2] * t[0] - bn[0] * t[2], bn[0] * t[1] - bn[1] * t[0]];
    const lb = Math.hypot(...bn), ln = Math.hypot(...n);
    bn = bn.map(x => x / lb); n = n.map(x => x / ln);
    for (let j = 0; j <= rs; j++) {
      const v = j / rs * TAU, cx = -tube * Math.cos(v), cy = tube * Math.sin(v);
      const off = [cx * n[0] + cy * bn[0], cx * n[1] + cy * bn[1], cx * n[2] + cy * bn[2]];
      b.vertexN(p1[0] + off[0], p1[1] + off[1], p1[2] + off[2], off[0], off[1], off[2], i / ts, j / rs);
    }
  }
  for (let j = 1; j <= ts; j++) for (let i = 1; i <= rs; i++) {
    const a = (rs + 1) * (j - 1) + i - 1, bb = (rs + 1) * j + i - 1, c = (rs + 1) * j + i, d = (rs + 1) * (j - 1) + i;
    b.idx.push(a, bb, d, bb, c, d);
  }
  return b.build();
}

/**
 * Three.js `LatheGeometry`: revolves 2D points (x is the radius, y the height) around +y. Normals come from the
 * profile like Three.js, but every normal is unit length.
 */
export function latheGeometry(points: readonly Vec2[] = [[0, -0.5], [0.5, 0], [0, 0.5]], segmentCount = 12, phiStart = 0, phiLength = TAU): GeometryData {
  if (points.length < 2) throw new RangeError('Lathe needs at least two points');
  const b = new Builder(), n = Math.floor(finiteNumber(segmentCount)), last = points.length - 1;
  phiLength = Math.min(Math.max(phiLength, 0), TAU);
  const profile: [number, number][] = [];
  let prev: [number, number] = [0, 0];
  for (let j = 0; j <= last; j++) {
    if (j === 0) {
      const dx = points[1][0] - points[0][0], dy = points[1][1] - points[0][1];
      prev = [dy, -dx]; profile.push(prev);
    } else if (j === last) profile.push(prev);
    else {
      const dx = points[j + 1][0] - points[j][0], dy = points[j + 1][1] - points[j][1], cur: [number, number] = [dy, -dx];
      profile.push([prev[0] + cur[0], prev[1] + cur[1]]); prev = cur;
    }
  }
  for (let i = 0; i <= n; i++) {
    const phi = phiStart + i / n * phiLength, s = Math.sin(phi), c = Math.cos(phi);
    for (let j = 0; j <= last; j++) b.vertexN(points[j][0] * s, points[j][1], points[j][0] * c, profile[j][0] * s, profile[j][1], profile[j][0] * c, i / n, j / last);
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < last; j++) {
    const base = j + i * points.length, a = base, bb = base + points.length, c = base + points.length + 1, d = base + 1;
    b.idx.push(a, bb, d, c, d, bb);
  }
  return b.build();
}

/**
 * Three.js `TubeGeometry`: a tube of `radius` swept along a 3D (or 2D, z = 0) curve using its Frenet frames.
 * `closed` reuses the first ring as the last so a closed curve gives a seamless tube.
 */
export function tubeGeometry(path: Curve<Vec>, tubularSegments = 64, radius = 1, radialSegments = 8, closed = false): GeometryData {
  const b = new Builder(), ts = Math.floor(finiteNumber(tubularSegments)), rs = Math.floor(finiteNumber(radialSegments)), frames = path.computeFrenetFrames(ts, closed);
  const ring = (i: number) => {
    const p = path.getPointAt(i / ts), N = frames.normals[i], B = frames.binormals[i], px = p[0], py = p[1], pz = p.length > 2 ? p[2]! : 0;
    for (let j = 0; j <= rs; j++) {
      const v = j / rs * TAU, s = Math.sin(v), c = -Math.cos(v);
      let nx = c * N[0] + s * B[0], ny = c * N[1] + s * B[1], nz = c * N[2] + s * B[2];
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      b.vertex(px + radius * nx, py + radius * ny, pz + radius * nz, nx, ny, nz, 0, 0);
    }
  };
  for (let i = 0; i < ts; i++) ring(i);
  ring(closed ? 0 : ts);
  for (let i = 0; i <= ts; i++) for (let j = 0; j <= rs; j++) {const k = (i * (rs + 1) + j) * 2; b.uv[k] = i / ts; b.uv[k + 1] = j / rs;}
  for (let j = 1; j <= ts; j++) for (let i = 1; i <= rs; i++) {
    const a = (rs + 1) * (j - 1) + i - 1, bb = (rs + 1) * j + i - 1, c = (rs + 1) * j + i, d = (rs + 1) * (j - 1) + i;
    b.idx.push(a, bb, d, bb, c, d);
  }
  return b.build();
}
