# @margoengine/voxel-edit

Import `margoengine/voxel-edit` from the `margoengine` package, or `@margoengine/voxel-edit` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Editing voxel models for voxel editors and tools: dense and sparse grids, modeling operations, brushes and
selections, picking, export meshing, `.vox` scene editing and frame animation. CPU only (but `./shaders`, which runs on a GPUDevice), no renderer, no DOM: every
function is pure and can run in a worker. Optional and tree-shakable; core and the stage never import it.

```ts
import { combineGrids, mergePalettes, rotateGrid, type VoxelGrid } from 'margoengine/voxel-edit';
import { sphereCells, connectedCells } from 'margoengine/voxel-edit/edit';
import { pickRay, raycastGrid } from 'margoengine/voxel-edit/pick';
import { meshGrid } from 'margoengine/voxel-edit/mesh';
import {Engine} from 'margoengine/core';
const ndcX = 0;
const ndcY = 0;
const engine = await Engine.create(document.querySelector('canvas')!);

const model: VoxelGrid = { size: [32, 32, 32], voxels: new Uint8Array(32 * 32 * 32) };
const { grid } = rotateGrid(model, { axis: 'y', degrees: 90 }); // a new grid; `model` is unchanged
const prop: VoxelGrid = { size: [8, 8, 8], voxels: new Uint8Array(8 * 8 * 8) };
const baseKeys = Array.from({ length: 256 }, (_, i) => `base:${i}`), toolKeys = Array.from({ length: 256 }, (_, i) => `tool:${i}`);
const baseUsed = new Uint8Array(256), toolUsed = new Uint8Array(256);
const { paletteMap } = mergePalettes({ baseKeys, toolKeys, baseUsed, toolUsed });
const merged = combineGrids(grid, prop, { operation: 'union', offset: [4, 0, 4], paletteMap });

const ray = pickRay(engine.camera.matrix, ndcX, ndcY); // then into the model's cells with its inverse matrix
const hit = ray && raycastGrid(merged.grid, ray); // {cell, adjacent, normal, value, distance}
const { mesh } = meshGrid(merged.grid, { ambientOcclusion: true, pivot: [16, 0, 16] });
```

## Grids

A `VoxelGrid` is `{size, voxels}`: one palette index per cell, 0 for air and 1-255 for filled cells, Y up, cell
(x, y, z) at `x + size[0] * (z + size[2] * y)` (`cellIndex`, `cellAt`, `insideGrid`). Operations never change their
input; each returns `{grid, changed, clipped}`: a new grid, the cells that differ (cells outside either grid read as
air) and the filled cells pushed out of bounds. Every operation checks its arguments and its `maxCells` budget
(default 16,777,216 cells, at most 67,108,864) before allocating anything. The layout operations (`flipGrid` to
`fitGrid`) also take a `selection` of cell indexes and return it mapped, with `mapPoint` for pivots and joints in
corner coordinates.

| Root entry | Does |
| --- | --- |
| `combineGrids` | union (with a `paletteMap`), `intersect`, `subtract` of a tool grid at a whole-cell offset |
| `mergePalettes` | the `paletteMap` for a union: reuses equal identities, takes free indexes, never changes used base entries; throws past 255 |
| `shearGrid`, `reflectDiagonal`, `wrapGrid`, `rotateGrid` | shear by layers, mirror or symmetrize across a square plane's diagonal, move with wrap-around, turn by any angle inside the box |
| `repeatGrid`, `resampleGrid` | tile, or scale by nearest-cell sampling (indexes are never blended) |
| `dilateGrid`, `erodeGrid`, `fillEnclosed` | grow or shrink along chosen axis directions, fill closed cavities |
| `generateMaze` | a seeded perfect maze, one-cell walls and corridors |
| `flipGrid`, `turnGrid`, `shiftGrid` | exact whole-cell layout: mirror along a principal axis, right-handed quarter turns that swap the other two sizes (so nothing clips; `rotateGrid` turns inside the same box instead), move by an offset with the cells that leave counted in `clipped` |
| `occupiedBounds`, `cropGrid`, `fitGrid` | the filled box; crop or extend to a size anchored at a caller's origin (a resize keeping the corner is origin [0, 0, 0]); shrink to the filled box |
| `invertGrid` | swap filled and empty cells, air taking an explicit palette index |
| `sliceLayout`, `stackSlices` | sprite-sheet RGBA frames (explicit frame size, columns, count, stack axis, order and alpha threshold) stacked into an indexed Y-up grid, each RGBA colour exact: indexes in reading order up to 255, or the first exact index of a palette you pass; anything else refuses |
| `ByteLedger`, `ownedBuffers`, `retainedBytes` | bytes of the storage grids, cels, packed frames, images and sparse snapshots keep alive, each buffer counted once through its token (`SparseGrid.ownedBuffers`, `SparseGrid.deltaBuffers`); the ledger retains and releases values for an undo budget |

## Entries

| Entry | Holds |
| --- | --- |
| `./edit` | brush footprints `lineCells`, `boxCells`, `sphereCells`; selections `floodCells` (same index), `connectedCells` (any filled), `faceCells` (an exposed layer), returned as cell indexes in a `Float64Array`; `mirrorCells` expands brush samples through XYZ mirrors (a centre-plane cell once) and `stampCells` writes them as one fill, paint or erase edit; `pasteCells` pastes clip cells with exact palette identities, the selection and an explicit `'overflow'` result when the palette is full; rasterizers `ellipsoidCells`, `cylinderCells`, `ringCells`, `thickLineCells` (cube per step, `'ceil'` or `'span'` step rule) and `taperedLineCells` (spheres of changing radius) give the cell indexes of a grid with exact centre, radius and thickness rules, refusing or clipping cells outside |
| `./pick` | `pickRay` (pointer ray from the camera matrix, reverse depth), `raycastGrid` (first filled cell, the face and the cell in front of it), `groundCell` |
| `./sparse` | `SparseGrid`: models far larger than memory holds densely (a 1,000,000-wide grid with two cells holds two chunks), stored as `@margoengine/voxel` chunks, edited by copy-on-write snapshots with `restore` undo; `editWindow` fills, erases, paints, dilates or erodes a box; `serialize` / `deserialize`; `snapshot` / `fromSnapshot` / `restoreSnapshots` and `deltaSnapshot` / `applyDeltaSnapshot` for workers (`snapshotBuffers` is the transfer list); `toWorld` writes into a `VoxelWorld` |
| `./mesh` | `meshGrid`: greedy quads per palette index with optional corner ambient occlusion and crease-limited smooth normals; dense or sparse, chunk seams leave no inner faces; `partitionMesh` splits a mesh into one-palette parts of at most 250,000 quads (one million vertices, core `Geometry`'s limit), attributes copied; `chamferGrid` bevels the exposed faces by a width in cells into a triangle mesh with a palette index per triangle |
| `./vox` | `gridFromVox` / `voxFromGrid` (MagicaVoxel's Z up to Y up and back; an unedited model is returned as it was) and scene-graph edits: layers, names, transform and shape keys, groups, instances, `moveVoxNode` (keeps world poses), `deleteVoxNode`; `resolveVoxScene` places every shape instance at a frame (held keys, visibility, names, layers, matrix) under an explicit centering, and `voxFrameRange` gives the key span; `voxTiles` splits a large dense or sparse grid into filled tiles of at most 256 cells per axis, each with its exact cell offset and no axis turned |
| `./animation` | `packFrames` / `unpackFrames` (each distinct model stored once) and `localFrame` (a clip's clock: offset, speed, loop or hold) |
| `./history` | `VoxelHistory`: undo/redo of copied grids with depth, per-grid cell and total byte budgets |
| `./export` | `gridToExportSource`: meshes a grid into one primitive per palette material (corner AO as vertex colours), the `{nodes}` scene `exportGLB`, `exportUSDZ` and `exportOBJ` take |
| `./formats` | voxel files other tools write: `parseQB` / `writeQB` and `parseQEF` / `writeQEF` (Qubicle), `parseBinvox`, `parseKVX` and `parseVXL`; models, palette, positions, with cell budgets |
| `./smooth` | `smoothGrid`: a smooth Surface Nets mesh of a grid, with relaxation, optional blur and gradient normals, for `gridToExportSource` |
| `./voxelize` | `voxelizeMesh`: a triangle mesh to a grid and palette, surface or solid, with vertex or texture colours and median cut; `AbortSignal` |
| `./assist` | `noiseFill` (seeded random fill), `suggestPalette` (seeded hues, linear sRGB) and `paletteUsage` (cells per index) |
| `./library` | `fetchLibrary` / `fetchAsset` / `resolveLibraryUrl`: list and fetch `.vox` packs from a JSON index, with a body size limit and abort |
| `./shaders` | `ShaderBrush`: your own WGSL `fn brush(p, value)` run on the GPU for every selected cell, pass after pass, to grow, erode or generate; presets `brushes.grow`, `erode`, `noise`, `smooth`; `brushSource` |
| `./rig` | `VoxelRig`: voxel parts on a skeleton, posed by bone rotations; part matrices for drawing and `bake` to one grid; `sampleRigClip`, `rigRotation`, `slerpRotation` |

Selections, picking and meshing take a dense or a sparse grid. Errors follow
[docs/conventions.md](../../docs/conventions.md): `TypeError` and `RangeError` for arguments and budgets,
`MargoError` with code `state` for a stale undo token, a non-empty target world, or a `.vox` edit the scene's
structure refuses (the last key of a track, the root, a cycle, moving a visible node into a hidden group).

## .vox placement

`resolveVoxScene(scene, {frame, centering})` needs a centering, because two placements are in use and they differ by
one cell along a flipped axis of odd size. `'box-v1'` keeps a turned box on the span `t - floor(s / 2)` to
`t - floor(s / 2) + s` on every axis and mirrors cells inside it: `@margoengine/voxel/vox` `pasteVoxModel`'s placement,
and the one Margo Voxel Studio saves. `'pivot-v1'` turns the model about its corner `floor(size / 2)`:
`@margoengine/voxel-pathtracer` `magicaVoxelMatrix`. Each name is a fixed contract; a new convention gets a new name.
The resolver uses the key in force at the frame (the latest at or before it, else the earliest; the first listed
among keys of one frame), while `pasteVoxModel` uses each track's first-listed key.

## Voxel files

`./formats` reads the files other voxel tools write into the grid and palette the rest of this package uses. Index i of
the palette sits at `4 * i`, as in `parseVox`.

```ts
import { parseQB, writeQEF } from '@margoengine/voxel-edit/formats';

const bytes = new Uint8Array(await (await fetch('/models/robot.qb')).arrayBuffer());
const { models, palette, colorsReduced } = parseQB(bytes, { maxCells: 16_000_000 });
if (colorsReduced) console.warn('over 255 colours: nearby ones were merged');
const text = writeQEF(models[0].grid, palette);
```

| Format | Read | Write | What to know |
| --- | --- | --- | --- |
| Qubicle `.qb` | `parseQB` | `writeQB` | every matrix with its name and position; RGBA or BGRA, RLE or plain, left or right handed; alpha 0 is air; a visibility mask counts as opaque |
| Qubicle `.qef` | `parseQEF` | `writeQEF` | one model; text; mask 0 is hidden; no alpha |
| `binvox` | `parseBinvox` | | one model of index 1, plus the header's `translate` and `scale` |
| KVX | `parseKVX` | | the first, largest mip; colour 255 is air; file colour k is index k + 1; `pivot` in cells |
| VXL | `parseVXL` | | Voxlap maps, with a header or bare (`size`, default 512 x 512 x 64); solid cells without a colour take the last one above them |

KVX and VXL have z running down in the file, so they turn to Y up on reading: the file's y becomes z. A true-colour file
with over 255 colours loses low bits from each channel, the same on every run, until 255 are left, and `colorsReduced`
is true. Block-game `.schematic` and Goxel `.gox` are left out on purpose.

## Smooth meshes

`./smooth` meshes a grid as a rounded surface in place of cubes. Its mesh has the same shape as `meshGrid`'s, so
`partitionMesh` and the exporters take it.

```ts
import { gridToExportSource } from '@margoengine/voxel-edit/export';
import { smoothGrid } from '@margoengine/voxel-edit/smooth';

const grid = { size: [3, 3, 3] as const, voxels: new Uint8Array(27).fill(1) };
const { mesh, stats } = smoothGrid(grid, { iterations: 4, blur: 1 });
const source = gridToExportSource(grid, [{ index: 1, color: [0.8, 0.3, 0.1] }], { mesh });
console.log(stats.quads, source.nodes[0].primitives.length);
```

`iterations` (default 2, up to 64) relaxes the points; each stays inside its own net cell, so the model never drifts.
`blur` (default 0, up to 8) is a box blur radius over the occupancy: rounder, but a part thinner than `2 * blur + 1` fades
away. Each quad takes the palette index of the nearest filled voxel. Cells that touch only along an edge or corner share a
surface point there, so such a model is closed but not manifold at that point.

## Mesh to voxels

`./voxelize` turns any triangle mesh into the grid and palette the rest of this package uses. Pass `size` (cells along
the longest axis) or `voxelSize` (mesh units per cell). `'surface'` fills each cell a triangle touches, one cell thick at
least; `'solid'` fills each cell whose centre is inside, which needs a closed mesh (`openRows` counts the x rows that
show a hole).

```ts
import { voxelizeMesh } from '@margoengine/voxel-edit/voxelize';

const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
const indices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];
const uvs = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);
const texture = { width: 1, height: 1, data: new Uint8Array([200, 80, 40, 255]) };
const { grid, palette, origin, voxelSize, openRows } = await voxelizeMesh(positions, indices, {
  size: 32,
  fill: 'solid',
  colors: { uvs, texture },
  paletteSize: 64,
  maxCells: 1_000_000,
  signal: AbortSignal.timeout(10_000),
});
console.log(grid.size, palette.length, origin, voxelSize, openRows);
```

`colors` is `{vertex}` (RGB or RGBA per vertex, bytes in a `Uint8Array`, 0 to 1 otherwise) or `{uvs, texture}` (RGBA8, nearest
texel, repeating, row 0 at v = 0). Colours reach the palette as given and alpha is ignored. Without `colors` every cell is
index 1, white. Over `paletteSize` colours (default 255) median cut merges the nearest ones and `colorsReduced` is true.
`maxCells` defaults to 16,777,216. The call yields to the event loop while it runs, so a `signal` can stop it.

## Saved formats

`SparseGrid.serialize` writes `{format: 'margo-sparse-volume', version: 1, ...}` and `packFrames` writes
`{version: 1, banks, keys}`: plain JSON, read back with full validation, so untrusted files are safe to load.

A sparse grid's engine cells (`origin + cell`) stay in one of two envelopes, chosen by `SparseGrid.empty`'s
`envelope` option. `'world'` (the default) is a `VoxelWorld`'s range: Y from -32,768 to 32,767, X and Z 32-bit; such
grids save as version 1, as before. `'wide'` allows any whole number up to 2^53 - 1 in size on every axis; a grid past
the world range saves as version 2 with the same fields (older readers refuse it rather than misplace it), and
`toWorld` refuses cells a world cannot hold. Either way a grid holds at most 2^53 - 1 cells, so a cell index
(`x + size[0] * (z + size[2] * y)`, the selections of `./edit`) is an exact double. Mesh positions are float32, exact
within 2^24 cells of the pivot.

## Workers

`grid.snapshot()` packs a sparse grid into five typed arrays on new buffers that nothing else refers to; post it with
`snapshotBuffers(snapshot)` as the transfer list, which moves the bytes instead of copying them and leaves the grid
unchanged. `SparseGrid.fromSnapshot` (one grid) and `restoreSnapshots` (several, one `maxBytes` budget across them)
check everything before decoding and copy what they keep, so the receiver may drop or reuse the buffers.
`SparseGrid.deltaSnapshot(delta)` packs only the chunks one edit touched, before and after; a worker holding the grid
before the edit replays it with `applyDeltaSnapshot` (or undoes it with side `'before'`), which refuses with a
`MargoError` code `state` unless the worker's grid holds exactly the chunks the delta starts from.

## Shader brushes (`./shaders`)

`ShaderBrush` runs a small WGSL function on the GPU (WebGPU compute) for every selected cell of a grid. The function
gets the cell and its palette index and returns the new index; it can read any cell of the grid as it was before the
pass, so brushes that grow, erode, smooth or generate shapes are a few lines. The grid you pass is never changed.

```ts
import { dilateGrid, type VoxelGrid } from 'margoengine/voxel-edit';
import { brushes, ShaderBrush } from 'margoengine/voxel-edit/shaders';

const adapter = await navigator.gpu.requestAdapter();
const device = await adapter!.requestDevice();
const model: VoxelGrid = { size: [64, 64, 64], voxels: new Uint8Array(64 ** 3) };
model.voxels[32 + 64 * (32 + 64 * 32)] = 5; // one cell in the middle

const grow = await ShaderBrush.create(device, brushes.grow);
const { grid, changed } = await grow.run(model, { passes: 3 }); // the same cells as dilateGrid(model, {iterations: 3})
console.log(changed, grid.voxels.every((v, i) => v === dilateGrid(model, { iterations: 3 }).grid.voxels[i]));

// Your own brush: rings of colour by height inside the selection, rough edges from noise.
const rings = await ShaderBrush.create(
  device,
  `fn brush(p: vec3<i32>, value: u32) -> u32 {
  if (value == 0u || noise(vec3<f32>(p) * param(0)) < 0.3) { return value; }
  return 1u + u32(p.y / 4) % 3u;
}`,
);
const shaded = await rings.run(grid, { params: [0.2], seed: 7 });
grow.dispose();
rings.dispose();
```

- **What the code can call.** `cell(q)` (the index at any cell, 0 outside), `inside(q)`, `cell_index(q)`, `grid_size()`,
  `face_offset(d)` (d 0 to 5: -x, +x, -y, +y, -z, +z), `param(i)` (the run's `params`, up to 16 numbers),
  `pass_number()`, `tool(q)` (a second grid placed at `toolOffset`), `lookup(i)` (the run's 256-entry `table`),
  `hash(q, salt)` (0 to 1, mixed with `seed`) and `noise(x)` (value noise 0 to 1). The result is clamped to 255.
- **Presets.** `brushes.grow` and `brushes.erode` give exactly `dilateGrid` and `erodeGrid` with all six directions
  (`params: [color]` colours the grown cells); `brushes.noise` fills where `noise(p * param(0)) > param(1)` with
  `param(2)`; `brushes.smooth` keeps a cell filled when most of its 27 neighbourhood cells are.
- **Runs.** `run(grid, {selection, passes, params, seed, tool, toolOffset, table, maxCells, signal})`: `selection` is
  cell indexes (as `./edit` returns them; default every cell), `passes` 1 to 1,024, each reading the one before. It
  resolves to `{grid, changed, clipped: 0}` like the CPU operations.
- **Errors.** `TypeError` for a wrong device, code without `fn brush`, or a bad option; `RangeError` for a value out of
  range or a grid over the device's storage binding limit; `MargoError` `failed` for WGSL that does not compile, naming
  the line of your code, and `disposed` after `dispose()`. `label` names the GPU objects for debuggers.

## Bones and posed voxel parts (`./rig`)

`VoxelRig` attaches voxel parts to the bones of a skeleton, the way blocky characters are animated: each part moves
rigidly with its bone, and a bone turns about its joint carrying its children with it. `matrices(pose)` gives every
part a model matrix (column-major, cells to model cells) to draw its `meshGrid` mesh with; `bake(pose)` resamples the
posed parts into one grid (each cell takes the part cell under its centre, so turned parts keep no holes), for frames,
export or a world. Joints and offsets are in model cells, Y up.

```ts
import type { VoxelGrid } from 'margoengine/voxel-edit';
import { meshGrid } from 'margoengine/voxel-edit/mesh';
import { rigRotation, sampleRigClip, VoxelRig } from 'margoengine/voxel-edit/rig';

const block = (sx: number, sy: number, sz: number, value: number): VoxelGrid => ({
  size: [sx, sy, sz],
  voxels: new Uint8Array(sx * sy * sz).fill(value),
});
const rig = new VoxelRig({
  bones: [
    { name: 'body', joint: [4, 0, 2] },
    { name: 'arm', parent: 'body', joint: [8, 9, 2] },
  ],
  parts: [
    { bone: 'body', grid: block(8, 10, 4, 1) },
    { bone: 'arm', grid: block(2, 8, 2, 2), offset: [8, 2, 1] },
  ],
});
const wave = {
  duration: 1,
  loop: true,
  tracks: [{ bone: 'arm', times: [0, 0.5, 1], rotations: [rigRotation([0, 0, 1], 0), rigRotation([0, 0, 1], 90), rigRotation([0, 0, 1], 0)] }],
};
const pose = { rotations: sampleRigClip(wave, 0.25) };
const [, armMatrix] = rig.matrices(pose); // draw meshGrid(part.grid) with these
const { grid, origin } = rig.bake(pose); // the posed character as one grid; origin is its corner in model cells
console.log(armMatrix.length, grid.size, origin, meshGrid(grid).mesh.positions.length > 0);
```

- **Poses.** `rotations` maps bone names to unit quaternions `[x, y, z, w]` (`rigRotation(axis, degrees)` builds one),
  applied about the bone's joint after its parent's turn; a bone left out turns with its parent. `translation` moves
  the whole model. A non-unit quaternion, an unknown bone or a parent listed after its child is refused with a fix.
- **Clips.** `sampleRigClip(clip, time)` interpolates each track's keys by spherical interpolation (the short way
  round), holds the first and last key, and wraps time when `loop` is true.
- **Baking.** A quarter turn bakes exactly as `turnGrid`; other angles resample at cell centres, so a part keeps its
  cell count only roughly. Later parts draw over earlier ones. The posed box is limited by `maxCells` (default
  16,777,216).
- **Rigid parts.** Each part follows one bone (rigid skinning, as blocky characters use); cells are not blended
  between bones. For smooth skinned meshes use `@margoengine/rigging` and `@margoengine/animation`.
