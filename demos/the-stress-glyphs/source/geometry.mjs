import { plate } from './field.mjs';

export function shell(width, depth, hole, lower, upper, bevel) {
  const points = [], normals = [], indices = [];
  const a = Math.atan2(depth, width), b = Math.atan2(depth - 2 * bevel, width - 2 * bevel);
  const angles = [
    ...Array.from({ length: 96 }, (_, i) => i * Math.PI / 48),
    a, Math.PI - a, Math.PI + a, 2 * Math.PI - a,
    b, Math.PI - b, Math.PI + b, 2 * Math.PI - b,
  ].sort((left, right) => left - right).filter((v, i, all) => !i || v - all[i - 1] > 1e-6);
  const traverse = theta => {
    const cos = Math.cos(theta), sin = Math.sin(theta);
    const edge = inset => Math.min((width / 2 - inset) / Math.abs(cos), (depth / 2 - inset) / Math.abs(sin));
    return [
      [hole, upper - bevel], [hole + bevel, upper], [edge(bevel), upper],
      [edge(0), upper - bevel], [edge(0), lower + bevel], [edge(bevel), lower],
      [hole + bevel, lower], [hole, lower + bevel],
    ].map(([radius, up]) => [cos * radius, up, -sin * radius]);
  };
  for (const [i, angle] of angles.entries()) {
    const one = traverse(angle), two = traverse(angles[(i + 1) % angles.length]);
    for (let j = 0; j < one.length; j++) {
      const k = (j + 1) % one.length;
      addFace(points, normals, indices, [one[j], one[k], two[k], two[j]]);
    }
  }
  return { points, normals, indices };
}

function addFace(points, normals, indices, vertices) {
  const [a, b, c] = vertices;
  const u = b.map((v, i) => v - a[i]), v = c.map((v, i) => v - a[i]);
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const mag = Math.hypot(...n), first = points.length / 3;
  const normal = n.map(value => value / mag);
  for (const p of vertices) {
    points.push(...p);
    normals.push(...normal);
  }
  indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
}

// Beveled symbology in a shared geometry, local X is the physical glyph length.
export function signalShape(style) {
  const points = [], normals = [], indices = [];
  const arrow = style !== 'shear';
  const profile = style === 'compression' ? [[-.50,.14],[-.36,.43],[-.04,.13]] :
    [[-.50,.035],[-.31,.43],[-.285,.16],[.285,.16],[.31,.43],[.50,.035]];
  const pairs = style === 'compression' ? [profile, profile.map(([x, z]) => [-x, z]).reverse()] :
    [style === 'pull' ? [[-.50,.14],[.08,.14],[.12,.42],[.50,.02]] :
      arrow ? profile : [[-.50,.10],[-.42,.26],[.42,.26],[.50,.10]]];
  for (const section of pairs) {
    for (let i = 0; i < section.length - 1; i++) {
      const [x, w] = section[i], [x2, w2] = section[i + 1];
      const a = [x, .28, -w], b = [x2, .28, -w2], c = [x2, .28, w2], d = [x, .28, w];
      const e = [x, -.28, -w], f = [x2, -.28, -w2], g = [x2, -.28, w2], h = [x, -.28, w];
      addFace(points, normals, indices, [a,d,c,b]);
      addFace(points, normals, indices, [e,f,g,h]);
      addFace(points, normals, indices, [a,b,f,e]);
      addFace(points, normals, indices, [d,h,g,c]);
      if (i === 0) addFace(points, normals, indices, [a,e,h,d]);
      if (i === section.length - 2) addFace(points, normals, indices, [b,c,g,f]);
    }
  }
  return { points, normals, indices };
}

export function rimSection(theta, step) {
  const sample = (radius, angle) => [Math.cos(angle) * radius, .0073, -Math.sin(angle) * radius];
  const a = theta - step * .48, b = theta + step * .48;
  const inner = plate.radius + .0021, outer = plate.radius + .0053;
  const points = [], normals = [], indices = [];
  addFace(points, normals, indices, [sample(inner, a), sample(outer, a), sample(outer, b), sample(inner, b)]);
  return { points, normals, indices };
}
