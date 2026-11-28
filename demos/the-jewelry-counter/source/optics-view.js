import { Lines, Line } from '@margoengine/lines';
import { createMesh, Material } from '@margoengine/materials';

const dot = (a, b) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const at = (p, d, t) => p.map((v, i) => v + t * d[i]);
const unit = (v) => v.map((n, _, a) => n / Math.hypot(...a));
const refract = (ray, n, eta) => {
  const cosine = dot(ray, n);
  const d = 1 - eta * eta * (1 - cosine * cosine);
  return d < 0 ? null : unit(ray.map((v, i) => eta * v - (eta * cosine + Math.sqrt(d)) * n[i]));
};

export function traceThroughGem(facets, entry, direction, ior) {
  const points = [at(entry, direction, -0.009), entry];
  let ray = refract(direction, [0, 1, 0], 1 / ior);
  let start = at(entry, ray, 0.000002);
  for (let i = 0; i < 8; i++) {
    let closest = Infinity;
    let normal;
    for (const [x, y, z, plane] of facets) {
      const n = [x, y, z];
      const project = dot(n, ray);
      if (project <= 1e-5) continue;
      const distance = (plane - dot(n, start)) / project;
      if (distance > 0.000001 && distance < closest) {
        normal = n;
        closest = distance;
      }
    }
    if (!normal) break;
    const hit = at(start, ray, closest);
    points.push(hit);
    const exit = refract(ray, normal.map((v) => -v), ior);
    if (exit) {
      points.push(at(hit, exit, 0.009));
      break;
    }
    ray = at(ray, normal, -2 * dot(ray, normal));
    start = at(hit, ray, 0.000002);
  }
  return points;
}

export function showOptics(engine, model) {
  const lines = Lines.attach(engine);
  const glass = new Material({
    color: '#95c5e1', transparent: true, opacity: 0.23, depthWrite: false, roughness: 0.23, doubleSided: true,
  });
  const cut = createMesh(engine, model.gemShape, glass);
  cut.root.name = 'Transparent facet diagram';
  cut.root.setParent(model.bearing).setPosition([0, model.stoneHeight, 0]);
  cut.root.visible = false;
  const centre = model.stoneHeight + model.bearing.position.y;
  const routes = [[2.407, '#ff7d75'], [2.425, '#8af9bc'], [2.453, '#84bfff']].map(([ior, color]) => ({
    ior, line: lines.add(new Line({ positions: [0, 0, 0, 0, 0.001, 0], color, width: 1.8, opacity: 0.92, onTop: true })),
  }));
  return {
    update(angle, enabled) {
      cut.root.visible = enabled;
      model.gem.root.visible = !enabled;
      const direction = unit([-0.64 * Math.sin(angle), -0.77, -0.64 * Math.cos(angle)]);
      const entry = [0.00046, model.stoneTable, 0.00033];
      for (const { ior, line } of routes) {
        line.visible = enabled;
        if (enabled) line.setPositions(traceThroughGem(model.facets, entry, direction, ior)
          .flatMap(([x, y, z]) => [x, y + centre, z]));
      }
    },
  };
}

