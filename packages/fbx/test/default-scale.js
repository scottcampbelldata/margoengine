// The largest mesh the default import limits hold, written as a DCC tool exports a flat-shaded or UV-seamed mesh:
// a quad grid whose every corner is its own vertex (per-corner normals, tangents and one UV set), binary FBX with
// zlib-compressed arrays. `n` = 499 gives 996,004 corners, each its own vertex; the default cap is 1,000,000 vertices.
import { binary, A, L } from './fixtures.js';
export function defaultScaleMesh(n = 499, { tangents = true } = {}) {
  const cps = (n + 1) * (n + 1),
    positions = new Float64Array(cps * 3),
    corners = n * n * 4;
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) positions.set([x / n, y / n, Math.sin(x * 0.1) * 0.01], (y * (n + 1) + x) * 3);
  const index = new Int32Array(corners),
    normals = new Float64Array(corners * 3),
    uv = new Float64Array(corners * 2),
    uvIndex = new Int32Array(corners);
  let k = 0;
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x,
        ring = [a, a + 1, a + n + 2, a + n + 1];
      for (let c = 0; c < 4; c++) {
        index[k] = c === 3 ? ~ring[c] : ring[c];
        normals.set([0, 0.001 * ((k % 7) + 1), 1], k * 3);
        uv.set([(x + (c === 1 || c === 2 ? 1 : 0)) / n, (y + (c >= 2 ? 1 : 0)) / n], k * 2);
        uvIndex[k] = k;
        k++;
      }
    }
  const layer = (name, mapping, reference, arrays) => [
    name,
    [0],
    [['MappingInformationType', [mapping]], ['ReferenceInformationType', [reference]], ...arrays],
  ];
  const layers = [
    layer('LayerElementNormal', 'ByPolygonVertex', 'Direct', [['Normals', [A('d', normals)]]]),
    layer('LayerElementUV', 'ByPolygonVertex', 'IndexToDirect', [
      ['UV', [A('d', uv)]],
      ['UVIndex', [A('i', uvIndex)]],
    ]),
  ];
  if (tangents)
    layers.push(
      layer('LayerElementTangent', 'ByPolygonVertex', 'Direct', [
        ['Tangents', [A('d', normals.map((_, i) => (i % 3 === 0 ? 1 : 0)))]],
      ]),
    );
  const bytes = binary(
    [
      [
        'Objects',
        [],
        [
          [
            'Geometry',
            [L(1), 'Geometry::Grid', 'Mesh'],
            [['Vertices', [A('d', positions)]], ['PolygonVertexIndex', [A('i', index)]], ...layers],
          ],
          ['Model', [L(2), 'Model::Grid', 'Mesh']],
        ],
      ],
      [
        'Connections',
        [],
        [
          ['C', ['OO', L(1), L(2)]],
          ['C', ['OO', L(2), L(0)]],
        ],
      ],
    ],
    { compress: true },
  );
  return { bytes, positions, index, corners, controlPoints: cps };
}
