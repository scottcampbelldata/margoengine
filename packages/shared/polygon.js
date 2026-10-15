import { finiteVector } from '@margoengine/math/validate';

const turn = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
const turnError = (a, b, c) =>
  (Math.abs((b[0] - a[0]) * (c[1] - a[1])) + Math.abs((b[1] - a[1]) * (c[0] - a[0]))) * Number.EPSILON * 4;
const orientation = (a, b, c) => {
  const value = turn(a, b, c);
  return Math.abs(value) <= turnError(a, b, c) ? 0 : Math.sign(value);
};
function measure(ring) {
  const origin = ring[0];
  let area = 0,
    correction = 0,
    error = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const value = turn(origin, ring[i], ring[i + 1]),
      adjusted = value - correction,
      sum = area + adjusted;
    correction = sum - area - adjusted;
    area = sum;
    error += turnError(origin, ring[i], ring[i + 1]);
  }
  return { area: area / 2, error: error / 2 + Math.abs(area) * Number.EPSILON };
}
function signedArea(ring) {
  return measure(ring).area;
}
function chargeContourWork(counter, amount = 1) {
  if (counter) {
    counter.used += amount;
    if (counter.used > counter.limit) throw new RangeError('Text total work budget exceeded');
  }
}
function containsPoint(ring, p, workCounter) {
  let inside = false;
  chargeContourWork(workCounter, ring.length);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) inside = !inside;
  }
  return inside;
}
function intersects(a, b, c, d) {
  const values = [orientation(a, b, c), orientation(a, b, d), orientation(c, d, a), orientation(c, d, b)];
  if (values[0] * values[1] < 0 && values[2] * values[3] < 0) return true;
  const on = (p, x, y) =>
    p[0] >= Math.min(x[0], y[0]) &&
    p[0] <= Math.max(x[0], y[0]) &&
    p[1] >= Math.min(x[1], y[1]) &&
    p[1] <= Math.max(x[1], y[1]);
  return (
    (values[0] === 0 && on(c, a, b)) ||
    (values[1] === 0 && on(d, a, b)) ||
    (values[2] === 0 && on(a, c, d)) ||
    (values[3] === 0 && on(b, c, d))
  );
}
function polygonRings(contour, holes = [], { allowTouch = false, workCounter } = {}) {
  if (!Array.isArray(holes) || holes.length > 4096) throw new TypeError('Invalid polygon holes');
  let count = 0;
  const rings = [contour, ...holes].map((ring) => {
    if (!Array.isArray(ring) || ring.length < 3 || (count += ring.length) > 4096)
      throw new RangeError('Polygon requires 3–4096 total contour vertices');
    chargeContourWork(workCounter, ring.length * 3);
    const p = ring.map((v) => {
      finiteVector(v, 2, 'Polygon vertex');
      return Array.from(v);
    });
    if (p.at(-1)[0] === p[0][0] && p.at(-1)[1] === p[0][1]) p.pop();
    for (let i = p.length - 1; i >= 0; i--) {
      const q = p[(i + 1) % p.length];
      if (p[i][0] === q[0] && p[i][1] === q[1]) p.splice(i, 1);
    }
    if (p.length < 3) throw new RangeError('Degenerate polygon contour');
    return p;
  });
  const edges = rings.flatMap((ring, ri) =>
    ring.map((a, i) => ({ a, b: ring[(i + 1) % ring.length], ri, i, count: ring.length })),
  );
  for (const ring of rings) {
    const { area, error } = measure(ring);
    if (Math.abs(area) <= error) throw new RangeError('Polygon contour has zero area');
  }
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      chargeContourWork(workCounter);
      const a = edges[i],
        b = edges[j];
      if (a.ri === b.ri && (Math.abs(a.i - b.i) === 1 || Math.abs(a.i - b.i) === a.count - 1)) {
        const common = a.b[0] === b.a[0] && a.b[1] === b.a[1] ? [a.a, a.b, b.b] : [b.a, b.b, a.b];
        if (
          orientation(...common) === 0 &&
          (common[0][0] - common[1][0]) * (common[2][0] - common[1][0]) +
            (common[0][1] - common[1][1]) * (common[2][1] - common[1][1]) >
            0
        )
          throw new RangeError('Polygon doubles back along an edge');
        continue;
      }
      if (intersects(a.a, a.b, b.a, b.b)) {
        const endpoint = [a.a, a.b].some((p) => [b.a, b.b].some((q) => p[0] === q[0] && p[1] === q[1]));
        const collinear = orientation(a.a, a.b, b.a) === 0 && orientation(a.a, a.b, b.b) === 0,
          axis = Math.abs(a.b[0] - a.a[0]) >= Math.abs(a.b[1] - a.a[1]) ? 0 : 1;
        const overlap =
          collinear &&
          Math.min(Math.max(a.a[axis], a.b[axis]), Math.max(b.a[axis], b.b[axis])) >
            Math.max(Math.min(a.a[axis], a.b[axis]), Math.min(b.a[axis], b.b[axis]));
        if (!allowTouch || !endpoint || overlap) throw new RangeError('Polygon contours cross or touch');
      }
    }
  for (let i = 1; i < rings.length; i++) {
    if (
      !(allowTouch
        ? rings[i].some((p) => containsPoint(rings[0], p, workCounter))
        : containsPoint(rings[0], rings[i][0], workCounter))
    )
      throw new RangeError('Polygon hole lies outside the contour');
    for (let j = 1; j < i; j++)
      if (containsPoint(rings[j], rings[i][0], workCounter) || containsPoint(rings[i], rings[j][0], workCounter))
        throw new RangeError('Polygon holes overlap or nest');
  }
  return rings.map((ring, i) => (signedArea(ring) > 0 === (i === 0) ? ring : ring.reverse()));
}

export function triangulatePolygon(
  contour,
  holes = [],
  { maxVertices = 1000000, allowTouch = false, workCounter } = {},
) {
  if (!Number.isSafeInteger(maxVertices) || maxVertices < 3)
    throw new RangeError('Invalid triangulation vertex budget');
  const rings = polygonRings(contour, holes, { allowTouch, workCounter }),
    edges = rings.flatMap((r) => r.map((a, i) => [a, r[(i + 1) % r.length]]));
  chargeContourWork(workCounter, edges.length * (3 + Math.ceil(Math.log2(Math.max(1, edges.length)))));
  const xs = [...new Set(rings.flat().map((p) => p[0]))].sort((a, b) => a - b),
    positions = [],
    indices = [];
  function triangle(a, b, c) {
    chargeContourWork(workCounter, 3);
    if (orientation(a, b, c) <= 0) return;
    if (positions.length / 2 + 3 > maxVertices) throw new RangeError('Triangulation vertex budget exceeded');
    const base = positions.length / 2;
    positions.push(...a, ...b, ...c);
    indices.push(base, base + 1, base + 2);
  }
  // Vertical decomposition pairs even/odd intersections and handles holes without bridge heuristics.
  for (let i = 0; i < xs.length - 1; i++) {
    const left = xs[i],
      right = xs[i + 1];
    chargeContourWork(workCounter, edges.length * (2 + Math.ceil(Math.log2(Math.max(1, edges.length)))));
    // Every edge endpoint is a slab boundary. Select edges spanning the whole open
    // slab and order their endpoint-average heights, even when no binary64 x lies inside.
    const crossing = edges
      .filter(([a, b]) => a[0] !== b[0] && Math.min(a[0], b[0]) <= left && Math.max(a[0], b[0]) >= right)
      .map(([a, b]) => ({
        y: (x) => (x === a[0] ? a[1] : x === b[0] ? b[1] : a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0])),
      }))
      .sort((a, b) => a.y(left) / 2 + a.y(right) / 2 - (b.y(left) / 2 + b.y(right) / 2));
    if (crossing.length % 2) throw new RangeError('Polygon precision prevents triangulation');
    for (let j = 0; j < crossing.length; j += 2) {
      const bottom = crossing[j],
        top = crossing[j + 1],
        a = [left, bottom.y(left)],
        b = [right, bottom.y(right)],
        c = [right, top.y(right)],
        d = [left, top.y(left)];
      triangle(a, b, c);
      triangle(a, c, d);
    }
  }
  chargeContourWork(workCounter, edges.length * 2 + indices.length);
  const expected = rings.reduce((area, r) => area + signedArea(r), 0),
    actual = indices.reduce(
      (area, _, i) =>
        i % 3
          ? area
          : area +
            turn(
              positions.slice(indices[i] * 2, indices[i] * 2 + 2),
              positions.slice(indices[i + 1] * 2, indices[i + 1] * 2 + 2),
              positions.slice(indices[i + 2] * 2, indices[i + 2] * 2 + 2),
            ) /
              2,
      0,
    );
  if (
    !indices.length ||
    Math.abs(actual - expected) >
      Math.max(rings.reduce((sum, ring) => sum + measure(ring).error, 0) * edges.length * 8, Math.abs(expected) * 1e-10)
  )
    throw new RangeError('Triangulation does not preserve polygon area');
  return { positions, indices, rings, area: expected };
}
