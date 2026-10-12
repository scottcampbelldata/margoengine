# @margoengine/loaders

PLY, 3MF, PCD, OFF, XYZ, legacy VTK and static USDA/USDZ loaders for Margo Engine, each tree-shakable on its own.

Build from source with `npm run build` in `packages/loaders`.

```ts
import {Engine} from '@margoengine/core';
import {load, parse3MF, parsePLY, createMeshes, toGeometry} from '@margoengine/loaders';

const engine = await Engine.create(canvas);

// Fetch with a size limit and an AbortSignal, then parse. Limits go to the parser too.
const model = await load('/parts/bracket.3mf', parse3MF, {signal, maxBytes: 64 << 20, maxTriangles: 2_000_000});
const {meshes, dispose} = createMeshes(engine, model);   // one mesh + PbrMaterial per object color

// Or parse bytes you already have and build a core Geometry yourself.
const scan = parsePLY(await file.arrayBuffer());
mesh.setGeometry(toGeometry(scan, {normals: 'smooth'}));
```

Every parser returns the same `LoadedGeometry`:

```ts
{kind: 'mesh' | 'points', positions: Float32Array, normals?, colors? /* sRGB 0..1 */, uvs?, indices?: Uint32Array,
 groups?: {start, count, name?, objectId?, color?: [r, g, b, a]}[], attributes?: Record<string, Float32Array>}
```

| Function | Replaces (Three.js) | Reads |
| --- | --- | --- |
| `parsePLY` | `PLYLoader` | ASCII, binary little and big endian; x y z, nx ny nz, red green blue (uchar, ushort or float), s/t, u/v, texture_u/texture_v; polygon faces fan-triangulated; files without faces become point clouds; unknown elements and properties skipped |
| `parse3MF` (async) | `ThreeMFLoader` | Own ZIP reader (stored and deflate through `DecompressionStream('deflate-raw')`, CRC-32 checked); objects, meshes, components, build items, 3x4 transforms; `basematerials` and materials-extension `colorgroup` colors; production-extension `p:path` parts; unit conversion to meters |
| `parsePCD` | `PCDLoader` | `DATA ascii`, `binary`, `binary_compressed` (own LZF decompressor); x y z, normal_x/y/z, packed `rgb`/`rgba`, `intensity`, any other field skipped |
| `parseOFF` | none | `OFF` with `ST`, `C`, `N` prefixes (texture coordinates, colors 0..1 or 0..255, normals) |
| `parseXYZ` | `XYZLoader` | xyz, xyz+rgb, xyz+normal, xyz+normal+rgb, xyz+intensity, PTS (xyz+intensity+rgb), chemistry XYZ |
| `parseVTK` | `VTKLoader` (legacy part) | `# vtk DataFile Version` 1.0 to 5.1, ASCII or BINARY `DATASET POLYDATA`: POINTS, POLYGONS, TRIANGLE_STRIPS, 5.x OFFSETS/CONNECTIVITY, point NORMALS, COLOR_SCALARS, TEXTURE_COORDINATES, SCALARS |

Helpers: `toGeometry` (core `Geometry`, flat or smooth normals when missing, per group), `pointsToGeometry` (octahedron markers for clouds), `createMeshes` (engine meshes with `PbrMaterial` colors), `load` / `fetchBytes`, `detectFormat` / `parseAny`, `computeVertexNormals`, `decompressLZF`, `readZipDirectory` / `readZipEntry` / `crc32`, `parsePLYHeader`, `parsePCDHeader`.

## How it works

- **One module per format.** The build is a plain TypeScript emit with `"sideEffects": false`, so importing `parsePLY` pulls in about 3.8 KB gzip and never the 3MF, ZIP or XML code. Only `toGeometry`, `pointsToGeometry` and `createMeshes` import core.
- **Defensive parsing.** Headers are length-capped, every count is checked against `maxVertices` (default 8,000,000) and `maxTriangles` (default 16,000,000) before allocation, binary reads are bounds-checked before the loop, face and cell indices are validated, and ZIP entries are checked against their declared size while inflating (zip-bomb safe) and against CRC-32 afterwards. Every failure is a `LoaderError` with `format` and a `code` of `header`, `truncated`, `limit`, `range`, `syntax`, `unsupported`, `zip`, `aborted` or `fetch`.
- **3MF builds are baked.** Component and build item transforms are multiplied into the positions (Margo Engine meshes take position, rotation and scale only, not arbitrary 3x4 matrices). Mirroring transforms flip the winding back. Triangles are grouped by build item, object and color so `createMeshes` gives each its own material. When a `colorgroup` gives one triangle different corner colors, those objects are split per corner and `colors` is filled.
- **Colors.** Vertex colors are sRGB in [0,1]. `createMeshes` converts group colors to linear for `PbrMaterial`; since core has no vertex colors, meshes with only vertex colors get their average (`vertexColors: 'ignore'` turns that off).
- **SSR safe.** Nothing touches `window`, `document`, `navigator` or `Worker` at import or parse time. `parse3MF` needs `DecompressionStream`, present in browsers and Node 22.

## Options

| Option | Applies to | Default |
| --- | --- | --- |
| `maxVertices` | all parsers | 8,000,000 |
| `maxTriangles` | all parsers | 16,000,000 |
| `units` | `parse3MF` | `'meters'`; `'file'` keeps the model unit |
| `maxEntries`, `maxEntryBytes` | `parse3MF` | 10,000 entries, 512 MiB per part |
| `maxDepth` | `parse3MF` | 32 nested components |
| `signal` | `parse3MF`, `load` | none |
| `keepInvalid` | `parsePCD` | `false` (NaN holes of organized clouds dropped) |
| `layout` | `parseXYZ` | `'auto'` (by column count; 6 columns are rgb unless a value is negative) |
| `maxBytes`, `fetch`, `init` | `load`, `fetchBytes` | 256 MiB, `globalThis.fetch`, none |
| `normals` | `toGeometry`, `createMeshes` | `'auto'` (file normals, else smooth); `'smooth'`, `'flat'` |
| `group` | `toGeometry` | whole mesh |
| `merge`, `color`, `roughness`, `metalness`, `doubleSided`, `parent`, `vertexColors` | `createMeshes` | per group, `#b8bcc4`, 0.6, 0, true, none, `'average'` |
| `size`, `maxPoints` | `pointsToGeometry`, `createMeshes` on clouds | 0.4% of the bounds diagonal, 166,666 |

## Limits

- Core `Geometry` holds positions and normals only, at most 1,000,000 vertices: UVs and vertex colors are kept in `LoadedGeometry` but not rendered, and larger meshes must be split by group. Point clouds render as octahedron markers (subsampled past `maxPoints`) because core has no point primitive.
- PLY face colors and other per-face properties are ignored. OFF per-face colors and binary OFF are not supported. VTK XML (`.vtp`, `.vtu`), other legacy dataset types, VERTICES/LINES cells and cell data are not read. PCD ignores fields other than position, normal, rgb/rgba and intensity.
- 3MF: textures (`texture2dgroup`), composite materials, multi-properties, beam lattices, slices and ZIP64 or encrypted packages are not supported; objects of type `other` are skipped.
- STL, OBJ, STEP and IGES live in the machinery package; glTF in gltf and gltf-pro.

## Tests

`npm test` in `packages/loaders` runs 26 Node tests: every PLY encoding and attribute naming generated in the test, PLY point clouds, OFF and XYZ variants, LZF round trips against an independent compressor, PCD ascii, binary and binary_compressed fixtures, VTK ASCII, big-endian BINARY and 5.1 polydata, ZIP archives with stored and deflate entries (written with `node:zlib`), 3MF components, mirrored transforms, colors, units and production parts, error cases for every format (bad headers, truncation, out-of-range indices, limits, zip bombs, CRC failures, cycles, aborts), `fetchBytes` limits against a local HTTP server, an SSR import check with throwing browser globals, and real files from three.js, PCL, libigl and PyVista (`npm run fixtures` re-downloads them; see `tests/fixtures/SOURCES.txt`) compared with independent reads. `npm run test:browser` loads `facecolors.3mf` in Chromium, creates engine meshes, checks five face colors in the rendered pixels, a GPU pick, `maxBytes`, disposal, and zero WebGPU validation errors.

MIT licensed.

## USD and USDZ

`parseUSDA(textOrBytes, options)` reads static polygon meshes with hierarchy, matrix/translate/scale/rotateXYZ transforms, reset stacks, visibility, Y/Z up, units, winding and constant display/PreviewSurface colors. `parseUSDZ(bytes, options)` validates stored ZIP entries, 64-byte alignment and root-layer CRC before parsing USDA. Both return `LoadedGeometry` for `createMeshes`. `parseAny` detects USDA text and USDZ root filenames; ordinary ZIPs retain 3MF detection.

Triangles and convex planar polygons are supported; meshes must author `subdivisionScheme = "none"`. Binary USDC (the common production USDZ encoding), composition/references, animation, subdivision, hole faces, textures, varying colors and concave polygons are rejected explicitly. Use OpenUSD `usdcat` to convert a binary root; flatten/tessellate unsupported features before loading. File normals and UVs are not retained; normals are recomputed. `units` defaults to `'meters'`; `'file'` keeps authored scale. `maxDepth` defaults to 32 (maximum 64), `maxEntryBytes` to 64 MiB, and vertex/triangle/ZIP limits apply.

Root `npm run modern:test:interop` checks round trips, units, transforms, visibility, winding, topology/composition errors, CRC, alignment, USDC rejection and budgets. Full IFC geometry parsing is provided separately by `@margoengine/ifc` with web-ifc.
