# @margoengine/loaders

Import `margoengine/loaders` from the `margoengine` package, or `@margoengine/loaders` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

PLY, STL, 3MF, DXF, PCD, OFF, XYZ, OBJ/MTL, COLLADA, Tiled TMX, legacy VTK and static USDA/USDZ loaders for Margo Engine, each tree-shakable on its own, plus three optional entries: TrueType fonts and extruded 3D text (`@margoengine/loaders/font`), SVG (`@margoengine/loaders/svg`) and OBJ meshes with their MTL materials and textures (`@margoengine/loaders/mtl`).

Packages that read their own formats import the shared parts without the other parsers: `@margoengine/loaders/common`
(`LoaderError`, `fetchBytes`, `readZipDirectory`, `readZipEntry`, `crc32`, `computeVertexNormals`, `faceNormal` and
the shared types) and `@margoengine/loaders/usd` (`parseUSDA`, `parseUSDZ`, `readUSDA`). Both are also on the root.

Build from source with `npm run build` in `packages/loaders`.

```ts
import {Engine} from 'margoengine/core';
import {load, parse3MF, parsePLY, createMeshes, toGeometry} from 'margoengine/loaders';
import {createMesh} from 'margoengine/materials';
import {box} from 'margoengine/core';
const signal = AbortSignal.timeout(30_000);
const canvas = document.querySelector('canvas')!;

const engine = await Engine.create(canvas);
const mesh = engine.createMesh().setGeometry(box());

// Fetch with a size limit and an AbortSignal, then parse. Limits go to the parser too.
const model = await load('/parts/bracket.3mf', parse3MF, {signal, maxBytes: 64 << 20, maxTriangles: 2_000_000});
const {meshes, dispose} = createMeshes(engine, model);   // one mesh + PbrMaterial per object color

// Or parse bytes you already have and build a core Geometry yourself.
const file = await fetch('/scans/part.ply');
const scan = parsePLY(await file.arrayBuffer());
mesh.setGeometry(toGeometry(scan, {normals: 'smooth'}));
```

Every parser returns the same `LoadedGeometry`:

```text
{kind: 'mesh' | 'points', positions: Float32Array, normals?, colors? /* sRGB 0..1 */, uvs?, indices?: Uint32Array,
 groups?: {start, count, name?, objectId?, color?: [r, g, b, a]}[], attributes?: Record<string, Float32Array>}
```

| Function | Reads |
| --- | --- |
| `parsePLY` | ASCII, binary little and big endian; x y z, nx ny nz, red green blue (uchar, ushort or float), s/t, u/v, texture_u/texture_v; polygon faces fan-triangulated; files without faces become point clouds; unknown elements and properties skipped |
| `parseSTL` | See [STL](#stl) |
| `parse3MF` (async) | Own ZIP reader (stored and deflate through `DecompressionStream('deflate-raw')`, CRC-32 checked); objects, meshes, components, build items, 3x4 transforms; `basematerials` and materials-extension `colorgroup` colors; production-extension `p:path` parts; unit conversion to meters |
| `parseDXF` | ASCII and binary DXF, every version: `$INSUNITS` to meters, LAYER colours and off/frozen layers, ACI and true colours (BYLAYER, BYBLOCK), blocks through INSERT (scale, rotation, rows and columns, nested) and DIMENSION; faces from 3DFACE, SOLID, TRACE, polyface and polygon-mesh POLYLINEs and MESH; line segments from LINE, LWPOLYLINE and 2D/3D POLYLINE (bulge arcs), ARC, CIRCLE, ELLIPSE and SPLINE (NURBS), in each entity's object coordinate system; POINT, TEXT and MTEXT (formatting removed); 3DSOLID, BODY and REGION ACIS data decoded to SAT text. Returns `{mesh, lines, points, texts, layers, solids, unit, version, skipped}`; draw `lines` with `@margoengine/lines` (`mode: 'segments'`) and the mesh double-sided (DXF faces have no winding) |
| `parsePCD` | `DATA ascii`, `binary`, `binary_compressed` (own LZF decompressor); x y z, normal_x/y/z, packed `rgb`/`rgba`, `intensity`, any other field skipped |
| `parseOFF` | `OFF` with `ST`, `C`, `N` prefixes (texture coordinates, colors 0..1 or 0..255, normals) |
| `parseXYZ` | xyz, xyz+rgb, xyz+normal, xyz+normal+rgb, xyz+intensity, PTS (xyz+intensity+rgb), chemistry XYZ |
| `parseVTK` | `# vtk DataFile Version` 1.0 to 5.1, ASCII or BINARY `DATASET POLYDATA`: POINTS, POLYGONS, TRIANGLE_STRIPS, 5.x OFFSETS/CONNECTIVITY, point NORMALS, COLOR_SCALARS, TEXTURE_COORDINATES, SCALARS |
| `parseOBJ` (async), `parseMTL` | See [OBJ and MTL](#obj-and-mtl) |
| `parseDAE`, `flattenDAE` | See [COLLADA](#collada) |
| `parseTMX` (async), `tmxLayerQuads` | See [Tiled TMX](#tiled-tmx) |
| `parseTTF`, `textGeometry` (`/font`) | See [Fonts and 3D text](#fonts-and-3d-text) |
| `parseSVG` (`/svg`) | See [SVG](#svg) |
| `parseBVH` (`/mocap`) | See [Motion capture](#motion-capture-bvh) |
| `parseVRML`, `parseX3D` (`/vrml`) | See [VRML and X3D](#vrml-and-x3d) |
| `parseGCode` (`/gcode`) | See [G-code](#g-code) |
| `parseVDB` (`/vdb`, async) | See [VDB volumes](#vdb-volumes) |
| `parseMaterialX` (`/materialx`) | See [MaterialX](#materialx) |
| `parseLottie` (`/lottie`) | See [Lottie](#lottie) |
| `parseNRRD` (`/nrrd`, async) | See [NRRD volumes](#nrrd-volumes) |
| `parseLDraw` (`/ldraw`, async) | See [LDraw](#ldraw) |
| `parse3MFMaterials` (`/threemf-materials`, async) | See [3MF textures and colour groups](#3mf-textures-and-colour-groups) |
| `parseVTKXML` (`/vtk-xml`, async) | See [VTK XML](#vtk-xml) |
| `parse3DM` (`/3dm`) | See [Rhino 3DM](#rhino-3dm) |
| `parse3DS` (`/3ds`), `parseTDS` (`/tds`) | See [3DS, LWO, AMF, MD2, PDB and KMZ](#3ds-lwo-amf-md2-pdb-and-kmz) |
| `parseLWO` (`/lwo`), `parseAMF` (`/amf`, async), `parseMD2` (`/md2`) | See [3DS, LWO, AMF, MD2, PDB and KMZ](#3ds-lwo-amf-md2-pdb-and-kmz) |
| `parsePDB` (`/pdb`), `parseKMZ` (`/kmz`, async) | See [3DS, LWO, AMF, MD2, PDB and KMZ](#3ds-lwo-amf-md2-pdb-and-kmz) |
| `loadTextures` (`/textures`, async) | See [3DS, LWO, AMF, MD2, PDB and KMZ](#3ds-lwo-amf-md2-pdb-and-kmz) |
| `evaluateNurbsCurve`, `tessellateNurbsCurve`, `evaluateNurbsSurface`, `tessellateNurbsSurface` (`/nurbs`) | See [NURBS curves and surfaces](#nurbs-curves-and-surfaces) |
| `parseLAS` (`/las`, async) | See [LAS and LAZ](#las-and-laz) |
| `loadOBJ`, `createMTLMaterials`, `createOBJMesh` (`/mtl`) | See [Textured OBJ meshes](#textured-obj-meshes) |

Helpers: `toGeometry` (core `Geometry`, flat or smooth normals when missing, per group), `pointsToGeometry` (octahedron markers for clouds), `createMeshes` (engine meshes with `PbrMaterial` colors), `load` / `fetchBytes`, `detectFormat` / `parseAny`, `computeVertexNormals`, `decompressLZF`, `readZipDirectory` / `readZipEntry` / `crc32`, `parsePLYHeader`, `parsePCDHeader`.

## How it works

- **One module per format.** The build is a plain TypeScript emit with `"sideEffects": false`, so importing `parsePLY` pulls in only the PLY reader and its helpers, not the 3MF, ZIP or XML code. In the main entry only `toGeometry`, `pointsToGeometry` and `createMeshes` import core; `/font` and `/svg` import `@margoengine/geometry` (a dependency), and `/mtl` imports `@margoengine/materials` (an optional peer: install it to use that entry).
- **Defensive parsing.** Headers are length-capped, every count is checked against `maxVertices` (default 8,000,000) and `maxTriangles` (default 16,000,000) before allocation, binary reads are bounds-checked before the loop, face and cell indices are validated, and ZIP entries are checked against their declared size while inflating (zip-bomb safe) and against CRC-32 afterwards. Every failure is a `LoaderError` with `format` and a `code` of `header`, `truncated`, `limit`, `range`, `syntax`, `unsupported`, `zip`, `aborted` or `fetch`.
- **3MF builds are baked.** Component and build item transforms are multiplied into the positions (Margo Engine meshes take position, rotation and scale only, not arbitrary 3x4 matrices). Mirroring transforms flip the winding back. Triangles are grouped by build item, object and color so `createMeshes` gives each its own material. When a `colorgroup` gives one triangle different corner colors, those objects are split per corner and `colors` is filled.
- **Colors.** Vertex colors are sRGB in [0,1]. `createMeshes` converts group colors to linear for `PbrMaterial`; since core has no vertex colors, meshes with only vertex colors get their average (`vertexColors: 'ignore'` turns that off). The optional [`/render` entry](#optional-vertex-color-and-opacity-rendering) preserves vertex RGB and opacity through the existing PBR renderer.
- **SSR safe.** Nothing touches `window`, `document`, `navigator` or `Worker` at import or parse time. `parse3MF` needs `DecompressionStream`, present in browsers and Node 22.

## Options

| Option | Applies to | Default |
| --- | --- | --- |
| `maxVertices` | all parsers | 8,000,000 |
| `maxTriangles` | all parsers | 16,000,000 |
| `units` | `parse3MF` | `'meters'`; `'file'` keeps the model unit |
| `maxEntries`, `maxEntryBytes`, `maxRatio` | `parse3MF` | 10,000 entries, 512 MiB per part, a deflated part over 1 MiB may expand at most 200x (zip bombs reach 1,032x); a build expands to at most 100,000 object instances |
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
- glTF lives in gltf and gltf-pro.

## STL

`parseSTL` reads binary and ASCII STL into plain typed arrays and does nothing else: no GPU objects, no parts, no smoothing, and no welding unless you ask. A 204,800-triangle binary file becomes 614,400 vertices, as the file stores them.

```ts
import {parseSTL, toGeometry} from 'margoengine/loaders';
const signal = AbortSignal.timeout(30_000);

const bytes = await (await fetch('/parts/bracket.stl', {signal})).arrayBuffer();
const mesh = parseSTL(bytes, {signal});          // weld: true shares corners that have equal positions
console.log(mesh.positions.length / 9, 'triangles', mesh.colors ? 'with colors' : 'without colors');
const geometry = toGeometry(mesh, {normals: 'flat'}); // a core Geometry, if the mesh is under 1,000,000 vertices
```

| Result | Content |
| --- | --- |
| `positions` | three vertices per triangle in file order (`weld: true`: one vertex per distinct position) |
| `normals` | the file's facet normal on each corner; a zero or non-finite stored normal (many writers leave zero) is replaced by the flat normal computed from the corners. With `weld: true`: smooth area-weighted normals |
| `colors` | binary files using the VisCAM / SolidView color extension (attribute bit 15 set; red bits 10-14, green 5-9, blue 0-4), sRGB 0 to 1, 0.8 gray for facets without one; absent otherwise and for ASCII |
| `indices` | `0, 1, 2, ...`, or the weld's indices |

Options (defaults): `weld: false`, `maxTriangles: 16,000,000`, `maxVertices: 8,000,000` (checked before allocating, so a short file cannot claim millions), `signal` (aborts with a `LoaderError` of code `'aborted'`, checked every 16,384 triangles). A binary file is recognised by its length (`84 + 50 * triangles`), so binary files whose header starts with `solid` still work; otherwise text starting with `solid` is read as ASCII, several solids in one file are concatenated, and keywords are case-insensitive. Errors are `LoaderError`s: `'truncated'` (data shorter than the header says; pass the whole file), `'syntax'`, `'limit'` (raise `maxTriangles` or `maxVertices`), `'header'`, `'aborted'`. The Materialise Magics color variant and per-facet colors in ASCII files are not read.

The repository's speed matrix (`docs/whitepaper`, row 10.11) measures this loader.

## Real files

`tests/real-files/manifest.json` names 123 public files from the tools people use: Blender, 3ds Max, AutoCAD, Rhino, CATIA, PrusaSlicer, Tiled, LightWave and more, each with its URL, licence, author, size and SHA-256. The files are not in this repository.

```sh
npm run test:real-files -w @margoengine/loaders
```

The script downloads each file by URL into `test-results/real-files`, refuses one whose hash differs, opens it and compares it with something independent: the counts in its own header, a second reader written in the script, or a published fact. It exits 1 on a failure and 2 when a file could not be run, such as a site refusing the download.

The MPD proof resolves all 13 embedded submodels and the external library/sticker parts with no missing files or warnings.
The PDAL PTS and Open Babel chemistry XYZ checks compare every coordinate, intensity and colour against the source text.
The real Slic3r ZIP AMF and the plain AMF control compare every placed vertex and triangle against an independent XML
oracle, including constellation translation/rotation. To run those rows on PowerShell:

```powershell
$env:REAL_FILES_ONLY='pts-pdal,xyz-openbabel,mpd-robotic-arm,amf-zipped-slic3r,amf-rook'
npm run test:real-files -w @margoengine/loaders
```

| Variable | Default | What it does |
| --- | --- | --- |
| `REAL_FILES_DIR` | `test-results/real-files` | Where files are kept between runs. |
| `REAL_FILES_ONLY` | every row | Comma-separated formats or row ids. |
| `REAL_FILES_RUNTIMES` | unset | A folder whose `node_modules` holds `rhino3dm` and `laz-perf`. Without it the 3DM rows read NOT RUN, and LAZ rows skip the comparison with laz-perf. `npm run test:real-files:runtimes -w @margoengine/loaders` fetches both into `test-results/real-files-runtimes`, at pinned versions with install scripts off. It is an opt-in test tool: neither runtime is a dependency or ships. |
| `REAL_FILES_RENDER` | unset | `1` draws every geometry through the real engine on the GPU and fails a blank picture. |
| `REAL_FILES_TRACE` | unset | Prints the stack of a failure. |

Neither runtime is a dependency of this package. Install them in a folder of your own.

## Tests

All fixture comparisons are required. Missing files fail with the exact tracked path and a `git restore`
command, and Git LFS pointers fail before parsing. From the repository root, `npm run fixtures --workspace
@margoengine/loaders` refreshes the pinned PCL/PyVista data, with HTTP, size and SHA-256 failures reported
as errors. The OFF comparisons use John Burkardt's
LGPL Geomview box and MC-letter meshes, downloaded by the same hash-checking fetcher.
`node packages/loaders/scripts/make-fixtures.js` regenerates the Margo-authored shapes. Build sibling packages with `npm run build:packages` before the
COLLADA-to-animation integration test.

`npm test` in `packages/loaders` runs Node tests for: OBJ/MTL fixtures covering every statement, map option and error line (and a Crocotile-style file whose triangle corners are checked against values read by hand from the text), COLLADA Y-up and Z-up fixtures (polylist quads, textured phong, TRS stacks, symbol-bound materials, trifans, tristrips, holes, errors; world-space corners checked against the document's transforms worked out by hand), TMX/TSX fixtures (csv, base64 plain, zlib and gzip written with `node:zlib`, legacy tiles, flips and their UVs, external and merged tilesets, infinite chunks, group offsets, errors), every PLY encoding and attribute naming generated in the test, PLY point clouds, OFF and XYZ variants, LZF round trips against an independent compressor, PCD ascii, binary and binary_compressed fixtures, VTK ASCII, big-endian BINARY and 5.1 polydata, ZIP archives with stored and deflate entries (written with `node:zlib`), 3MF components, mirrored transforms, colors, units and production parts, error cases for every format (bad headers, truncation, out-of-range indices, limits, zip bombs, CRC failures, cycles, aborts), `fetchBytes` limits against a local HTTP server, an SSR import check with throwing browser globals, Margo-made PLY, 3MF, PCD and XYZ fixtures (`node scripts/make-fixtures.js` rewrites them; the tests compare against the generator's own arrays and independent reads), and real files from PCL, the LGPL Geomview data collection and PyVista (`npm run fixtures` re-downloads them; see `tests/fixtures/SOURCES.txt`) compared with independent reads. `tests/font.test.js` assembles TrueType fonts in the test from the specification's table layouts (cmap 4 and 12, composites with scale and point matching, kern pairs, collections, both winding conventions); `tests/svg.test.js` covers every path command, arcs, shapes, transforms, fill rules, styles and stroke areas; `tests/mtl.test.js` checks the MTL to material mapping, texture URLs, OBJ groups and `loadOBJ`'s fetches with a stand-in fetch. `npm run test:browser` (a real-GPU script, not in CI) loads `face_colors.3mf` in Chromium, creates engine meshes, checks five face colors in the rendered pixels, a GPU pick, `maxBytes`, disposal, and zero WebGPU validation errors.

Apache-2.0 licensed.

## USD and USDZ

`parseUSDA(textOrBytes, options)` reads static polygon meshes with hierarchy, matrix/translate/scale/rotateXYZ transforms, reset stacks, visibility, Y/Z up, units, winding and display/PreviewSurface colors. Constant colors become `groups[].color` (sRGB). Constant or per-vertex RGB and opacity primvars, indexed or not, and read directly or through `UsdPrimvarReader_float3`/`UsdPrimvarReader_float` nodes, become sRGB `colors` and linear `attributes.opacity`. Other shader graphs and interpolations are refused. `createMeshes` averages vertex RGB and ignores vertex alpha; `createPBRMeshes` from `/render` keeps both. `parseUSDZ(bytes, options)` validates stored ZIP entries, 64-byte alignment and root-layer CRC before parsing USDA. Both return `LoadedGeometry`. `readUSDA(text, {maxDepth, signal, assets, skipOver})` exposes the underlying layer reader (the `def` prim tree with attributes, connections, relationships and property metadata such as `interpolation`); `@margoengine/usdz` builds on it. It skips dictionaries and triple-quoted strings, accepts list-op prefixes (`prepend apiSchemas`) in metadata, and parses numeric arrays on a fast path capped at 16 million values. `parseAny` detects USDA text and USDZ root filenames; ordinary ZIPs retain 3MF detection.

`@margoengine/loaders/worker` exports `parseUSDZInWorker(bytes, options)` and `parseUSDAInWorker(textOrBytes, options)`: the same `LoadedGeometry` (byte for byte, `tests/worker.test.js`) parsed in a worker (`dist/workers/usd.js`, about 6.6 kB min+gzip, [entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)) with its arrays transferred back; errors stay `LoaderError`s. A whole ArrayBuffer input moves to the worker (detached). Without `Worker` they parse on the calling thread.

Triangles and convex planar polygons are supported; meshes must author `subdivisionScheme = "none"`. A prim may reference a prim of the same layer (`references = </Path>`, what `exportUSDZ` writes for a shared geometry), and what it authors wins; class prims are not drawn. Binary USDC (the common production USDZ encoding), any other composition, animation, subdivision, hole faces, textures, uniform/face-varying color interpolation and concave polygons are rejected explicitly. Use OpenUSD `usdcat` to convert a binary root, or load it with `@margoengine/usdz`, which reads USDC natively; flatten/tessellate unsupported features before loading. File normals and UVs are not retained; normals are recomputed. `units` defaults to `'meters'`; `'file'` keeps authored scale. `maxDepth` defaults to 32 (maximum 64), `maxEntryBytes` to 64 MiB, and vertex/triangle/ZIP limits apply.

Root `npm run modern:test:interop` checks round trips, units, transforms, visibility, winding, topology/composition errors, CRC, alignment, USDC rejection and budgets.

## Optional vertex color and opacity rendering

Install `@margoengine/gltf-pro` alongside loaders to use this entry. The decode/root entry does not import it.

```ts
import fs from 'node:fs';
import {dirname, join} from 'node:path';
import {parseUSDZ} from 'margoengine/loaders';
import {createPBRMeshes} from 'margoengine/loaders/render';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const bytes = new Uint8Array(await (await fetch('/model.usdz')).arrayBuffer());

const file = '/models/ship.glb';
const modelUrl = '/models/ship.glb';
const source = await parseUSDZ(bytes);
const model = createPBRMeshes(engine, source, {
  baseColorFactor: [1, 1, 1, 1], // linear material multiplier; default white
  maxBytes: 256 << 20,          // packed geometry budget; default 256 MiB
});
model.root.setScale([-1, 1, 1]);
// Existing PBRModel ownership includes automatic device restoration.
model.dispose();
```

`createPBRMeshes` returns a `PBRModel` (dispose it when done) that renders per-vertex sRGB colors and linear
`attributes.opacity` through `@margoengine/gltf-pro`. Group RGBA fills in only a missing channel; `baseColorFactor`
multiplies the result, and any alpha below one draws blended. `parent`, `normals`, `roughness`, `metalness` and
`doubleSided` work as in `createMeshes`; `unlit` uses the unlit material. It accepts triangle meshes with at most
1,000,000 vertices and 4096 parts, and refuses point clouds, malformed attributes, overlapping groups and data over
`maxBytes` before allocating GPU resources. `npm run test:render:browser` checks the colors on the GPU.

## Files that refer to other files

Parsers stay pure and return plain data. Files a model refers to come through a resolver you pass, `(path) => Promise<Uint8Array | string>`, called with paths relative to the folder of the file being parsed (`../` and `./` already resolved). Images are never read by the loaders: every result lists its texture paths in `images`, in the same form, ready for the same resolver (or `new URL(path, base)` in a browser).

```ts
// Electron (main or preload): read next to the model.
const resolveFromDisk = (path: string) => fs.promises.readFile(join(dirname(file), path));
// Browser: fetch next to the model.
const resolve = async (path: string) => new Uint8Array(await (await fetch(new URL(path, modelUrl))).arrayBuffer());
```

## OBJ and MTL

`await parseOBJ(textOrBytes, {resolve, signal, maxVertices, maxTriangles})` reads `v` (with `w`, or `r g b` vertex colors after xyz, 0..1 or 0..255), `vt`, `vn`, faces of any size with `v`, `v/vt`, `v//vn`, `v/vt/vn` and negative indices, `o`, `g`, `s`, `usemtl` and `mtllib` (several files, or one name with spaces), `\` continuations, comments and CRLF. Other statements (`l`, `p`, curves) are kept in `extras`; malformed lines throw a `LoaderError` naming the line.

- Every distinct `v/vt/vn` corner becomes one vertex, so UV and normal seams survive (a corner without `vt` or `vn` reads zeros when others have them); `positionIndices` maps each vertex back to its `v` line for re-welding.
- `uvs` use Margo's convention: v = 1 - vt v (OBJ has v = 0 at the bottom of the image).
- Faces are fan-triangulated: face f with n = `faceSizes[f]` corners c0..cn-1 gives triangles (c0, ck, ck+1), in file order, so quads and n-gons can be rebuilt from `indices` and `faceSizes`. `smoothingGroups` holds each face's `s` value (0 = off).
- `groups` split at every change of `o`, `g` or `usemtl` and carry `object`, `groupNames` and `material`. With `resolve`, every MTL library is read once (`materials`, first definition of a name wins) and each group gets its material's `Kd` and `d` as `color`, so `createMeshes` colors it. A library the resolver cannot read, or a `usemtl` naming nothing, is a `warnings` entry, not an error.

`parseMTL(textOrBytes, {path})` returns `{name, Ka, Kd, Ks, Ke, Ns, d, Tr, illum, maps, extras}[]`. `maps` holds `map_Kd`, `map_Ka`, `map_Ks`, `map_Ke`, `map_Ns`, `map_d`, `bump` (also written `map_Bump`), `disp`, `decal`, `refl` and any other `map_*` as `{file, path, options}`, where `options` uses the spec's names (`o`, `s`, `t` as three numbers, `clamp`, `blendu`, `blendv`, `cc` as booleans, `bm`, `boost`, `texres`, `mm`, `imfchan`, `type`). Statements it does not interpret, and maps with unknown options, stay in `extras`.

### Textured OBJ meshes

Pass `fetch: manager.fetch` from `@margoengine/cache/manager`'s `LoadingManager` to `load`, `fetchBytes` or `loadOBJ` for shared progress, errors, abort and a URL modifier across loaders (loadOBJ's `mtllib` files and textures included).

`createMeshes` gives core `PbrMaterial` colours only. For textures, `@margoengine/loaders/mtl` builds `@margoengine/materials` meshes (an optional peer dependency: install it to use this entry). One call fetches the .obj, its `mtllib` files next to it and every texture relative to its .mtl file, and draws each `usemtl` group with its material:

```ts
import {loadOBJ} from 'margoengine/loaders/mtl';
import {Engine} from 'margoengine/core';
const signal = AbortSignal.timeout(30_000);
const engine = await Engine.create(document.querySelector('canvas')!);

const {mesh, warnings, dispose} = await loadOBJ(engine, 'https://example.com/models/chair.obj', {signal});
// mesh is a materials mesh (a gltf-pro model): move it with mesh.root, add it to shadows, clustered, ...
dispose(); // destroys the mesh, its materials and its textures
```

Or step by step, with your own bytes and texture loader:

```ts
import {parseMTL, parseOBJ} from 'margoengine/loaders';
import {createMTLMaterials, createOBJMesh} from 'margoengine/loaders/mtl';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const bytes = new Uint8Array(await (await fetch('/crate.mtl')).arrayBuffer());

const objUrl = '/models/crate.obj';
const resolve = async (path: string) => new Uint8Array(await (await fetch(new URL(path, new URL(objUrl, location.href)))).arrayBuffer());
const obj = await parseOBJ(bytes, {resolve});
const set = await createMTLMaterials(obj.materials, {baseUrl: objUrl, bump: 'normal'});
const mesh = createOBJMesh(engine, obj, set); // one mesh, one material slot per usemtl material
// parseMTL output resolves against the .mtl URL instead: createMTLMaterials(parseMTL(text), {baseUrl: mtlUrl}).
```

- Each `newmtl` becomes a metallic-roughness `Material`: `Kd` colour (sRGB to linear), `d` or `1 - Tr` opacity (transparent below 1 or with `map_d`), `Ke` emission (values over 1 go to `emissiveIntensity`), roughness from `Ns` as `(2 / (Ns + 2))^(1/4)` (Ns 10 gives 0.64, 100 gives 0.37, 1000 gives 0.21; 1 with `illum 1` or a black `Ks`), and the PBR extension's `Pr` and `Pm` when present. `illum 0` is unlit.
- Maps: `map_Kd` (colour), `map_Ke` (emission), `bump`/`map_Bump` (bump map scaled by `-bm`, or a normal map with `bump: 'normal'`, as many exporters write them), `norm` (normal map) and `map_d` (opacity). `-o` and `-s` become the slot's UV transform, `-clamp on` clamped wrapping. Each file loads once per colour space.
- `Ka`, the `Ks` colour, `Ni`, `Tf`, `map_Ka`, `map_Ks`, `map_Ns`, `disp`, `decal`, `refl` and other statements have no Margo equivalent; they and any texture that fails to load are listed in `warnings` instead of throwing.
- An OBJ and its MTL files are untrusted input. `loadOBJ` reads `mtllib` files and textures only from the OBJ's own directory (same origin, no `../` past it) or a prefix in `allowedURLs` (default none): a library elsewhere throws a `LoaderError` with code `'url'` naming `allowedURLs`, a texture elsewhere is a warning and is not requested. `init` (headers, credentials) is sent only to the OBJ's origin, never to an allowed library on another origin (a custom `fetch` sees every request, so it decides for itself). The libraries share one budget: at most `maxMaterialLibraries` files (default 16) holding `maxMaterialBytes` together (default 64 MiB); more throws a `LoaderError` with code `'limit'`. `parseOBJ` applies the same budget to its `resolve`, and `createMTLMaterials` the same directory rule to map paths against `baseUrl` (with its own `allowedURLs`).
- The mesh gets the OBJ's UVs back with v up (for `flipY` textures), vertex colours in linear, and smooth normals shared across UV seams when the file has none. Groups without a known material use `fallback` (default a white `Material`). `prepareOBJMesh` returns the geometry and material array without creating the mesh. At most 1,000,000 vertices (a materials mesh limit). Front faces only unless `doubleSided: true`. Textures load with materials' `loadTexture` (http(s), blob: and data: URLs) unless you pass `loadTexture`.

## Fonts and 3D text

`@margoengine/loaders/font` reads TrueType fonts into an `OutlineFont` and extrudes text with `@margoengine/geometry`:

```ts
import {parseTTF, textGeometry} from 'margoengine/loaders/font';
import {createMesh, Material} from 'margoengine/materials';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);

const font = parseTTF(await (await fetch('/fonts/Inter.ttf')).arrayBuffer());
const geometry = textGeometry('Margo\nEngine', {font, size: 1, depth: 0.2, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.01});
createMesh(engine, geometry, [new Material({color: '#ffffff'}), new Material({color: '#3355ff'})]); // caps, sides

const shapes = font.generateShapes('Logo', 10, {letterSpacing: 0.05, align: 'center'}); // geometry Shapes with holes
```

- `parseTTF(bytes, {fontIndex})` follows the OpenType specification: `head`, `hhea`, `maxp`, `hmtx`, `loca` (short and long), `glyf` simple and composite glyphs (offsets, scale, x/y scale, 2x2 transforms, point matching, nesting), `cmap` formats 4 and 12 (Unicode, and symbol fonts at U+F000), `kern` format 0 pairs (Microsoft and Apple headers) and the family and style names. `fontIndex` picks one font of a `.ttc` collection. Glyphs decode on first use.
- `font.generateShapes(text, size, {letterSpacing, lineHeight, align, kerning})` lays out text with one em = `size`: baseline at y = 0, `\n` for new lines, kerning on by default, `letterSpacing` in ems. Holes come from nesting and the winding rule, not from one fixed contour direction, so fonts written either way round work. Missing characters draw the font's `.notdef` glyph.
- `textGeometry(text, {font, size, depth, curveSegments, bevelEnabled, bevelThickness, bevelSize, bevelOffset, bevelSegments, steps})` defaults to size 100, depth 50 and no bevel, and returns `GeometryData` with groups 0 (caps) and 1 (sides).
- Limits: CFF outlines (`.otf` files starting `OTTO`), WOFF and WOFF2 throw a `LoaderError` with code `unsupported` (convert them to `.ttf`); kerning comes from the `kern` table only (GPOS kerning is not applied); no hinting, ligatures, right-to-left or complex-script shaping (`@margoengine/text` draws screen text).

## SVG

`@margoengine/loaders/svg` turns SVG drawings into geometry `Shape`s and stroke triangles:

```ts
import {parseSVG} from 'margoengine/loaders/svg';
import {extrudeGeometry} from 'margoengine/geometry';
import {SRGBToLinear} from 'margoengine/math/color';
import {Engine} from 'margoengine/core';
import {createMesh, Material} from 'margoengine/materials';
const engine = await Engine.create(document.querySelector('canvas')!);

const {paths, viewBox, warnings} = parseSVG(await (await fetch('/logo.svg')).text());
for (const path of paths) {
  if (path.fill) {
    const geometry = extrudeGeometry(path.toShapes({flipY: true}), {depth: 2, bevelEnabled: false});
    createMesh(engine, geometry, new Material({color: path.fill.map(SRGBToLinear), opacity: path.fillOpacity}));
  }
  if (path.stroke)
    createMesh(engine, path.toStrokeGeometry({flipY: true}), new Material({color: path.stroke.map(SRGBToLinear)}));
}
```

- Elements: `path` (M L H V C S Q T A Z, absolute and relative, packed numbers and arc flags), `rect` (rounded), `circle`, `ellipse`, `line`, `polyline`, `polygon`, inside `g`, `a`, nested `svg` viewports (`viewBox`, `preserveAspectRatio`) and `use` of `defs` content or `symbol`s. `transform` lists with `matrix`, `translate`, `scale`, `rotate` (with a centre), `skewX` and `skewY` compose through every level.
- Each path has `commands` (M L Q C Z in root user units, arcs as cubic Béziers), `fill` and `stroke` (sRGB 0..1 or null), `fillOpacity` and `strokeOpacity` (including the colour's alpha and group `opacity`), `fillRule`, `strokeWidth`, `strokeLineJoin`, `strokeLineCap` and `strokeMiterLimit`. Styles come from attributes, `style` and `<style>` rules with type, class and id selectors, inherited as SVG does, with `currentColor`, named colours, `#rgb[a]`, `#rrggbb[aa]`, `rgb()` and `hsl()`.
- `toShapes({flipY})` applies the path's fill rule (`nonzero` or `evenodd`) to find holes. `toStrokeGeometry({flipY, width, divisions})` returns the stroke as flat triangles on z = 0 facing +z, with miter (and miter limit), round or bevel joins and butt, round or square caps, built in the element's units and then transformed. Its triangles may overlap, so a transparent stroke darkens where they do.
- Coordinates stay in root user units with y down, as in the file (the root `viewBox` is reported, not applied): `flipY` makes the drawing upright in a y-up scene.
- Not drawn, each listed in `warnings`: `text`, `image`, clip paths, masks, markers, patterns, filters and dashes; gradients fill with the average of their stop colours. CSS beyond simple selectors, and `@` rules, are skipped.

## COLLADA

`parseDAE(textOrBytes, {maxVertices, maxTriangles})` reads COLLADA 1.4.1 and 1.5 (`.dae`) and returns `{upAxis, meter, geometries, materials, images, nodes, cameras, lights, warnings}`, already converted to Y-up meters (`Z_UP` and `X_UP` rotate per the spec's axis table, `unit meter` scales geometry and translations).

- `geometries`: each `<mesh>` as a `LoadedGeometry` plus `id`, `name`, `faceSizes` and `positionIndices`, from `<triangles>`, `<polylist>` (`vcount` kept as `faceSizes`), `<polygons>`, `<trifans>` and `<tristrips>` with VERTEX/POSITION, NORMAL, TEXCOORD (lowest `set`, v flipped to 1 - t) and COLOR inputs at any offset, in the primitive or in `<vertices>`. One group per primitive with its material `symbol`. Corners are welded per primitive, so seams survive.
- `materials`: `profile_COMMON` `constant`, `lambert`, `phong` and `blinn` with `emission`, `ambient`, `diffuse`, `specular`, `reflective` and `transparent` as `{color}` or `{texture: {path, texcoord}}` (through 1.4.1 sampler2D, surface and image, 1.5 `instance_image`, or a bare image id), `opaque`, `shininess`, `reflectivity`, `transparency`, `indexOfRefraction`.
- `images`: the texture paths materials use, relative to the .dae folder (`file:///C:/a%20b.png` becomes `C:/a b.png`), for your resolver.
- `nodes`: the instanced visual scene as `{id, name, matrix, instances, children}`, `matrix` being the node's matrix/translate/rotate/scale/lookat/skew stack (column-major, Y-up meters); `instances` are `{geometry, materials}` with `bind_material` symbols mapped to material indices; `instance_node` is expanded (at most 64 deep and 100,000 nodes).
- Not imported, each reported in `warnings`: `<lines>` and `<linestrips>`, polygon holes (the outer polygon is kept), embedded image data, non-mesh geometry, cameras and lights without `technique_common` optics or light (profile-specific techniques), and the controllers, joints and animation channels described below when they do not resolve. A degenerate `lookat` (eye on the interest point, or up along the view) keeps only its eye; a degenerate `skew` is skipped; both are warned.

`flattenDAE(dae, pose?)` bakes the hierarchy into one `LoadedGeometry` (mirrored nodes keep outward winding) with a group per node instance and primitive, named after the node and colored with the bound material's diffuse color, so `createMeshes(engine, flattenDAE(dae))` shows the scene. Skinned and morphed instances are deformed: at rest without a pose, animated with `flattenDAE(dae, poseDAE(dae, seconds))`.

### Collada cameras, lights, lookat and skew

- `lookat` (eye, interest, up) is the matrix that puts a frame at the eye looking down its -Z at the interest point: columns side = forward x up, true up = side x forward, -forward and the eye. `skew` (degrees, rotation axis, translation axis) is the RenderMan skew the spec adopts: points slide parallel to the translation axis so that the rotation axis turns by the angle toward it (x' = x + tan(angle) y for `45 0 1 0 1 0 0`). Both are stack elements like the others, so channels animate them by sid, whole (`node/look`, 9 values) or one value (`node/look(0)` is the eye's x).
- `cameras`: every `<instance_camera>` in scene order (one per `instance_node` copy) as `{id, name, node, type, perspective | orthographic, matrix}`. `perspective` keeps what the file gives (`xfov`, `yfov`, `aspectRatio`, full angles in degrees) and `orthographic` `xmag`/`ymag` (read as half-width and half-height, like glTF's); `znear`, `zfar` and magnifications are in meters. `matrix` is the camera's frame at rest in Y-up meters, looking down its -Z with +Y up (the node's world matrix times the up-axis rotation, so a `Z_UP` camera still looks where it did); `daeFrame(dae, node, pose)` gives it at a pose.
- `daeCameraView(dae, index, {pose, aspect})` returns what core's camera takes, `{position, target, up, fov, near, far, aspect, project}`: `yfov` is the vertical fov; `xfov` with `aspect_ratio` gives yfov = 2 atan(tan(xfov / 2) / aspect); `xfov` and `yfov` keep yfov and fix the aspect at tan(xfov / 2) / tan(yfov / 2); `xfov` alone needs `{aspect}` (the viewport's). All three warn and drop `aspect_ratio`. Orthographic views set `project` (half-height `ymag`, or `xmag / aspect_ratio`, or `xmag` over the viewport's aspect; WebGPU reversed depth) and perspective views clear it, so `Object.assign(engine.camera, view)` switches either way. `target` is one meter ahead.
- `lights`: every `<instance_light>` as `{id, name, node, type, color, position, direction, matrix}` (`ambient`, `directional`, `point`, `spot`; `direction` is the frame's -Z, the way the light travels) with `constantAttenuation`, `linearAttenuation` and `quadraticAttenuation` for point and spot (defaults 1, 0, 0, converted so distance is in meters) and `falloffAngle` (the full cone, default 180) and `falloffExponent` (default 0) for spot.
- `daeEngineLights(dae, {pose, intensity})` converts them: each color splits into a unit color and its brightest channel as the intensity (times `intensity`). The first directional light is `sun`, for core's `engine.scene.lighting` (`toward` the light); others are `directional`, for `@margoengine/clustered/directional`; ambient lights sum into `ambient` for core's `scene.lighting.ambient` and `radiance[3]`. Point and spot lights become `local` entries for `Clustered.setLights` (`position`, `range`, `color`, `intensity`, `decay`, and `direction`, `outerAngle`, `innerAngle` for spots). Approximations: `1 / (c + l d + q d^2)` keeps only its strongest set term (q: `decay` 2 and intensity / q; else l: `decay` 1; else c: `decay` 0 and unlimited `range`), matching far away and brighter close to the light; `range` ends where the light falls to 1/256; `outerAngle` is half the falloff angle (at most a hemisphere) and the `cos^e` falloff becomes a smooth edge starting where cos^e is 1/2 (`innerAngle`), a hard edge for e = 0.

```ts
import {parseDAE, daeCameraView, daeEngineLights} from 'margoengine/loaders';
import {Clustered} from 'margoengine/clustered';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const text = await (await fetch('/text.txt')).text();
const dae = parseDAE(text);
if (dae.cameras.length) Object.assign(engine.camera, daeCameraView(dae, 0, {aspect: 16 / 9}));
const {sun, ambient, local} = daeEngineLights(dae);
if (sun) {
  engine.scene.lighting.direction.set([...sun.toward, sun.intensity]);
  engine.scene.lighting.radiance.set(sun.color);
}
if (ambient) {
  engine.scene.lighting.ambient.set(ambient.color);
  engine.scene.lighting.radiance[3] = ambient.intensity;
}
Clustered.attach(engine).setLights(local);
```

### Collada skins, morphs and animation

The result also has `skins`, `morphs`, `animations` and `clips`, all in the same Y-up meters as the geometry: node transforms, `bind_shape_matrix`, inverse bind matrices and animated values go through one conversion, so a `Z_UP` centimeter rig poses exactly like its Y-up meter twin.

- `skins`: each `<controller><skin>` as `{id, name, geometry, morph, bindShapeMatrix, joints, inverseBindMatrices, vertexJoints, vertexWeights}`. `joints` come from `Name_array` (sids) or `IDREF_array` (node ids); `vertex_weights` (`vcount`/`v`) keep the strongest four influences per `<vertices>` position, renormalised to sum 1, joint -1 being the bind shape. A skin may wrap a morph.
- `morphs`: each `<controller><morph>` as `{id, name, method, base, targets, weights}`; `NORMALIZED` blends (1 - sum w) base + sum w target, `RELATIVE` base + sum w target, position by position. `morphDAE(dae, morph, weights?)` returns the blended mesh (normals included), in the base mesh's vertex order.
- `<instance_controller>` adds an instance with `skin` and/or `morph`; `joints` lists the joint nodes, found by sid under its `<skeleton>` roots (else by id or name, else anywhere in the scene). A joint that names no node is reported and the instance stays unskinned.
- `animations`: every `<animation>`, nested ones included (each names its `parent`), with `channels` `{target, node, transform, morph, index, sampler}`. Targets address a node transform by sid, whole (`node/transform` matrix, `node/location` translate) or one value (`.X`, `.Y`, `.Z`, `.ANGLE`, `(i)`, and `(row)(column)` in a matrix), or a morph weight (`morph/weights(i)` or `weightsSource(i)`). Samplers keep `LINEAR`, `STEP`, `BEZIER` (2D `(time, value)` tangents, or value-only ones at a third of the segment) and `HERMITE` (value tangents) keys; `sampleDAESampler(sampler, seconds)` evaluates one, other interpolations sample as `LINEAR` with a warning. `clips` are `<animation_clip>`s `{id, name, start, end, animations}`.
- `poseDAE(dae, seconds, {clip})` gives every node's `local` and `world` matrix and every morph's `weights` at a time (a clip's time 0 is its `start`).

To play a rig on the GPU, `bindDAESkin(dae, instance?)` gives the animation package's `Skeleton` and `Skin` their inputs: the joint nodes and their ancestors as bones (named by `daeNodeNames`, split into translation, rotation and scale), inverse bind matrices, and four joints and weights per vertex of `geometry`, the mesh in its bind shape. Bones live in scene space, so keep the mesh at the scene root. `daeKeyframeClip(dae, {clip, fps})` turns the channels into `createKeyframeClip` input: COLLADA channels move single transform elements, so each animated node is sampled at its key times and every `1 / fps` second (default 30) and split into translation, rotation and scale tracks (nodes that only STEP keep their keys, `discrete`); animated morphs become `weights` tracks.

```ts
import {parseDAE, bindDAESkin, daeKeyframeClip, morphDAE, poseDAE} from 'margoengine/loaders';
import {Skeleton, Skin, createKeyframeClip, applyKeyframeClip, segmentTime} from 'margoengine/animation';
import {Material, createMesh} from 'margoengine/materials';
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const text = await (await fetch('/text.txt')).text();
const dae = parseDAE(text);
const binding = bindDAESkin(dae); // the first skinned instance
const skeleton = new Skeleton(binding.bones, binding.inverseBindMatrices);
const body = createMesh(engine, binding.geometry, new Material({color: '#c08060'}));
Skin.attach(body, skeleton, binding.joints, binding.weights);
const clip = createKeyframeClip(daeKeyframeClip(dae, {fps: 60}));
// A morphed (unskinned) instance: blend on the CPU and replace the geometry.
const face = dae.morphs.length ? createMesh(engine, morphDAE(dae, 0), new Material({color: '#e0b090'})) : undefined;
let elapsed = 0;
function frame(delta: number): void {
  elapsed += delta;
  const time = segmentTime(elapsed, clip.duration, {loop: true});
  applyKeyframeClip(clip, skeleton, time); // the GPU skin follows next frame
  face?.setGeometry(morphDAE(dae, 0, poseDAE(dae, time).weights[0]));
}
```

`Skin` takes no morph targets, so a morph is blended on the CPU (`morphDAE`), and a skin over a morph re-binds with `bindDAESkin(dae, instance, {weights})` and `setGeometry`. Without the animation package, `flattenDAE(dae, poseDAE(dae, seconds))` bakes any frame on the CPU.

## Motion capture (BVH)

`parseBVH(textOrBytes, {scale, name, maxJoints, maxKeys})` from `./mocap` reads Biovision HIERARCHY and MOTION into bones and a clip the animation package plays. BVH has no unit: `scale: 0.01` turns centimetres to metres (default 1). Euler channels apply in the order the file lists them, and a position channel moves the joint from its OFFSET. `End Site` offsets sit on the bone as `endSite`. The defaults are 4,096 joints and 4,000,000 keys.

```ts
import { Skeleton, applyKeyframeClip, createKeyframeClip } from '@margoengine/animation';
import { parseBVH } from '@margoengine/loaders/mocap';

const file = `HIERARCHY
ROOT Hips { OFFSET 0 90 0 CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation }
MOTION
Frames: 2
Frame Time: 0.5
0 0 0 0 0 0
0 0 10 0 45 0
`;
const { bones, clip } = parseBVH(file, { scale: 0.01 });
const skeleton = new Skeleton(bones);
applyKeyframeClip(createKeyframeClip(clip), skeleton, 0.25);
```

## VRML and X3D

`parseVRML(textOrBytes, options)` reads VRML97 (`#VRML V2.0 utf8`) and `parseX3D(textOrBytes, options)` reads X3D XML, both from `./vrml`, into one `LoadedGeometry` with a group per Shape, so `toGeometry` takes the result. Transform (with `center` and `scaleOrientation`), Group, Anchor, Collision and Billboard nest and bake into world space; Shape, Appearance, Material, IndexedFaceSet with normals, colours and texture coordinates per vertex or per face, `ccw` and DEF/USE are read. `v` turns to Margo's convention, with 0 at the image's top. Anything else, such as Box, Inline, PROTO instances and textures, is left out and named in `warnings`. `maxNodes` (default 1,000,000) counts each USE again, so a file of nested USEs stops early.

```ts
import { parseVRML } from '@margoengine/loaders/vrml';

const scene = parseVRML(`#VRML V2.0 utf8
Transform { translation 0 1 0 children
  Shape {
    appearance Appearance { material Material { diffuseColor 1 0.5 0 } }
    geometry IndexedFaceSet { coord Coordinate { point [0 0 0, 1 0 0, 0 1 0] } coordIndex [0 1 2 -1] }
  }
}`);
console.log(scene.groups?.[0].color, scene.warnings);
```

## G-code

`parseGCode(textOrBytes, {maxVertices})` from `./gcode` reads RepRap toolpaths: G0 and G1 with X, Y, Z, E; G90, G91, M82, M83; G92; G20, G21; G28. Layers come by rising Z, each with `extrusion` (moves that push material) and `travel` (moves that lead into it), two points per segment. Coordinates stay the machine's: millimetres, Z up. G2 and G3 arcs move the position without drawing and add a warning.

```ts
import { parseGCode } from '@margoengine/loaders/gcode';

const { layers, filament, min, max } = parseGCode('G1 Z0.2\nG1 X10 E1\nG1 Y10 E2\n');
const first = { mode: 'segments', positions: layers[0].extrusion };
console.log(first.positions.length, filament, min, max);
```

## NRRD volumes

`parseNRRD` from `@margoengine/loaders/nrrd` reads the NRRD files CT and MRI tools write, `.nrrd` and detached `.nhdr`, into the arrays `fig.volume()` of `@margoengine/sciviz` takes. It reads raw, ascii, hex and gzip data in either byte order, `line skip`, `byte skip` (with -1 for the end of a raw file), and one data file, a printf pattern such as `slice%03d.raw` or a `LIST`, each with its optional `subdim` (by default one slice along the slowest axis per file, and the file count must match). Samples stay in the file's own type; 64-bit integers become `Float64Array`, exact up to 2^53.

```ts
import { parseNRRD } from '@margoengine/loaders/nrrd';

const header = 'NRRD0004\ntype: short\ndimension: 3\nsizes: 2 2 1\nspace: LPS\n' +
  'space directions: (0.5,0,0) (0,0.5,0) (0,0,2)\nspace origin: (10,0,0)\nencoding: ascii\n\n';
const scan = await parseNRRD(new TextEncoder().encode(`${header}0 100 200 300\n`));
console.log(scan.dims, scan.spacing, scan.bounds, scan.matrix);
// With a figure: fig.volume(scan.data, { dims: scan.dims, bounds: scan.bounds });

// A .nhdr header reads its data through resolve, by the path the header names.
const detached = 'NRRD0004\ntype: uchar\ndimension: 1\nsizes: 2\nencoding: raw\ndata file: body.raw\n';
const { data } = await parseNRRD(new TextEncoder().encode(detached), {
  resolve: async (path) => new Uint8Array([path.length, 1]),
});
console.log(data);
```

- `dims` holds the spatial axes, the first fastest. A leading non-spatial axis (an RGB `kinds` entry, or `none` in `space directions`) is `components`; axes after the spatial ones, such as time, are `frames`. A sample sits at `(((t * nz + z) * ny + y) * nx + x) * components + c`.
- `bounds` is the box in true proportions from 0. `matrix` takes a voxel index to the file's `space`, with its origin, rotation and flips: use it to line a scan up with other data.
- `resolve` gets the path as the header writes it, tidied of `.` and `..`. It is your code: keep it inside the folder you trust.
- The header is checked against the format: the magic is `NRRD0001` to `NRRD0005` alone on its line, a field newer than the magic (key/value pairs before 0002, `kinds` before 0003, `space` fields and several data files before 0004) is a `header` error, as is an unknown `space` or a kind on an axis of the wrong size (`RGB-color` needs 3). ASCII floats follow the format's rule: any word with `nan` is NaN, then `-inf` and `inf`.
- `maxSamples` (default 536,870,912) stops a huge declared size before anything is allocated. Data past what the header needs is ignored, as the format says: gzip and bzip2 decoding stop once the samples are out, so a small file never inflates to more than it needs. `bzip2` data needs `@margoengine/decoders`. The `block` type has no array form and is an `unsupported` error.

## LDraw

`parseLDraw` from `@margoengine/loaders/ldraw` reads LDraw brick models, `.ldr`, `.dat` and multi-part `.mpd`, into one mesh with a group per colour, plus the model's edge lines. Parts load through `resolve` from an LDraw library folder you host, and a part nobody can find is listed in `missing` while the rest of the model still loads.

```ts
import { parseLDraw } from '@margoengine/loaders/ldraw';

const parts: Record<string, string> = { 'parts/plate.dat': '0 BFC CERTIFY CCW\n4 16 0 0 0 20 0 0 20 0 20 0 0 20\n2 24 0 0 0 20 0 0\n' };
const model = await parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 plate.dat\n', {
  resolve: async (path) => {
    if (path in parts) return parts[path];
    throw new Error(`no ${path}`);
  },
});
console.log(model.groups[0].name, model.lines.length, model.missing);
```

A normal `.ldr` is mostly references, so without a library it draws almost nothing and lists its parts in `missing`. Download the "Complete" library from [ldraw.org](https://www.ldraw.org), unzip it where your site serves files, and pass `resolveFromURL`, which takes `fetch` and `signal`. The library is not part of this package.

```ts
import { parseLDraw, resolveFromURL } from '@margoengine/loaders/ldraw';

const text = '1 4 0 0 0 1 0 0 0 1 0 0 0 1 3024.dat\n';
const model = await parseLDraw(text, { resolve: resolveFromURL('/ldraw/') });
console.log(model.missing);
```

- **Colours.** 16 takes the colour of the reference above it and 24 that colour's edge. `0x2RRGGBB` is a direct colour. `0 !COLOUR` lines and `LDConfig.ldr` fill the palette, read through `resolve` or passed as `config`; without one, the 16 classic colours apply and an unknown code draws light grey with a warning.
- **Parts.** Each reference tries `searchPaths` in order, in lower case with forward slashes. An MPD pack's own files win over the library, and each file is read once.
- **Winding.** A file with `0 BFC CERTIFY` keeps its winding through mirrors, `CW` and `INVERTNEXT`. Polygons of an uncertified file, or inside `NOCLIP`, are written on both sides, so they draw correctly with back faces culled. Each file's own certification decides, so a certified part inside a plain `.ldr` model still culls.
- **Repeated parts.** `instanced: true` keeps each placed `.dat` part in each colour as one geometry with a matrix per placement, in `model.instances`, so a wall of a thousand alike bricks stores one brick and draws in one call. The main mesh and lines then hold only what is not a placed part, and mirrored placements, which stay expanded because a renderer's winding does not follow a mirrored matrix. See the example below.
- **Units.** By default 1 LDraw unit is 0.4 mm and the model turns Y up. `units: 'file'` keeps LDraw units with -Y up.
- **Lines.** `lines` and `lineColors` go to `@margoengine/lines` in `segments` mode. `conditionalLines` holds four points each: the two ends, then the two control points that decide whether to draw it. `edges: false` drops them all.
- **Limits.** `maxDepth` (64), `maxInstances` (4,000,000) and the shared vertex and triangle limits stop a file of doubling references. Texture maps (`!TEXMAP`) are skipped with a warning.


Drawing repeated parts with `@margoengine/materials`, one instanced mesh a part:

```ts
import { createStage } from '@margoengine/stage';
import { computeVertexNormals } from '@margoengine/loaders/common';
import { parseLDraw } from '@margoengine/loaders/ldraw';
import { createInstancedMesh, Material } from '@margoengine/materials';

const stage = await createStage('#viewport', { backend: 'webgpu' });
const brick = '3 16 0 0 0 20 0 0 0 0 20\n3 16 20 0 0 20 0 20 0 0 20\n';
const row = Array.from({ length: 100 }, (_, i) => `1 4 ${i * 20} 0 0 1 0 0 0 1 0 0 0 1 brick.dat`).join('\n');
const model = await parseLDraw(row, {
  instanced: true,
  resolve: async (path) => (path === 'parts/brick.dat' ? brick : Promise.reject(new Error('not here'))),
});
for (const { positions, indices, groups, matrices } of model.instances) {
  const materials = groups.map(({ color }) => new Material({ color: color as [number, number, number, number] })),
    geometry = {
      positions,
      normals: computeVertexNormals(positions, indices),
      indices,
      groups: groups.map(({ start, count }, materialIndex) => ({ start, count, materialIndex })),
    },
    mesh = createInstancedMesh(stage.engine, geometry, materials, matrices.length / 16);
  for (let i = 0; i < matrices.length / 16; i++) mesh.instances.setMatrixAt(i, matrices.subarray(i * 16, i * 16 + 16));
}
```

## 3MF textures and colour groups

`parse3MFMaterials` from `@margoengine/loaders/threemf-materials` reads a 3MF package like `parse3MF` and adds the materials extension: `texture2d` images, `texture2dgroup` coordinates, `compositematerials` and `multiproperties`. The plain `parse3MF` stays as small as it was.

```ts
import { parse3MFMaterials } from '@margoengine/loaders/threemf-materials';

const bytes = await (await fetch('/prints/lithophane.3mf')).arrayBuffer();
const { groups, textures, uvs } = await parse3MFMaterials(bytes);
const image = await createImageBitmap(new Blob([textures[groups[0].texture ?? 0].data.slice()]));
console.log(image.width, uvs?.length);
```

- **Vertices.** Every triangle corner gets its own vertex, so `uvs` and `colors` can differ across a seam. `uvs` use v = 1 minus the file's v, and a mirrored build item keeps each coordinate on its corner.
- **Groups.** A group's `texture` indexes `textures`; a triangle without one falls in a separate group. Each texture carries its image bytes, `contentType`, `tileStyleU`, `tileStyleV` and `filter`.
- **Composites.** `compositematerials` mix their base colours by weight into one colour.
- **Layers.** In `multiproperties`, colour layers mix by their alpha and the first texture layer sets the group's texture, so draw `colors` as a tint over it. Blend methods other than mix are read as mix.

## VTK XML

`parseVTKXML` from `@margoengine/loaders/vtk-xml` reads the XML files ParaView and most simulation tools write: `.vtp` PolyData and `.vtu` unstructured grids.

```ts
import { parseVTKXML } from '@margoengine/loaders/vtk-xml';

const file = `<VTKFile type="PolyData"><PolyData><Piece NumberOfPoints="3" NumberOfPolys="1">
  <Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">0 0 0 1 0 0 0 1 0</DataArray></Points>
  <Polys><DataArray type="Int32" Name="connectivity" format="ascii">0 1 2</DataArray>
  <DataArray type="Int32" Name="offsets" format="ascii">3</DataArray></Polys>
</Piece></PolyData></VTKFile>`;
const { positions, indices } = await parseVTKXML(new TextEncoder().encode(file));
console.log(positions.length, indices);
```

- **Encodings.** ascii, binary and appended arrays, raw or base64, either byte order, 32 or 64-bit headers, and zlib or LZ4 blocks. Several pieces in a file are merged.
- **Cells.** Polygons and strips become triangles over the file's points, and polylines become `lines`. Volume cells are reduced to the faces only one cell owns, their outer surface; `surface: 'all'` keeps every face. `triangleCells` names the cell each triangle came from, so a cell field can colour them.
- **Data.** Every array is in `pointData` or `cellData` by name. `Normals`, `TCoords` and a 3 or 4 component `UInt8` `Scalars` array also fill `normals`, `uvs` and `colors`.
- **Not read.** Other dataset types, such as image and structured grids, are `unsupported` errors. The legacy text format is `parseVTK`. LZMA blocks (`vtkLZMADataCompressor`) need `@margoengine/decoders`.

## Rhino 3DM

`parse3DM` from `@margoengine/loaders/3dm` reads the meshes, untrimmed surfaces, layers and attributes of a Rhino `.3dm` file through a rhino3dm runtime you install, host and load. Its Wasm file is never part of this package.

```ts
import { parse3DM, type RhinoRuntime } from '@margoengine/loaders/3dm';

// `rhino` is `await rhino3dm()`, from the rhino3dm package you install and host.
export async function loadChair(rhino: RhinoRuntime) {
  const bytes = await (await fetch('/models/chair.3dm')).arrayBuffer();
  const { groups, layers } = parse3DM(rhino, bytes);
  console.log(groups[0].name, layers[groups[0].layer ?? 0].name);
}
```

- **Geometry.** Each object is a group of one merged mesh: a mesh as it is, and any other surface object through the render mesh saved in the file. With no render mesh, a NURBS surface and a solid that is one plain surface are tessellated by `@margoengine/loaders/nurbs` and counted in `surfaces`; `segmentsU` and `segmentsV` set the quads per knot span, default 4 times the degree. Other solids saved without a render mesh are counted in `skipped`, because any face may be trimmed and the runtime gives no trim curves. Nothing draws past a trim. Save the file from Rhino with render meshes kept to see them.
- **Attributes.** A group has the object's `name`, `id`, `layer`, `material` and `userStrings`, and its colour, from the object or else its layer. `layers` lists each layer's name, full path, colour and visibility.
- **Units.** Metres by the file's unit system; `units: 'file'` keeps the file's own numbers. A file with no known unit keeps them too, and `metersPerUnit` is left unset.
- **Hidden.** Hidden objects and objects on hidden layers stay out unless `hidden: true`.
- **Memory.** Every handle the runtime gives out is freed before `parse3DM` returns, failures included.
- **Tested.** Against a stand-in with rhino3dm's shape in `npm test`, and against the real rhino3dm 8.35 on McNeel's sample files in `npm run test:real-files`, surfaces saved with no render mesh included: each matches the runtime's own `pointAt` to within 1e-9.

## 3DS, LWO, AMF, MD2, PDB and KMZ

Older and specialist formats, one small entry each, so an app pays only for the one it imports.

```ts
import { parse3DS } from '@margoengine/loaders/3ds';
import { parseLWO } from '@margoengine/loaders/lwo';
import { parseAMF } from '@margoengine/loaders/amf';
import { parseMD2 } from '@margoengine/loaders/md2';
import { parsePDB } from '@margoengine/loaders/pdb';
import { parseKMZ } from '@margoengine/loaders/kmz';

const bytes = async (url: string) => (await fetch(url)).arrayBuffer();
console.log(parse3DS(await bytes('/models/teapot.3ds')).materials[0]?.texture);
console.log(parseLWO(await bytes('/models/ship.lwo')).groups[0].name);
console.log((await parseAMF(await bytes('/prints/bracket.amf'))).unit);
console.log(parseMD2(await bytes('/models/knight.md2')).clips);
console.log(parsePDB(await (await fetch('/molecules/1crn.pdb')).text()).bonds.length);
console.log((await parseKMZ(await bytes('/maps/tower.kmz'))).models[0]?.location);
```

Textures and skins are named by the file, and `loadTextures` from `/textures` reads them through a resolver, the same kind `parseLDraw` takes. Old tools wrote paths from their own PC, so each path is asked for as written, then with forward slashes, in lower case, and by its base name. A file nobody has is listed in `missing`, so one lost skin does not lose the model.

```ts
import { resolveFromURL } from '@margoengine/loaders/ldraw';
import { parseMD2 } from '@margoengine/loaders/md2';
import { loadTextures } from '@margoengine/loaders/textures';
import { parsePCX } from '@margoengine/decoders/pcx';

const model = parseMD2(await (await fetch('/models/tank.md2')).arrayBuffer());
const { textures, missing } = await loadTextures(model.skins, resolveFromURL('/models/'));
for (const bytes of textures.values()) console.log(parsePCX(bytes).width);
console.log(missing.map(({ path }) => path));
```

`parse3DS(...).materials[i].texture`, `parseLWO(...).images` and `parseMD2(...).skins` all feed it. Decode what comes back with `createImageBitmap` for PNG, JPEG and BMP, `parseTGA` from `@margoengine/decoders/tga` and `parsePCX` from `@margoengine/decoders/pcx`.

- **3DS.** `parse3DS` reads every triangle mesh with UVs, one group per object and material, and each material's colour, transparency and diffuse map name. Vertices are saved in world space. `cameras` and `lights` hold position, target, lens, colour, multiplier and spot cones, `ambient` the ambient colour, and `keyframes` the keyframer's nodes with hierarchy, pivots and tracks. They come back as the file holds them: rotation keys are axis and angle, each relative to the key before, and nothing plays them for you. `parseTDS` from `/tds` is the same reader: a `.tds` file is the same 3D Studio format under another extension, so this is one format with two names.
- **LWO.** `parseLWO` reads LWO2 and the older LWOB: every layer's points and face polygons, `SURF` colours and image maps in `surfaces`, still images in `images`, every `TXUV` map in `uvMaps` and every `WGHT` map in `weightMaps` with their `VMAD` values, which split a vertex along a seam in all maps at once. `uvs` is each layer's first map. `bones` holds the skelegons with names, parents and weight maps, in the coordinates of `positions`. There is one group per layer and surface, and z changes sign to make the left-handed file right-handed. Patch and subdivision polygons come in as their control cage with a warning. Curves, and clips that are not still images, are skipped with a warning.
- **AMF.** `parseAMF` reads plain or zipped files: objects, volumes, material, object and vertex colours, and constellations, nested ones included. Positions are in metres unless `units: 'file'`. Curved edges and colour formulas are skipped with a warning.
- **MD2.** `parseMD2` gives the first frame as a mesh with every frame beside it in one layout, so frames blend as morph targets. Frames named `run1`, `run2` form the clip `run`. Normals are computed from each frame's triangles. `skins` names the skin files, for `loadTextures` and `parsePCX`.
- **PDB.** `parsePDB` returns atoms as a point cloud with element colours, radii and labels, plus `bonds` as index pairs from CONECT rows and from distance, which `guessBonds: false` turns off. Only the first MODEL loads, and an atom with alternate locations keeps its first.
- **KMZ.** `parseKMZ` reads the KML document's `<Model>` elements and their COLLADA files, one mesh each, and an archive with no document gives every `.dae` it holds. `location`, `orientation`, `scale` and `altitudeMode` are returned. Pass `origin`, a place or `'first'`, and each located model also gets a column-major `matrix` that puts its geometry in a Y-up scene in metres, x east and z south at the origin, with the orientation, the scale and the Earth's curve between the two places. Without `origin` nothing is applied, for an app with a map projection of its own. Altitudes are taken as metres above the WGS84 ellipsoid, and `clampToGround`, the KML default, sits at height 0: no terrain or geoid is known here. Placemark points, lines and polygons are not read. `read(path)` returns any other file in the archive.

## NURBS curves and surfaces

`@margoengine/loaders/nurbs` evaluates and tessellates NURBS curves and surfaces held as plain data, the numbers a CAD file hands you. It checks them, fills in the end knots Rhino leaves out, and hands the maths to `@margoengine/geometry/nurbs`, the one evaluator, which `parseDXF` uses for SPLINE too. Rational weights make circles and spheres exact.

```ts
import { evaluateNurbsCurve, tessellateNurbsCurve, tessellateNurbsSurface } from '@margoengine/loaders/nurbs';

const arc = { degree: 2, knots: [0, 0, 0, 1, 1, 1], points: [1, 0, 0, 1, 1, 0, 0, 1, 0], weights: [1, Math.SQRT1_2, 1] };
console.log(evaluateNurbsCurve(arc, 0.5), tessellateNurbsCurve(arc, { tolerance: 0.001 }).length / 3);

const patch = { degreeU: 1, degreeV: 1, knotsU: [0, 0, 1, 1], knotsV: [0, 0, 1, 1], countU: 2, countV: 2,
  points: [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0] };
console.log(tessellateNurbsSurface(patch, { segmentsU: 2, segmentsV: 2 }).indices?.length);
```

- **Knots.** A knot vector may leave out its two end knots, as Rhino files do. Unclamped curves evaluate on their own domain.
- **Curves.** `tessellateNurbsCurve` splits each knot span until the curve is within `tolerance` of its chords, so straight runs stay cheap. The result is xyz per point, for `mode: 'strip'` of `@margoengine/lines`. `maxPoints` caps it.
- **Surfaces.** `tessellateNurbsSurface` makes a triangle grid with exact normals, with grid lines on every distinct knot and `segmentsU` and `segmentsV` quads per span. `evaluateNurbsSurface` gives a point and unit normal, and the normal is zero at a pole.
- **Whole surfaces.** Trim curves are not applied, and there is no solid modelling: no topology and no boolean operations.

## LAS and LAZ

`parseLAS` from `@margoengine/loaders/las` reads ASPRS LAS and LAZ point clouds, versions 1.0 to 1.4 and point formats 0 to 10. It is a thin layer over `@margoengine/points/las`, the one LAS reader of the engine, and gives the same data in the shape of this package.

```ts
import { parseLAS } from '@margoengine/loaders/las';

const bytes = await (await fetch('/surveys/quarry.laz')).arrayBuffer();
const { positions, classification, origin } = await parseLAS(bytes, { step: 4 });
console.log(positions.length / 3, classification[0], origin);
```

- **Positions.** They come back relative to `origin`, because survey coordinates are too large for 32-bit floats. Add it back for world coordinates. `origin` is the header's minimum corner, or the first point when the header's box misses the points, a fault of some writers.
- **Attributes.** `intensity`, `classification`, `returnNumber`, `returnCount`, `gpsTime` where the format has it, and `colors` in [0,1], from 16 bits or from 8 for files that fill only the low byte. `header` and `records` give the header and its variable records. `extra` holds extra bytes by name, `crs` the projection, and `points` everything else the file stores: flags, scan angle, user data, source id, channel, NIR and wave packets.
- **Thinning.** `step: 4` keeps every fourth point, and `maxVertices` counts points after thinning.
- **LAZ.** A `.laz` opens as it is. The decoder of `@margoengine/points/laz` loads when the first compressed file arrives, so a plain `.las` never pays for it. `decompress` replaces it with a decoder of your own, which gets the file and its header and returns the plain point records. LAZ item version 1, the coding of LASzip 1.0, is an `unsupported` error, as no published text describes it: [limits](../../docs/limits.md).
- **Waves.** Formats 4, 5, 9 and 10 carry wave packets in `points.wavePackets`. `lasWaveform(cloud.points, index, source)` from `@margoengine/points/las` reads one point's samples, from the file or from the `.wdp` beside it, and `lasWaveDescriptors(cloud.records)` the descriptors.

## VDB volumes

`parseVDB` from `@margoengine/loaders/vdb` reads OpenVDB `.vdb` files, the sparse volumes that simulation tools write for smoke, clouds and fire. It reads file versions 222 and later, which is OpenVDB 2.0 onward.

```ts
import { parseVDB } from '@margoengine/loaders/vdb';

const bytes = await (await fetch('/sims/smoke.vdb')).arrayBuffer();
const { grids, skipped } = await parseVDB(bytes, { grids: ['density'] });
const density = grids[0]!;
console.log(density.gridClass, density.activeVoxels, density.box, skipped.length);
console.log(density.at(10, 20, 30), density.isActive(10, 20, 30));
const { data, dims, bounds } = density.dense();
console.log(data.length, dims, bounds); // fig.volume(data, { dims, bounds }) in @margoengine/sciviz
```

- **Sparse.** Each grid keeps `leaves` (blocks of voxels, with an active mask) and `tiles` (cubes of one value) as the file stores them. `at` and `isActive` look up one voxel, and a voxel with nothing stored holds `background`.
- **Dense.** `dense()` fills an array over the active box, or over `{ box }`, x fastest. `bounds` is in world units around the voxel centres. A rotated grid gets the box around its corners, so use `matrix` when the rotation matters. `maxValues` caps the array, 536,870,912 by default.
- **Types.** `float`, `double`, `int32`, `int64`, `vec3s`, `vec3d` and `vec3i`. Grids stored as 16-bit halves widen to `float` or `double`, with `half` set. A vector grid has `components` 3, with the three values side by side.
- **Empty half-value blocks.** A half-precision node with no stored values consumes no size prefix, so the next node stays aligned. A pinned OpenVDB level-set sphere (CC-BY-4.0) regresses this against its stored voxel count and bounds; `npm run fixtures --workspace @margoengine/loaders` restores it.
- **Compression.** Uncompressed, zlib and Blosc with LZ4, the OpenVDB default, in every value layout. Blosc with another codec or with bit shuffle is refused with code `unsupported`.
- **Transforms.** `matrix` is the index-to-world matrix of an affine, scale, translation or unitary map, column-major. A frustum map has no matrix, so that grid goes to `skipped`.
- **Left out.** A grid this reader does not decode goes to `skipped` with the reason, and the others still read: `bool`, mask and point grids. NanoVDB files (`.nvdb`) are refused, because their header is not an OpenVDB one.

## MaterialX

`parseMaterialX` from `@margoengine/loaders/materialx` reads `.mtlx` documents, version 1.38 and later, and `toGraph` turns a material into the graph that `nodeMaterial()` of `@margoengine/materials` takes.

`materialXDocument(parts)` builds a document from nodes and materials that came from elsewhere, which is how `margoengine/usdz/materialx` hands a USD network to `toGraph`.

```ts
import { parseMaterialX } from '@margoengine/loaders/materialx';
import { nodeMaterial } from '@margoengine/materials';

const text = '<materialx version="1.39"><standard_surface name="S" type="surfaceshader">' +
  '<input name="base_color" type="color3" value="0.9, 0.6, 0.2"/><input name="metalness" type="float" value="1"/>' +
  '</standard_surface><surfacematerial name="Brass" type="material">' +
  '<input name="surfaceshader" type="surfaceshader" nodename="S"/></surfacematerial></materialx>';
const parsed = parseMaterialX(text);
const { graph, skipped } = await parsed.toGraph('Brass');
console.log(parsed.materials[0]?.shader?.category, skipped);
const extension = nodeMaterial(graph); // primitive.extension = extension
console.log(Object.keys(extension).length);
```

- **Shaders.** `standard_surface`, `open_pbr_surface`, `gltf_pbr` and `UsdPreviewSurface`: base colour and its weight, metal, roughness, normal, coat and transmission. An unset input takes the default of that shader's published definition; a `standard_surface` with `version="1.0.0"` takes that definition's. Converting another shader is refused with code `unsupported`, though the document still reads.
- **Nodes.** `image`, `tiledimage`, `gltf_image`, `constant`, `add`, `multiply`, `subtract`, `mix`, `dot`, `convert` and `normalmap`, inside and outside node graphs, with interface inputs.
- **Images.** Pass `texture`, which gets `{ file, type, colorspace, addressU, addressV, filter }` once per image and returns `{ view, sampler }`. Upload `srgb_texture` images as sRGB. An image feeds a lobe as the node material reads it, so roughness reads green and metal blue: a grey image works, and a packed one needs `metalRough` by hand.
- **`skipped`.** Node materials are a closed set, so whatever has no form there is listed with its reason and the input keeps its default: emission, opacity, noise and other procedural nodes. `uvtiling` and `uvoffset` are listed too, and the image still applies untiled.
- **Colour.** Constants in `srgb_texture` convert to linear. Another colour space reads as linear and is named in `skipped`.
- **Left out.** `xi:include` targets are listed in `includes` and not followed, custom `nodedef` graphs are not expanded, and the `<material>` form of 1.37 and before is refused. `look` assignments are read into `assignments`, for you to apply.

## Lottie

`parseLottie` from `@margoengine/loaders/lottie` reads Lottie JSON animations. `draw` paints a frame onto a 2D canvas for use as a texture, and `frame` gives the same frame as vector shapes.

```ts
import { parseLottie } from '@margoengine/loaders/lottie';

const animation = parseLottie(await (await fetch('/motion/logo.json')).text());
console.log(animation.width, animation.duration, animation.unsupported);

const canvas = new OffscreenCanvas(animation.width, animation.height);
const context = canvas.getContext('2d')!;
animation.draw(context, animation.frameRate * 0.5); // the frame half a second in; upload the canvas as a texture

for (const item of animation.frame(12.5)) // fractions blend between keyframes
  if (item.kind === 'path') console.log(item.fill, item.opacity, item.toShapes({ flipY: true }).length);
```

- **Layers.** Shape, solid, image, null and precomposition layers, with parents, in and out frames, time stretch and time remapping. A layer's own keyframes run in the time of its composition, as Bodymovin writes them; `st` and `sr` move what a precomposition plays. Hand `draw` your loaded images as `{ images: { id: bitmap } }`, by the ids in `animation.images`.
- **Shapes.** Rectangles, ellipses, polygons, stars, bezier paths and groups, with solid and gradient fills and strokes, dashes and trim paths, parallel or one by one. A trim reaches every shape before it in scope, also inside groups, and a stroke's width follows the transforms over the stroke.
- **Keyframes.** Bezier easing, per axis where the file gives it, hold keys, spatial curves on positions (the ease is a share of the arc length), and paths that blend between keys. Colours from 0 to 255 in files older than Bodymovin 4.1.9 are read as such.
- **Clear the canvas yourself.** `draw` paints over what is there, so call `clearRect` between frames.
- **`unsupported`.** Masks, track mattes, text layers, effects, blend modes, 3D layers, repeaters, merge paths, rounded corners and star roundness are not drawn. Each one the file uses is named in this list, so check it when a file looks wrong. Expressions are ignored and are not listed.
- **Proof.** Eight real exports match lottie-web 5.12.2 within 1 of 255 grey levels on a 16 by 16 grid (`REAL_FILES_ONLY=lottie npm run test:real-files`). Files that lean on masks, mattes or expressions differ: see `docs/limits.md`.

## XML

`margoengine/loaders/xml` is the small reader the XML formats here share, for any other format built on XML. It skips comments, DOCTYPE and CDATA, expands only the five predefined entities, and checks that tags nest. `readXMLTree` gives the elements, with namespace prefixes removed. `readXML` streams them to a handler. `decodeXML` turns bytes into text by their byte order mark.

```ts
import { readXMLTree } from 'margoengine/loaders/xml';
import {parseTMX, tmxLayerQuads} from 'margoengine/loaders';
const bytes = new Uint8Array(await (await fetch('/map.tmx')).arrayBuffer());

const root = readXMLTree('<scene name="yard"><item name="crate"/></scene>', 'Scene file');
const robot = root.children[0];
console.log(robot.name, robot.attributes.name, robot.children.length); // robot arm 1
```

## Tiled TMX

`await parseTMX(textOrBytes, {resolve, signal})` reads orthogonal Tiled maps (other orientations throw `unsupported`) and returns `{orientation, renderorder, width, height, tilewidth, tileheight, infinite, tilesets, tilesetRefs, layers, properties, warnings}`.

- Tilesets: embedded or external TSX (read through `resolve`, each file once), with `tilewidth`, `tileheight`, `spacing`, `margin`, `columns`, `tilecount` and `image: {path, width, height}`, the path relative to the TMX folder. Tilesets with the same image and grid are merged, so `tilesets` has no duplicates; `tilesetRefs` keeps every `firstgid` and the tileset it maps to.
- Tile layers: csv, base64 (plain, zlib or gzip through `DecompressionStream`, size-capped; zstd throws `unsupported`) and legacy `<tile gid>` data, infinite-map `<chunk>`s merged into one grid whose top-left cell is `x`, `y`. `gids` hold the global tile ids with the flip bits cleared (the hexagonal-rotation bit too), `flips` the bits as 1 horizontal, 2 vertical, 4 diagonal.
- Object layers: `{name, type, x, y, width, height, rotation, visible, gid, flips, properties}` per object, in pixels. Custom properties come typed (`int`, `float`, `bool`).
- Group layers are flattened: offsets add up, opacity multiplies, visibility combines. Image layers and image-collection tilesets are reported in `warnings`.

`tmxLayerQuads(map, layer, {tileSize})` turns one tile layer into a `LoadedGeometry` of quads on the XZ plane facing +Y (column along +X, row along +Z, `tileSize` world units per cell, default 1, layer offsets included), four vertices per tile with UVs from the atlas rectangle (spacing and margin honored, flips applied in Tiled's order, v = 0 at the top of the image), `faceSizes` all 4, one group per tileset and `cells` mapping each quad back to its layer cell. One object per layer, as Crocotile imports TMX:

```ts
const resolve = async (path: string) => new Uint8Array(await (await fetch(path)).arrayBuffer());
const map = await parseTMX(bytes, {resolve});
for (const layer of map.layers) {
  if (layer.type !== 'tile' || !layer.visible) continue;
  const quads = tmxLayerQuads(map, layer, {tileSize: 1});
  for (const group of quads.groups) console.log(layer.name, map.tilesets[group.tileset].image?.path, group.count / 6);
}
```
