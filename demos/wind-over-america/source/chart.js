import { Geometry, PbrMaterial, box } from '@margoengine/core';
import { chartHeight as height, chartWidth as width } from './wind-data.js';

function plate(rings, bevel) {
  const xyz = [], normals = [], indices = [];
  const n = 24;
  const outline = (w, h, y, arc) => Array.from({ length: n }, (_, i) => {
    const corner = Math.floor(i / 6);
    const angle = (corner + (i % 6) / 5) * Math.PI / 2;
    const centers = [[w / 2 - arc, h / 2 - arc], [-w / 2 + arc, h / 2 - arc],
      [-w / 2 + arc, -h / 2 + arc], [w / 2 - arc, -h / 2 + arc]];
    return [centers[corner][0] + Math.cos(angle) * arc, y,
      centers[corner][1] + Math.sin(angle) * arc];
  });
  const levels = rings.map(([w, h, y]) => outline(w, h, y, bevel));
  for (let layer = 0; layer < levels.length - 1; layer++) {
    const lower = levels[layer], upper = levels[layer + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = lower[i], b = lower[j], c = upper[j], d = upper[i];
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const dy = d[1] - a[1], dr = Math.hypot(d[0] - a[0], d[2] - a[2]);
      const m = Math.hypot(dz * dy, dx * dy, Math.hypot(dx, dz) * dr) || 1;
      const normal = [dz * dy / m, Math.hypot(dx,dz) * dr / m, -dx * dy / m];
      const base = xyz.length / 3;
      xyz.push(...a, ...b, ...c, ...d);
      for (let v = 0; v < 4; v++) normals.push(...normal);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return new Geometry(xyz, normals, indices);
}

export function buildChart(engine) {
  const material = (color, roughness, metalness = 0) => new PbrMaterial({ color, roughness, metalness });
  const dress = (geometry, surface, pos = [0, 0, 0]) => engine.createMesh()
    .setGeometry(geometry).setMaterial(surface).setPosition(pos);
  const oak = material('#1f3033', .68);
  const steel = material('#47534d', .43);
  const brass = material('#b17e46', .52);
  const dark = material('#16272d', .79);

  dress(box(5, .06, 3.2), dark, [0, -.083, 0]);
  dress(box(width + .075, .033, height + .073), oak, [0, -.026, 0]);
  dress(plate([[width+.083,height+.081,-.042],[width+.092,height+.09,-.034],
    [width+.092,height+.09,-.006],[width+.079,height+.077,.003],
    [width+.003,height+.003,.003],[width-.009,height-.008,-.004]], .022), steel);
  dress(plate([[width+.079,height+.077,.001],[width+.069,height+.067,.005],
    [width+.060,height+.058,.005],[width+.056,height+.054,.002]], .022), brass);
  const pin = box(.016, .004, .006);
  for (const y of [-1, 1]) for (const x of [-1, 1]) {
    dress(pin, brass, [x * (width / 2 + .022), .006, y * (height / 2 + .021)]);
  }
}

