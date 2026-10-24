# @margoengine/voxel-edit

Editing voxel models for voxel editors and tools: dense and sparse grids, modeling operations, brushes and
selections, picking, export meshing, `.vox` scene editing and frame animation. CPU only, no renderer, no DOM: every
function is pure and can run in a worker. Optional and tree-shakable; core and the stage never import it.

```ts
import { combineGrids, mergePalettes, rotateGrid, type VoxelGrid } from '@margoengine/voxel-edit';
import { sphereCells, connectedCells } from '@margoengine/voxel-edit/edit';
import { pickRay, raycastGrid } from '@margoengine/voxel-edit/pick';
import { meshGrid } from '@margoengine/voxel-edit/mesh';

const model: VoxelGrid = { size: [32, 32, 32], voxels: new Uint8Array(32 * 32 * 32) };
const { grid } = rotateGrid(model, { axis: 'y', degrees: 90 }); // a new grid; `model` is unchanged
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
| `./assist` | `noiseFill` (seeded random fill), `suggestPalette` (seeded hues, linear sRGB) and `paletteUsage` (cells per index) |
| `./library` | `fetchLibrary` / `fetchAsset` / `resolveLibraryUrl`: list and fetch `.vox` packs from a JSON index, with a body size limit and abort |

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
