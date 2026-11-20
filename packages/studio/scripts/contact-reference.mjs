// Uniform upper-hemisphere illumination, black sphere, white diffuse ground.
// Ray/sphere intersection and cosine sampling from PBRT 4e sections 6.2 and A.5.3.
export const CONTACT_SCENE = { width: 128, height: 128, size: 4, radius: 0.5, center: [0, 0.5, 0], rays: 4096 };

export function groundAt(scene, x, y) {
  return [((x + 0.5) / scene.width - 0.5) * scene.size, 0, ((y + 0.5) / scene.height - 0.5) * scene.size];
}

/** Analytic projected solid angle when the sphere is entirely above the ground. */
export function sphereOcclusion(point, center, radius) {
  const d2 = center.reduce((sum, v, a) => sum + (v - point[a]) ** 2, 0);
  return (radius * radius * (center[1] - point[1])) / d2 ** 1.5;
}

function radicalInverse(n) {
  let value = 0,
    step = 0.5;
  for (; n; n >>>= 1, step *= 0.5) value += (n & 1) * step;
  return value;
}

export function cosineRays(count) {
  return Array.from({ length: count }, (_, i) => {
    const r = Math.sqrt((i + 0.5) / count),
      phi = 2 * Math.PI * radicalInverse(i);
    return [r * Math.cos(phi), Math.sqrt(1 - r * r), r * Math.sin(phi)];
  });
}

export function traceOcclusion(point, center, radius, rays) {
  const to = center.map((v, a) => v - point[a]),
    c = to.reduce((s, v) => s + v * v, 0) - radius * radius;
  let hits = 0;
  for (const d of rays) {
    const b = to[0] * d[0] + to[1] * d[1] + to[2] * d[2];
    if (b > 0 && b * b >= c) hits++;
  }
  return hits / rays.length;
}

export function contactError(pixels, scene = CONTACT_SCENE) {
  const rays = cosineRays(scene.rays);
  let absolute = 0,
    square = 0,
    max = 0,
    count = 0,
    quadratureMax = 0,
    margoMax = 0,
    margoSum = 0,
    referenceSum = 0;
  for (let y = 0; y < scene.height; y++)
    for (let x = 0; x < scene.width; x++) {
      const p = groundAt(scene, x, y);
      // The sphere is visible in the actual render. Compare exposed ground only,
      // including a one-pixel silhouette guard for rasterization coverage.
      if (Math.hypot(p[0], p[2]) <= scene.radius + scene.size / scene.width) continue;
      const traced = traceOcclusion(p, scene.center, scene.radius, rays);
      quadratureMax = Math.max(quadratureMax, Math.abs(traced - sphereOcclusion(p, scene.center, scene.radius)));
      // ContactShadows composites directly over display white. Compare darkness in
      // the same normalized shadow-catcher domain; no fitted exposure or opacity.
      const actual = 1 - pixels[(y * scene.width + x) * 4] / 255;
      margoMax = Math.max(margoMax, actual);
      margoSum += actual;
      referenceSum += traced;
      const d = Math.abs(actual - traced);
      absolute += d;
      square += d * d;
      max = Math.max(max, d);
      count++;
    }
  return {
    mae: absolute / count,
    rmse: Math.sqrt(square / count),
    max,
    pixels: count,
    rays: scene.rays,
    quadratureMax,
    margoMax,
    margoMean: margoSum / count,
    referenceMean: referenceSum / count,
  };
}
