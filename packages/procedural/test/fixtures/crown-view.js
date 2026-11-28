// The orthographic crown view the broadleaf tests share (KB-PROCEDURAL-OAKBLOB1): a tree drawn from an azimuth and an
// elevation with a z-buffer, leaf cards cut by their atlas' alpha, and the gap measures taken from it.
const lin = (b) => {
  const v = b / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const unit = (v) => {
  const l = Math.hypot(...v) || 1;
  return v.map((x) => x / l);
};

// `parts` are { geometry, atlas?, leaf? }: a geometry drawn as bark (kind 2), or as leaves (kind 1) when it comes with an
// atlas image {width, height, data} (a texel counting where its alpha is 128 or more) or `leaf: true` (opaque). The grid has 400 cells across
// the tree's own radius, so one tolerance fits a sapling and an old oak. The picture is centred on the point (0, cy, 0) and `extent` metres reach half way across it.
export function view(parts, az, el, extent, cy, radius = extent) {
  const d = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)],
    u = unit([Math.cos(az), 0, -Math.sin(az)]),
    v = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]],
    cell = extent / 200,
    W = 400,
    H = 400,
    kind = new Uint8Array(W * H),
    depth = new Float32Array(W * H).fill(-Infinity),
    lum = new Float32Array(W * H);
  const project = (x, y, z) => [
    W / 2 + (x * u[0] + y * u[1] + z * u[2]) / cell,
    H / 2 - (x * v[0] + (y - cy) * v[1] + z * v[2]) / cell,
    x * d[0] + y * d[1] + z * d[2],
  ];
  for (const { geometry: g, atlas, leaf, albedo = [0.09, 0.075, 0.06], occlude = false } of parts) {
    const P = g.positions,
      I = g.indices,
      UV = g.uvs,
      n = P.length / 3,
      q = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = project(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
      q[i * 3] = x;
      q[i * 3 + 1] = y;
      q[i * 3 + 2] = z;
    }
    for (let t = 0; t < I.length; t += 3) {
      const [a, b, c] = [I[t], I[t + 1], I[t + 2]],
        ax = q[a * 3],
        ay = q[a * 3 + 1],
        bx = q[b * 3],
        by = q[b * 3 + 1],
        cx = q[c * 3],
        cy2 = q[c * 3 + 1],
        area = (bx - ax) * (cy2 - ay) - (by - ay) * (cx - ax);
      if (!area) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
        x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx))),
        y0 = Math.max(0, Math.floor(Math.min(ay, by, cy2))),
        y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy2)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5,
            py = y + 0.5,
            w0 = ((bx - px) * (cy2 - py) - (by - py) * (cx - px)) / area,
            w1 = ((cx - px) * (ay - py) - (cy2 - py) * (ax - px)) / area,
            w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * q[a * 3 + 2] + w1 * q[b * 3 + 2] + w2 * q[c * 3 + 2],
            i = y * W + x;
          if (z <= depth[i]) continue;
          if (atlas) {
            const tu = w0 * UV[a * 2] + w1 * UV[b * 2] + w2 * UV[c * 2],
              tv = w0 * UV[a * 2 + 1] + w1 * UV[b * 2 + 1] + w2 * UV[c * 2 + 1],
              tx = Math.min(atlas.width - 1, Math.floor(tu * atlas.width)),
              ty = Math.min(atlas.height - 1, Math.floor(tv * atlas.height));
            if (atlas.data[(ty * atlas.width + tx) * 4 + 3] < 128) continue;
            const o = (ty * atlas.width + tx) * 4;
            lum[i] = 0.2126 * lin(atlas.data[o]) + 0.7152 * lin(atlas.data[o + 1]) + 0.0722 * lin(atlas.data[o + 2]);
          } else lum[i] = 0.2126 * albedo[0] + 0.7152 * albedo[1] + 0.0722 * albedo[2];
          // The occlusion term the imposter bakes: the crown's near side full, its far side darker.
          if (occlude) lum[i] *= 0.45 + 0.55 * Math.min(1, Math.max(0, (z - cy * d[1] + radius) / (2 * radius)) * 1.3);
          depth[i] = z;
          kind[i] = atlas || leaf ? 1 : 2;
        }
    }
  }
  // Image row of the point (0, y, 0): where the crown base cuts the picture.
  return { W, H, kind, depth, lum, rowOf: (y) => H / 2 - ((y - cy) * v[1]) / cell };
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
function hull(points) {
  points.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const lower = [],
    upper = [];
  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  for (const p of points.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
// Pixels of `image` (rows above `cutRow` only: the crown, not the bare bole) inside a convex polygon, and how many are covered.
function inside(image, poly, cutRow) {
  let total = 0,
    covered = 0;
  for (let y = 0; y < Math.min(image.H, cutRow); y++) {
    let lo = Infinity,
      hi = -Infinity;
    const py = y + 0.5;
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k],
        b = poly[(k + 1) % poly.length];
      if ((a[1] <= py && b[1] > py) || (b[1] <= py && a[1] > py)) {
        const x = a[0] + ((py - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
    }
    for (let x = Math.max(0, Math.ceil(lo - 0.5)); x <= Math.min(image.W - 1, Math.floor(hi - 0.5)); x++) {
      total++;
      if (image.kind[y * image.W + x]) covered++;
    }
  }
  return { total, covered };
}

// The gap measures of one view: `gap` the sky share inside the silhouette's convex hull, `inner` the sky share inside
// that hull shrunk to 0.8 about its centroid, `bark` the bark share of the covered crown pixels.
export function crownStats(image, cutRow) {
  const pts = [];
  let bark = 0,
    covered = 0;
  for (let y = 0; y < Math.min(image.H, cutRow); y++)
    for (let x = 0; x < image.W; x++) {
      const k = image.kind[y * image.W + x];
      if (!k) continue;
      pts.push([x + 0.5, y + 0.5]);
      covered++;
      if (k === 2) bark++;
    }
  const h = hull(pts),
    cx = h.reduce((s, p) => s + p[0], 0) / h.length,
    cy = h.reduce((s, p) => s + p[1], 0) / h.length,
    full = inside(image, h, cutRow),
    small = inside(
      image,
      h.map((p) => [cx + (p[0] - cx) * 0.8, cy + (p[1] - cy) * 0.8]),
      cutRow,
    );
  return {
    gap: 1 - full.covered / full.total,
    inner: 1 - small.covered / small.total,
    bark: bark / covered,
  };
}

export const AZIMUTHS = Array.from({ length: 8 }, (_, k) => (k * Math.PI) / 4);
export const ELEVATIONS = [0, (10 * Math.PI) / 180, (30 * Math.PI) / 180];

// Mean gap measures of a tree over 8 azimuths and three elevations (and each view's own, for the bounds).
export function crownMeasures(parts, extent, cy, crownBase) {
  const views = [];
  for (const el of ELEVATIONS)
    for (const az of AZIMUTHS) {
      const image = view(parts, az, el, extent, cy);
      views.push(crownStats(image, image.rowOf(crownBase)));
    }
  const mean = (key) => views.reduce((s, v) => s + v[key], 0) / views.length;
  return { views, gap: mean('gap'), inner: mean('inner'), bark: mean('bark') };
}
