import { Material, Texture, UnlitMaterial, createMesh } from '@margoengine/materials';
import { reliefGeometry, reliefImage } from '@margoengine/sciviz/contour2d';

export const horizontal = 4.72;
export const extent = 15200;
export const heightOf = (elevation) => (elevation - 500) * 0.00068;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** The DEM's elevation at map coordinates (x, y) in metres, bilinear between cell centres. */
export function at(values, n, x, y) {
  const a = clamp01(((x / extent) * n - 0.5) / (n - 1)) * (n - 1),
    b = clamp01(((y / extent) * n - 0.5) / (n - 1)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(a)),
    j = Math.min(n - 2, Math.floor(b)),
    u = a - i,
    v = b - j;
  return (values[j * n + i] * (1 - u) + values[j * n + i + 1] * u) * (1 - v) +
    (values[(j + 1) * n + i] * (1 - u) + values[(j + 1) * n + i + 1] * u) * v;
}
export const position = (x, y, elevation) => [(x / extent - 0.5) * horizontal, heightOf(elevation), (y / extent - 0.5) * horizontal];

// USGS-style hypsometric tint from the valley floors at 570 m to the crater rim at 2550 m.
const stops = [
  { at: 570, color: '#1f4a4c' },
  { at: 1065, color: '#457a72' },
  { at: 1560, color: '#93a97b' },
  { at: 2055, color: '#d9b073' },
  { at: 2550, color: '#fad9ac' },
];

/** The relief block: a terrain mesh with skirts and a baked tint, hillshade and contour image. */
export function installTerrain(engine, values, n) {
  // Cell centres in metres; rows run south (y grows down the map), so the light from the north-west comes from row 0.
  const axis = Float64Array.from({ length: n }, (_, i) => ((i + 0.5) / n) * extent);
  const grid = { x: axis, y: axis, values };
  const size = horizontal * (1 - 1 / n);
  const geometry = reliefGeometry(grid, { size: [size, size], scale: 0.00068, offset: 500, skirt: -0.23 });
  const material = new UnlitMaterial({ color: '#ffffff' });
  // The block's cut sides: dark volcanic soil, lit, so the edges read as a solid model.
  const sides = new Material({ color: '#56665b', roughness: 0.9 });
  const mesh = createMesh(engine, geometry, [material, sides]);
  const images = new Map();
  let texture, key;
  return {
    style(interval, lines) {
      const next = lines ? interval : 0;
      if (next === key) return;
      key = next;
      let image = images.get(next);
      if (!image)
        images.set(next, (image = reliefImage({ ...grid, y: axis.map((v) => extent - v) }, {
          width: 2048, stops, stepped: true, interval, base: 600, index: 5, lineWidth: 3.5, lineOpacity: lines ? 0.72 : 0,
          lineColor: '#1d3735', light: [315, 45], exaggeration: 1.6, shade: 0.5,
        })));
      const previous = texture;
      texture = new Texture(image, { colorSpace: 'srgb', mipmaps: true, anisotropy: 8 });
      material.map = texture;
      previous?.dispose();
    },
    dispose() {
      mesh.destroy();
      texture?.dispose();
      material.dispose();
      sides.dispose();
    },
  };
}
