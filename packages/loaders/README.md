# @margoengine/loaders

PLY, 3MF, DXF, PCD, OFF, XYZ, OBJ/MTL, COLLADA, Tiled TMX, legacy VTK and static USDA/USDZ loaders for Margo Engine, each tree-shakable on its own, plus three optional entries: TrueType fonts and extruded 3D text (`@margoengine/loaders/font`), SVG (`@margoengine/loaders/svg`) and OBJ meshes with their MTL materials and textures (`@margoengine/loaders/mtl`).

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
| `parseDXF` | none | ASCII and binary (R13 on) DXF: `$INSUNITS` to meters, LAYER colours and off/frozen layers, ACI and true colours (BYLAYER, BYBLOCK), blocks through INSERT (scale, rotation, rows and columns, nested) and DIMENSION; faces from 3DFACE, SOLID, TRACE, polyface and polygon-mesh POLYLINEs and MESH; line segments from LINE, LWPOLYLINE and 2D/3D POLYLINE (bulge arcs), ARC, CIRCLE, ELLIPSE and SPLINE (NURBS), in each entity's object coordinate system; POINT, TEXT and MTEXT (formatting removed); 3DSOLID, BODY and REGION ACIS data decoded to SAT text. Returns `{mesh, lines, points, texts, layers, solids, unit, version, skipped}`; draw `lines` with `@margoengine/lines` (`mode: 'segments'`) and the mesh double-sided (DXF faces have no winding) |
| `parsePCD` | `PCDLoader` | `DATA ascii`, `binary`, `binary_compressed` (own LZF decompressor); x y z, normal_x/y/z, packed `rgb`/`rgba`, `intensity`, any other field skipped |
| `parseOFF` | none | `OFF` with `ST`, `C`, `N` prefixes (texture coordinates, colors 0..1 or 0..255, normals) |
| `parseXYZ` | `XYZLoader` | xyz, xyz+rgb, xyz+normal, xyz+normal+rgb, xyz+intensity, PTS (xyz+intensity+rgb), chemistry XYZ |
| `parseVTK` | `VTKLoader` (legacy part) | `# vtk DataFile Version` 1.0 to 5.1, ASCII or BINARY `DATASET POLYDATA`: POINTS, POLYGONS, TRIANGLE_STRIPS, 5.x OFFSETS/CONNECTIVITY, point NORMALS, COLOR_SCALARS, TEXTURE_COORDINATES, SCALARS |
| `parseOBJ` (async), `parseMTL` | `OBJLoader`, `MTLLoader` | See [OBJ and MTL](#obj-and-mtl) |
| `parseDAE`, `flattenDAE` | `ColladaLoader` | See [COLLADA](#collada) |
| `parseTMX` (async), `tmxLayerQuads` | none | See [Tiled TMX](#tiled-tmx) |
| `parseTTF`, `textGeometry` (`/font`) | `TTFLoader`, `FontLoader`, `TextGeometry` | See [Fonts and 3D text](#fonts-and-3d-text) |
| `parseSVG` (`/svg`) | `SVGLoader` | See [SVG](#svg) |
| `loadOBJ`, `createMTLMaterials`, `createOBJMesh` (`/mtl`) | `OBJLoader` + `MTLLoader` | See [Textured OBJ meshes](#textured-obj-meshes) |

Helpers: `toGeometry` (core `Geometry`, flat or smooth normals when missing, per group), `pointsToGeometry` (octahedron markers for clouds), `createMeshes` (engine meshes with `PbrMaterial` colors), `load` / `fetchBytes`, `detectFormat` / `parseAny`, `computeVertexNormals`, `decompressLZF`, `readZipDirectory` / `readZipEntry` / `crc32`, `parsePLYHeader`, `parsePCDHeader`.

## How it works

- **One module per format.** The build is a plain TypeScript emit with `"sideEffects": false`, so importing `parsePLY` pulls in only the PLY reader and its helpers, not the 3MF, ZIP or XML code. In the main entry only `toGeometry`, `pointsToGeometry` and `createMeshes` import core; `/font` and `/svg` import `@margoengine/geometry` (a dependency), and `/mtl` imports `@margoengine/materials` (an optional peer: install it to use that entry).
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
- STL, STEP and IGES live in the machinery package (its OBJ reader is the CAD path: positions and faces only); glTF in gltf and gltf-pro.

## Tests

`npm test` in `packages/loaders` runs Node tests for: OBJ/MTL fixtures covering every statement, map option and error line (and a Crocotile-style file checked against three.js `OBJLoader` as an oracle), COLLADA Y-up and Z-up fixtures (polylist quads, textured phong, TRS stacks, symbol-bound materials, trifans, tristrips, holes, errors; world-space corners checked against three.js `ColladaLoader` under jsdom), TMX/TSX fixtures (csv, base64 plain, zlib and gzip written with `node:zlib`, legacy tiles, flips and their UVs, external and merged tilesets, infinite chunks, group offsets, errors), every PLY encoding and attribute naming generated in the test, PLY point clouds, OFF and XYZ variants, LZF round trips against an independent compressor, PCD ascii, binary and binary_compressed fixtures, VTK ASCII, big-endian BINARY and 5.1 polydata, ZIP archives with stored and deflate entries (written with `node:zlib`), 3MF components, mirrored transforms, colors, units and production parts, error cases for every format (bad headers, truncation, out-of-range indices, limits, zip bombs, CRC failures, cycles, aborts), `fetchBytes` limits against a local HTTP server, an SSR import check with throwing browser globals, and real files from three.js, PCL, libigl and PyVista (`npm run fixtures` re-downloads them; see `tests/fixtures/SOURCES.txt`) compared with independent reads. `tests/font.test.js` assembles TrueType fonts in the test from the specification's table layouts (cmap 4 and 12, composites with scale and point matching, kern pairs, collections, both winding conventions); `tests/svg.test.js` covers every path command, arcs, shapes, transforms, fill rules, styles and stroke areas; `tests/mtl.test.js` checks the MTL to material mapping, texture URLs, OBJ groups and `loadOBJ`'s fetches with a stand-in fetch. `npm run test:browser` (a real-GPU script, not in CI) loads `facecolors.3mf` in Chromium, creates engine meshes, checks five face colors in the rendered pixels, a GPU pick, `maxBytes`, disposal, and zero WebGPU validation errors.

MIT licensed.

## USD and USDZ

`parseUSDA(textOrBytes, options)` reads static polygon meshes with hierarchy, matrix/translate/scale/rotateXYZ transforms, reset stacks, visibility, Y/Z up, units, winding and constant display/PreviewSurface colors. `parseUSDZ(bytes, options)` validates stored ZIP entries, 64-byte alignment and root-layer CRC before parsing USDA. Both return `LoadedGeometry` for `createMeshes`. `readUSDA(text, {maxDepth, signal, assets, skipOver})` exposes the underlying layer reader (the `def` prim tree with attributes, connections, relationships and property metadata such as `interpolation`); `@margoengine/usdz` builds on it. It skips dictionaries and triple-quoted strings, accepts list-op prefixes (`prepend apiSchemas`) in metadata, and parses numeric arrays on a fast path capped at 16 million values. `parseAny` detects USDA text and USDZ root filenames; ordinary ZIPs retain 3MF detection.

`@margoengine/loaders/worker` exports `parseUSDZInWorker(bytes, options)` and `parseUSDAInWorker(textOrBytes, options)`: the same `LoadedGeometry` (byte for byte, `tests/worker.test.js`) parsed in a worker (`dist/workers/usd.js`, about 6.6 kB min+gzip, [entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)) with its arrays transferred back; errors stay `LoaderError`s. A whole ArrayBuffer input moves to the worker (detached). Without `Worker` they parse on the calling thread.

Triangles and convex planar polygons are supported; meshes must author `subdivisionScheme = "none"`. Binary USDC (the common production USDZ encoding), composition/references, animation, subdivision, hole faces, textures, varying colors and concave polygons are rejected explicitly. Use OpenUSD `usdcat` to convert a binary root, or load it with `@margoengine/usdz`, which reads USDC natively; flatten/tessellate unsupported features before loading. File normals and UVs are not retained; normals are recomputed. `units` defaults to `'meters'`; `'file'` keeps authored scale. `maxDepth` defaults to 32 (maximum 64), `maxEntryBytes` to 64 MiB, and vertex/triangle/ZIP limits apply.

Root `npm run modern:test:interop` checks round trips, units, transforms, visibility, winding, topology/composition errors, CRC, alignment, USDC rejection and budgets. Full IFC geometry parsing is provided separately by `@margoengine/ifc` with web-ifc.

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

`createMeshes` gives core `PbrMaterial` colours only. For textures, `@margoengine/loaders/mtl` builds `@margoengine/materials` meshes (an optional peer dependency: install it to use this entry). One call fetches the .obj, its `mtllib` files next to it and every texture relative to its .mtl file, and draws each `usemtl` group with its material:

```ts
import {loadOBJ} from '@margoengine/loaders/mtl';

const {mesh, warnings, dispose} = await loadOBJ(engine, 'https://example.com/models/chair.obj', {signal});
// mesh is a materials mesh (a gltf-pro model): move it with mesh.root, add it to shadows, clustered, ...
dispose(); // destroys the mesh, its materials and its textures
```

Or step by step, with your own bytes and texture loader:

```ts
import {parseMTL, parseOBJ} from '@margoengine/loaders';
import {createMTLMaterials, createOBJMesh} from '@margoengine/loaders/mtl';

const obj = await parseOBJ(bytes, {resolve});
const set = await createMTLMaterials(obj.materials, {baseUrl: objUrl, bump: 'normal'});
const mesh = createOBJMesh(engine, obj, set); // one mesh, one material slot per usemtl material
// parseMTL output resolves against the .mtl URL instead: createMTLMaterials(parseMTL(text), {baseUrl: mtlUrl}).
```

- Each `newmtl` becomes a metallic-roughness `Material`: `Kd` colour (sRGB to linear), `d` or `1 - Tr` opacity (transparent below 1 or with `map_d`), `Ke` emission (values over 1 go to `emissiveIntensity`), roughness from `Ns` as `(2 / (Ns + 2))^(1/4)` (Ns 10 gives 0.64, 100 gives 0.37, 1000 gives 0.21; 1 with `illum 1` or a black `Ks`), and the PBR extension's `Pr` and `Pm` when present. `illum 0` is unlit.
- Maps: `map_Kd` (colour), `map_Ke` (emission), `bump`/`map_Bump` (bump map scaled by `-bm`, or a normal map with `bump: 'normal'`, as many exporters write them), `norm` (normal map) and `map_d` (opacity). `-o` and `-s` become the slot's UV transform, `-clamp on` clamped wrapping. Each file loads once per colour space.
- `Ka`, the `Ks` colour, `Ni`, `Tf`, `map_Ka`, `map_Ks`, `map_Ns`, `disp`, `decal`, `refl` and other statements have no Margo equivalent; they and any texture that fails to load are listed in `warnings` instead of throwing.
- The mesh gets the OBJ's UVs back in three.js orientation (v up, for `flipY` textures), vertex colours in linear, and smooth normals shared across UV seams when the file has none. Groups without a known material use `fallback` (default a white `Material`). `prepareOBJMesh` returns the geometry and material array without creating the mesh. At most 1,000,000 vertices (a materials mesh limit). Front faces only unless `doubleSided: true`. Textures load with materials' `loadTexture` (http(s), blob: and data: URLs) unless you pass `loadTexture`.

## Fonts and 3D text

`@margoengine/loaders/font` reads TrueType fonts into an `OutlineFont` and extrudes text with `@margoengine/geometry`:

```ts
import {parseTTF, textGeometry} from '@margoengine/loaders/font';
import {createMesh, Material} from '@margoengine/materials';

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

`@margoengine/loaders/svg` turns SVG drawings into geometry `Shape`s and stroke triangles (three.js `SVGLoader`):

```ts
import {parseSVG} from '@margoengine/loaders/svg';
import {extrudeGeometry} from '@margoengine/geometry';
import {SRGBToLinear} from '@margoengine/math/color';

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

`parseDAE(textOrBytes, {maxVertices, maxTriangles})` reads COLLADA 1.4.1 and 1.5 (`.dae`) and returns `{upAxis, meter, geometries, materials, images, nodes, warnings}`, already converted to Y-up meters (`Z_UP` and `X_UP` rotate per the spec's axis table, `unit meter` scales geometry and translations).

- `geometries`: each `<mesh>` as a `LoadedGeometry` plus `id`, `name`, `faceSizes` and `positionIndices`, from `<triangles>`, `<polylist>` (`vcount` kept as `faceSizes`), `<polygons>`, `<trifans>` and `<tristrips>` with VERTEX/POSITION, NORMAL, TEXCOORD (lowest `set`, v flipped to 1 - t) and COLOR inputs at any offset, in the primitive or in `<vertices>`. One group per primitive with its material `symbol`. Corners are welded per primitive, so seams survive.
- `materials`: `profile_COMMON` `constant`, `lambert`, `phong` and `blinn` with `emission`, `ambient`, `diffuse`, `specular`, `reflective` and `transparent` as `{color}` or `{texture: {path, texcoord}}` (through 1.4.1 sampler2D, surface and image, 1.5 `instance_image`, or a bare image id), `opaque`, `shininess`, `reflectivity`, `transparency`, `indexOfRefraction`.
- `images`: the texture paths materials use, relative to the .dae folder (`file:///C:/a%20b.png` becomes `C:/a b.png`), for your resolver.
- `nodes`: the instanced visual scene as `{id, name, matrix, instances, children}`, `matrix` being the node's matrix/translate/rotate/scale stack (column-major, Y-up meters); `instances` are `{geometry, materials}` with `bind_material` symbols mapped to material indices; `instance_node` is expanded (at most 64 deep and 100,000 nodes).
- Not imported, each reported in `warnings`: `<lines>` and `<linestrips>`, polygon holes (the outer polygon is kept), `lookat` and `skew`, skins and morphs (`instance_controller` nodes get no mesh), animations, embedded image data, non-mesh geometry.

`flattenDAE(dae)` bakes the hierarchy into one `LoadedGeometry` (mirrored nodes keep outward winding) with a group per node instance and primitive, named after the node and colored with the bound material's diffuse color, so `createMeshes(engine, flattenDAE(dae))` shows the scene.

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
