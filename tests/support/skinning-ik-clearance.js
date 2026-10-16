// Independent offline triangle-surface oracle. No BodyIK support hulls or proxies.
const sub = (a, b) => a.map((value, i) => value - b[i]);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const squared = (a, b) => dot(sub(a, b), sub(a, b));
const clamp = (value) => Math.max(0, Math.min(1, value));
const edges = (t) => [
  [t[0], t[1]],
  [t[1], t[2]],
  [t[2], t[0]],
];
function segmentSquared(p, q, a, b) {
  const u = sub(q, p),
    v = sub(b, a),
    w = sub(p, a),
    aa = dot(u, u),
    bb = dot(u, v),
    cc = dot(v, v),
    dd = dot(u, w),
    ee = dot(v, w),
    denominator = aa * cc - bb * bb;
  let s = aa ? (denominator > 1e-24 ? clamp((bb * ee - cc * dd) / denominator) : 0) : 0;
  let t = cc ? (bb * s + ee) / cc : 0;
  if (t < 0) {
    t = 0;
    s = aa ? clamp(-dd / aa) : 0;
  } else if (t > 1) {
    t = 1;
    s = aa ? clamp((bb - dd) / aa) : 0;
  }
  return squared(
    p.map((value, i) => value + u[i] * s),
    a.map((value, i) => value + v[i] * t),
  );
}
function pointSquared(p, t) {
  const [a, b, c] = t,
    ab = sub(b, a),
    ac = sub(c, a),
    ap = sub(p, a),
    d1 = dot(ab, ap),
    d2 = dot(ac, ap);
  const normal = cross(ab, ac);
  if (dot(normal, normal) < 1e-28) return Math.min(...edges(t).map(([a, b]) => segmentSquared(p, p, a, b)));
  if (d1 <= 0 && d2 <= 0) return dot(ap, ap);
  const bp = sub(p, b),
    d3 = dot(ab, bp),
    d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return dot(bp, bp);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0)
    return squared(
      p,
      a.map((value, i) => value + (ab[i] * d1) / (d1 - d3)),
    );
  const cp = sub(p, c),
    d5 = dot(ab, cp),
    d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return dot(cp, cp);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0)
    return squared(
      p,
      a.map((value, i) => value + (ac[i] * d2) / (d2 - d6)),
    );
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 >= d3 && d5 >= d6)
    return squared(
      p,
      b.map((value, i) => value + ((c[i] - b[i]) * (d4 - d3)) / (d4 - d3 + d5 - d6)),
    );
  const sum = va + vb + vc;
  if (Math.abs(sum) < 1e-28) return Math.min(...edges(t).map(([a, b]) => segmentSquared(p, p, a, b)));
  return squared(
    p,
    a.map((value, i) => value + (ab[i] * vb) / sum + (ac[i] * vc) / sum),
  );
}
function crosses(p, q, t) {
  const [a, b, c] = t,
    direction = sub(q, p),
    e1 = sub(b, a),
    e2 = sub(c, a),
    h = cross(direction, e2),
    det = dot(e1, h);
  if (Math.abs(det) < 1e-15) return false;
  const s = sub(p, a),
    u = dot(s, h) / det;
  if (u < -1e-10 || u > 1 + 1e-10) return false;
  const r = cross(s, e1),
    v = dot(direction, r) / det,
    at = dot(e2, r) / det;
  return v >= -1e-10 && u + v <= 1 + 1e-10 && at >= -1e-10 && at <= 1 + 1e-10;
}
function triangleSquared(a, b) {
  const ae = edges(a),
    be = edges(b);
  if (ae.some(([p, q]) => crosses(p, q, b)) || be.some(([p, q]) => crosses(p, q, a))) return 0;
  let best = Math.min(...a.map((p) => pointSquared(p, b)), ...b.map((p) => pointSquared(p, a)));
  for (const [p, q] of ae) for (const [r, s] of be) best = Math.min(best, segmentSquared(p, q, r, s));
  return best;
}
const bounds = (triangles) =>
  [0, 1, 2].map((axis) => [
    Math.min(...triangles.flatMap((t) => t.map((p) => p[axis]))),
    Math.max(...triangles.flatMap((t) => t.map((p) => p[axis]))),
  ]);
const boxSquared = (a, b) =>
  a.reduce((sum, range, axis) => sum + Math.max(0, range[0] - b[axis][1], b[axis][0] - range[1]) ** 2, 0);
export function triangleTree(triangles) {
  if (!triangles.length) throw new Error('Surface group must contain triangles');
  const box = bounds(triangles);
  if (triangles.length <= 8) return { box, triangles };
  const spans = box.map(([a, b]) => b - a),
    axis = spans.indexOf(Math.max(...spans)),
    sorted = [...triangles].sort(
      (a, b) => a[0][axis] + a[1][axis] + a[2][axis] - (b[0][axis] + b[1][axis] + b[2][axis]),
    );
  const middle = sorted.length >> 1;
  return { box, left: triangleTree(sorted.slice(0, middle)), right: triangleTree(sorted.slice(middle)) };
}
export function pointSurfaceDistance(point, tree, closest) {
  let best = Infinity;
  const pointBox = point.map((value) => [value, value]);
  const visit = (node) => {
    if (boxSquared(pointBox, node.box) >= best) return;
    if (node.triangles)
      for (const triangle of node.triangles) {
        const value = pointSquared(point, triangle);
        if (value < best) {
          best = value;
          if (closest) closest.triangle = triangle;
        }
      }
    else {
      const first = boxSquared(pointBox, node.left.box) < boxSquared(pointBox, node.right.box) ? node.left : node.right;
      visit(first);
      visit(first === node.left ? node.right : node.left);
    }
  };
  visit(tree);
  return Math.sqrt(best);
}
export function meshSurfaceDistance(triangles, tree, closest) {
  let best = Infinity;
  for (const triangle of triangles) {
    const box = bounds([triangle]);
    const visit = (node) => {
      if (boxSquared(box, node.box) >= best) return;
      if (node.triangles)
        for (const other of node.triangles) {
          const value = triangleSquared(triangle, other);
          if (value < best) {
            best = value;
            if (closest) {
              closest.triangleA = triangle;
              closest.triangleB = other;
            }
          }
        }
      else {
        const first = boxSquared(box, node.left.box) < boxSquared(box, node.right.box) ? node.left : node.right;
        visit(first);
        visit(first === node.left ? node.right : node.left);
      }
    };
    visit(tree);
    if (!best) break;
  }
  return Math.sqrt(best);
}
export function transformPoint(matrix, point) {
  return [0, 1, 2].map(
    (axis) => matrix[axis] * point[0] + matrix[axis + 4] * point[1] + matrix[axis + 8] * point[2] + matrix[axis + 12],
  );
}
