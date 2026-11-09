// Five unlit panes for the batch 168 transparency measurement.
// The reference casts one ray per pixel, hits the panes, and composites them far to near
// with the Porter-Duff over operator, then stores sRGB bytes. It is the sorted alpha picture
// of this scene, not a dielectric.
export const OIT_SCENE = {
  width: 1280,
  height: 720,
  fov: 50,
  eye: [0, 0, 6],
  target: [0, 0, 0],
  near: 0.1,
  far: 100,
  clear: [0, 0, 0],
  half: 1.25,
  panes: [
    { z: 1.5, color: [1, 0, 0], alpha: 0.45 },
    { z: 0.75, color: [0, 1, 0], alpha: 0.5 },
    { z: 0, color: [0, 0, 1], alpha: 0.4 },
    { z: -0.75, color: [1, 1, 0], alpha: 0.55 },
    { z: -1.5, color: [1, 0, 1], alpha: 0.35 },
  ],
};

/** sRGB byte of a linear channel. */
export function srgbByte(linear) {
  const c = Math.min(1, Math.max(0, linear));
  const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
}

/** One pixel of the sorted reference. `layers` is how many panes the ray hit. */
export function tracePixel(scene, x, y) {
  const aspect = scene.width / scene.height;
  const tan = Math.tan((scene.fov * Math.PI) / 360);
  const dx = (((x + 0.5) / scene.width) * 2 - 1) * tan * aspect;
  const dy = (1 - ((y + 0.5) / scene.height) * 2) * tan;
  const hits = [];
  for (const pane of scene.panes) {
    const t = scene.eye[2] - pane.z;
    if (t <= scene.near) continue;
    const hx = t * dx;
    const hy = t * dy;
    if (Math.abs(hx) <= scene.half && Math.abs(hy) <= scene.half) hits.push(pane);
  }
  hits.sort((a, b) => a.z - b.z);
  let r = scene.clear[0];
  let g = scene.clear[1];
  let b = scene.clear[2];
  for (const pane of hits) {
    const a = pane.alpha;
    r = pane.color[0] * a + r * (1 - a);
    g = pane.color[1] * a + g * (1 - a);
    b = pane.color[2] * a + b * (1 - a);
  }
  return { rgb: [srgbByte(r), srgbByte(g), srgbByte(b)], layers: hits.length, linear: [r, g, b] };
}

/** Mean absolute error and PSNR of an RGBA picture against the reference. Channels are RGB. */
export function pictureError(pixels, scene) {
  const count = scene.width * scene.height;
  if (pixels.length < count * 4) throw new Error('picture is shorter than the scene');
  const by = new Map();
  let abs = 0;
  let sq = 0;
  let max = 0;
  for (let y = 0; y < scene.height; y++) {
    for (let x = 0; x < scene.width; x++) {
      const ref = tracePixel(scene, x, y);
      const i = (y * scene.width + x) * 4;
      let local = 0;
      for (let c = 0; c < 3; c++) {
        const d = pixels[i + c] - ref.rgb[c];
        const a = d < 0 ? -d : d;
        abs += a;
        sq += d * d;
        if (a > max) max = a;
        local += a;
      }
      const row = by.get(ref.layers) ?? { abs: 0, n: 0 };
      row.abs += local;
      row.n += 3;
      by.set(ref.layers, row);
    }
  }
  const samples = count * 3;
  const mse = sq / samples;
  return {
    mae: abs / samples,
    psnr: mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse),
    max,
    samples: count,
    byLayers: [...by.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([layers, row]) => ({ layers, mae: row.abs / row.n, samples: row.n / 3 })),
  };
}
