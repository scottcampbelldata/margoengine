// Proves gltf-pro's parts of the default-scale mesh (test/default-scale.js) cover it exactly: every source vertex is
// in some part, and every source triangle is drawn by exactly one part, unchanged. Quad q of that mesh is corners
// 4q..4q+3, triangulated as (4q, 4q+1, 4q+2) and (4q, 4q+2, 4q+3), in that winding. No imports, so the browser check loads it too.
// `parts`: [{ indices: Uint32Array, vertexMap?: Uint32Array }] (no vertexMap: the part is the whole mesh).
export function partCoverage(parts, corners) {
  const vertexSeen = new Uint8Array(corners),
    triangleSeen = new Uint8Array((corners / 4) * 2);
  let stored = 0,
    largest = 0,
    wrong = 0,
    repeated = 0;
  for (const { indices, vertexMap } of parts) {
    const map = (k) => (vertexMap ? vertexMap[k] : k),
      n = vertexMap ? vertexMap.length : corners;
    stored += n;
    largest = Math.max(largest, n);
    for (let k = 0; k < n; k++) vertexSeen[map(k)] = 1;
    for (let t = 0; t < indices.length; t += 3) {
      // Start each triangle at its lowest corner: that keeps its winding and its vertices' order.
      let a = map(indices[t]),
        b = map(indices[t + 1]),
        c = map(indices[t + 2]);
      if (b < a && b < c) [a, b, c] = [b, c, a];
      else if (c < a && c < b) [a, b, c] = [c, a, b];
      const q = a >> 2,
        first = b === 4 * q + 1;
      if (a !== 4 * q || (first ? c !== 4 * q + 2 : b !== 4 * q + 2 || c !== 4 * q + 3)) {
        wrong++;
        continue;
      }
      const id = 2 * q + (first ? 0 : 1);
      if (triangleSeen[id]) repeated++;
      triangleSeen[id] = 1;
    }
  }
  return {
    parts: parts.length,
    stored,
    largest,
    wrong,
    repeated,
    missingVertices: vertexSeen.length - vertexSeen.reduce((s, v) => s + v, 0),
    missingTriangles: triangleSeen.length - triangleSeen.reduce((s, v) => s + v, 0),
  };
}
