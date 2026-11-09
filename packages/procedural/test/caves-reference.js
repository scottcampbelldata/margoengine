// Independent test-only scalar oracle; deliberately no separable sums or kernel imports.
export function reference(options) {
  const {
    width: w,
    height: h,
    depth: d = 1,
    seed = 1,
    steps = 5,
    fill = 0.45,
    mode = 'caves',
    birth = d === 1 ? 5 : 14,
    survival = d === 1 ? 4 : 13,
    initial,
  } = options;
  let state = seed >>> 0;
  let grid = Array.from({ length: w * h * d }, (_, p) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return initial ? initial[p] : Number(state / 2 ** 32 < fill);
  });
  const border = (p) => {
    const x = p % w,
      y = Math.floor(p / w) % h,
      z = Math.floor(p / (w * h));
    return x === 0 || x === w - 1 || y === 0 || y === h - 1 || (d > 1 && (z === 0 || z === d - 1));
  };
  grid = grid.map((v, p) => (border(p) ? Number(mode === 'caves') : v));
  for (let step = 0; step < steps; step++)
    grid = grid.map((v, p) => {
      if (border(p)) return v;
      let count = 0;
      for (let z = d === 1 ? 0 : -1; z <= (d === 1 ? 0 : 1); z++)
        for (let y = -1; y <= 1; y++)
          for (let x = -1; x <= 1; x++) if (x || y || z) count += grid[p + x + y * w + z * w * h];
      return Number(count >= (v ? survival : birth));
    });
  return Uint8Array.from(grid);
}

/** Own ray-crossing rasterizer, operating only on standard geographic data. */
export function islandGrid(geojson, ref) {
  const {
    width: w,
    height: h,
    extent: [west, south, east, north],
  } = ref;
  const rings = geojson.features.flatMap((f) =>
    f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates,
  );
  function contains(ring, x, y) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [a, b] = ring[i],
        [c, d] = ring[j];
      if (b > y !== d > y && x < ((c - a) * (y - b)) / (d - b) + a) inside = !inside;
    }
    return inside;
  }
  return Uint8Array.from({ length: w * h }, (_, p) => {
    const x = west + (((p % w) + 0.5) / w) * (east - west),
      y = north - ((Math.floor(p / w) + 0.5) / h) * (north - south);
    return Number(rings.some((poly) => contains(poly[0], x, y) && !poly.slice(1).some((hole) => contains(hole, x, y))));
  });
}
