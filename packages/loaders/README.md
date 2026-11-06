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

| Function | Reads |
| --- | --- |
| `parsePLY` | ASCII, binary little and big endian; x y z, nx ny nz, red green blue (uchar, ushort or float), s/t, u/v, texture_u/texture_v; polygon faces fan-triangulated; files without faces become point clouds; unknown elements and properties skipped |
| `parseSTL` | See [STL](#stl) |
| `parse3MF` (async) | Own ZIP reader (stored and deflate through `DecompressionStream('deflate-raw')`, CRC-32 checked); objects, meshes, components, build items, 3x4 transforms; `basematerials` and materials-extension `colorgroup` colors; production-extension `p:path` parts; unit conversion to meters |
| `parseDXF` | ASCII and binary (R13 on) DXF: `$INSUNITS` to meters, LAYER colours and off/frozen layers, ACI and true colours (BYLAYER, BYBLOCK), blocks through INSERT (scale, rotation, rows and columns, nested) and DIMENSION; faces from 3DFACE, SOLID, TRACE, polyface and polygon-mesh POLYLINEs and MESH; line segments from LINE, LWPOLYLINE and 2D/3D POLYLINE (bulge arcs), ARC, CIRCLE, ELLIPSE and SPLINE (NURBS), in each entity's object coordinate system; POINT, TEXT and MTEXT (formatting removed); 3DSOLID, BODY and REGION ACIS data decoded to SAT text. Returns `{mesh, lines, points, texts, layers, solids, unit, version, skipped}`; draw `lines` with `@margoengine/lines` (`mode: 'segments'`) and the mesh double-sided (DXF faces have no winding) |
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
| `parseNRRD` (`/nrrd`, async) | See [NRRD volumes](#nrrd-volumes) |
| `parseLDraw` (`/ldraw`, async) | See [LDraw](#ldraw) |
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

## Tests

`npm test` in `packages/loaders` runs Node tests for: OBJ/MTL fixtures covering every statement, map option and error line (and a Crocotile-style file whose triangle corners are checked against values read by hand from the text), COLLADA Y-up and Z-up fixtures (polylist quads, textured phong, TRS stacks, symbol-bound materials, trifans, tristrips, holes, errors; world-space corners checked against the document's transforms worked out by hand), TMX/TSX fixtures (csv, base64 plain, zlib and gzip written with `node:zlib`, legacy tiles, flips and their UVs, external and merged tilesets, infinite chunks, group offsets, errors), every PLY encoding and attribute naming generated in the test, PLY point clouds, OFF and XYZ variants, LZF round trips against an independent compressor, PCD ascii, binary and binary_compressed fixtures, VTK ASCII, big-endian BINARY and 5.1 polydata, ZIP archives with stored and deflate entries (written with `node:zlib`), 3MF components, mirrored transforms, colors, units and production parts, error cases for every format (bad headers, truncation, out-of-range indices, limits, zip bombs, CRC failures, cycles, aborts), `fetchBytes` limits against a local HTTP server, an SSR import check with throwing browser globals, Margo-made PLY, 3MF, PCD and XYZ fixtures (`node scripts/make-fixtures.js` rewrites them; the tests compare against the generator's own arrays and independent reads), and real files from PCL, libigl and PyVista (`npm run fixtures` re-downloads them; see `tests/fixtures/SOURCES.txt`) compared with independent reads. `tests/font.test.js` assembles TrueType fonts in the test from the specification's table layouts (cmap 4 and 12, composites with scale and point matching, kern pairs, collections, both winding conventions); `tests/svg.test.js` covers every path command, arcs, shapes, transforms, fill rules, styles and stroke areas; `tests/mtl.test.js` checks the MTL to material mapping, texture URLs, OBJ groups and `loadOBJ`'s fetches with a stand-in fetch. `npm run test:browser` (a real-GPU script, not in CI) loads `face_colors.3mf` in Chromium, creates engine meshes, checks five face colors in the rendered pixels, a GPU pick, `maxBytes`, disposal, and zero WebGPU validation errors.

Apache-2.0 licensed.

## USD and USDZ

`parseUSDA(textOrBytes, options)` reads static polygon meshes with hierarchy, matrix/translate/scale/rotateXYZ transforms, reset stacks, visibility, Y/Z up, units, winding and display/PreviewSurface colors. Constant colors become `groups[].color` (sRGB). Constant or per-vertex RGB and opacity primvars, indexed or not, and read directly or through `UsdPrimvarReader_float3`/`UsdPrimvarReader_float` nodes, become sRGB `colors` and linear `attributes.opacity`. Other shader graphs and interpolations are refused. `createMeshes` averages vertex RGB and ignores vertex alpha; `createPBRMeshes` from `/render` keeps both. `parseUSDZ(bytes, options)` validates stored ZIP entries, 64-byte alignment and root-layer CRC before parsing USDA. Both return `LoadedGeometry`. `readUSDA(text, {maxDepth, signal, assets, skipOver})` exposes the underlying layer reader (the `def` prim tree with attributes, connections, relationships and property metadata such as `interpolation`); `@margoengine/usdz` builds on it. It skips dictionaries and triple-quoted strings, accepts list-op prefixes (`prepend apiSchemas`) in metadata, and parses numeric arrays on a fast path capped at 16 million values. `parseAny` detects USDA text and USDZ root filenames; ordinary ZIPs retain 3MF detection.

`@margoengine/loaders/worker` exports `parseUSDZInWorker(bytes, options)` and `parseUSDAInWorker(textOrBytes, options)`: the same `LoadedGeometry` (byte for byte, `tests/worker.test.js`) parsed in a worker (`dist/workers/usd.js`, about 6.6 kB min+gzip, [entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)) with its arrays transferred back; errors stay `LoaderError`s. A whole ArrayBuffer input moves to the worker (detached). Without `Worker` they parse on the calling thread.

Triangles and convex planar polygons are supported; meshes must author `subdivisionScheme = "none"`. A prim may reference a prim of the same layer (`references = </Path>`, what `exportUSDZ` writes for a shared geometry), and what it authors wins; class prims are not drawn. Binary USDC (the common production USDZ encoding), any other composition, animation, subdivision, hole faces, textures, uniform/face-varying color interpolation and concave polygons are rejected explicitly. Use OpenUSD `usdcat` to convert a binary root, or load it with `@margoengine/usdz`, which reads USDC natively; flatten/tessellate unsupported features before loading. File normals and UVs are not retained; normals are recomputed. `units` defaults to `'meters'`; `'file'` keeps authored scale. `maxDepth` defaults to 32 (maximum 64), `maxEntryBytes` to 64 MiB, and vertex/triangle/ZIP limits apply.

Root `npm run modern:test:interop` checks round trips, units, transforms, visibility, winding, topology/composition errors, CRC, alignment, USDC rejection and budgets. Full IFC geometry parsing is provided separately by `@margoengine/ifc` with web-ifc.

## Optional vertex color and opacity rendering

Install `@margoengine/gltf-pro` alongside loaders to use this entry. The decode/root entry does not import it.

```ts
import {parseUSDZ} from 'margoengine/loaders';
import {createPBRMeshes} from 'margoengine/loaders/render';

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
const resolve = (path) => fs.promises.readFile(join(dirname(file), path));
// Browser: fetch next to the model.
const resolve = async (path) => new Uint8Array(await (await fetch(new URL(path, modelUrl))).arrayBuffer());
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

const {mesh, warnings, dispose} = await loadOBJ(engine, 'https://example.com/models/chair.obj', {signal});
// mesh is a materials mesh (a gltf-pro model): move it with mesh.root, add it to shadows, clustered, ...
dispose(); // destroys the mesh, its materials and its textures
```

Or step by step, with your own bytes and texture loader:

```ts
import {parseMTL, parseOBJ} from 'margoengine/loaders';
import {createMTLMaterials, createOBJMesh} from 'margoengine/loaders/mtl';

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
import type {EngineKernel} from 'margoengine/core';

declare const engine: EngineKernel, text: string;
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
import type {EngineKernel} from 'margoengine/core';

declare const engine: EngineKernel, text: string;
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

`parseNRRD` from `@margoengine/loaders/nrrd` reads the NRRD files CT and MRI tools write, `.nrrd` and detached `.nhdr`, into the arrays `fig.volume()` of `@margoengine/sciviz` takes. It reads raw, ascii, hex and gzip data in either byte order, `line skip`, `byte skip` (with -1 for the end of a raw file), and one data file, a `%03d` pattern or a `LIST`. Samples stay in the file's own type; 64-bit integers become `Float64Array`, exact up to 2^53.

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
- `maxSamples` (default 536,870,912) stops a huge declared size before anything is allocated, and gzip data cannot inflate past what the header declares. `bzip2` data and the `block` type are refused with code `unsupported`.

## LDraw

`parseLDraw` from `@margoengine/loaders/ldraw` reads LDraw brick models, `.ldr`, `.dat` and multi-part `.mpd`, into one mesh with a group per colour, plus the model's edge lines. Parts load through `resolve` from an LDraw library folder you host, and a part nobody can find is listed in `missing` while the rest of the model still loads.

```ts
import { parseLDraw } from '@margoengine/loaders/ldraw';

const parts: Record<string, string> = { 'parts/plate.dat': '0 BFC CERTIFY CCW\n4 16 0 0 0 20 0 0 20 0 20 0 0 20\n2 24 0 0 0 20 0 0\n' };
const model = await parseLDraw('1 4 0 0 0 1 0 0 0 1 0 0 0 1 plate.dat\n', {
  resolve: async (path) => {
    if (path in parts) return parts[path];
    throw new Error(`no ${path}`); // in a browser: fetch(`/ldraw/${path}`), and throw on a 404
  },
});
console.log(model.groups[0].name, model.lines.length, model.missing);
```

- **Colours.** 16 takes the colour of the reference above it and 24 that colour's edge. `0x2RRGGBB` is a direct colour. `0 !COLOUR` lines and `LDConfig.ldr` fill the palette, read through `resolve` or passed as `config`; without one, the 16 classic colours apply and an unknown code draws light grey with a warning.
- **Parts.** Each reference tries `searchPaths` in order, in lower case with forward slashes. An MPD pack's own files win over the library, and each file is read once.
- **Winding.** A file with `0 BFC CERTIFY` keeps its winding through mirrors, `CW` and `INVERTNEXT`. Polygons of an uncertified file, or inside `NOCLIP`, are written on both sides, so they draw correctly with back faces culled. Each file's own certification decides, so a certified part inside a plain `.ldr` model still culls.
- **Units.** By default 1 LDraw unit is 0.4 mm and the model turns Y up. `units: 'file'` keeps LDraw units with -Y up.
- **Lines.** `lines` and `lineColors` go to `@margoengine/lines` in `segments` mode. `conditionalLines` holds four points each: the two ends, then the two control points that decide whether to draw it. `edges: false` drops them all.
- **Limits.** `maxDepth` (64), `maxInstances` (4,000,000) and the shared vertex and triangle limits stop a file of doubling references. Texture maps (`!TEXMAP`) are skipped with a warning.

## Tiled TMX

`await parseTMX(textOrBytes, {resolve, signal})` reads orthogonal Tiled maps (other orientations throw `unsupported`) and returns `{orientation, renderorder, width, height, tilewidth, tileheight, infinite, tilesets, tilesetRefs, layers, properties, warnings}`.

- Tilesets: embedded or external TSX (read through `resolve`, each file once), with `tilewidth`, `tileheight`, `spacing`, `margin`, `columns`, `tilecount` and `image: {path, width, height}`, the path relative to the TMX folder. Tilesets with the same image and grid are merged, so `tilesets` has no duplicates; `tilesetRefs` keeps every `firstgid` and the tileset it maps to.
- Tile layers: csv, base64 (plain, zlib or gzip through `DecompressionStream`, size-capped; zstd throws `unsupported`) and legacy `<tile gid>` data, infinite-map `<chunk>`s merged into one grid whose top-left cell is `x`, `y`. `gids` hold the global tile ids with the flip bits cleared (the hexagonal-rotation bit too), `flips` the bits as 1 horizontal, 2 vertical, 4 diagonal.
- Object layers: `{name, type, x, y, width, height, rotation, visible, gid, flips, properties}` per object, in pixels. Custom properties come typed (`int`, `float`, `bool`).
- Group layers are flattened: offsets add up, opacity multiplies, visibility combines. Image layers and image-collection tilesets are reported in `warnings`.

`tmxLayerQuads(map, layer, {tileSize})` turns one tile layer into a `LoadedGeometry` of quads on the XZ plane facing +Y (column along +X, row along +Z, `tileSize` world units per cell, default 1, layer offsets included), four vertices per tile with UVs from the atlas rectangle (spacing and margin honored, flips applied in Tiled's order, v = 0 at the top of the image), `faceSizes` all 4, one group per tileset and `cells` mapping each quad back to its layer cell. One object per layer, as Crocotile imports TMX:

```ts
const map = await parseTMX(bytes, {resolve});
for (const layer of map.layers) {
  if (layer.type !== 'tile' || !layer.visible) continue;
  const quads = tmxLayerQuads(map, layer, {tileSize: 1});
  for (const group of quads.groups) console.log(layer.name, map.tilesets[group.tileset].image?.path, group.count / 6);
}
```
