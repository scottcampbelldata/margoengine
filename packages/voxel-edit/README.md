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
(default 16,777,216 cells, at most 67,108,864) before allocating anything.

| Root entry | Does |
| --- | --- |
| `combineGrids` | union (with a `paletteMap`), `intersect`, `subtract` of a tool grid at a whole-cell offset |
| `mergePalettes` | the `paletteMap` for a union: reuses equal identities, takes free indexes, never changes used base entries; throws past 255 |
| `shearGrid`, `reflectDiagonal`, `wrapGrid`, `rotateGrid` | shear by layers, mirror or symmetrize across a square plane's diagonal, move with wrap-around, turn by any angle inside the box |
| `repeatGrid`, `resampleGrid` | tile, or scale by nearest-cell sampling (indexes are never blended) |
| `dilateGrid`, `erodeGrid`, `fillEnclosed` | grow or shrink along chosen axis directions, fill closed cavities |
| `generateMaze` | a seeded perfect maze, one-cell walls and corridors |

## Entries

| Entry | Holds |
| --- | --- |
| `./edit` | brush footprints `lineCells`, `boxCells`, `sphereCells`; selections `floodCells` (same index), `connectedCells` (any filled), `faceCells` (an exposed layer), returned as cell indexes in a `Float64Array` |
| `./pick` | `pickRay` (pointer ray from the camera matrix, reverse depth), `raycastGrid` (first filled cell, the face and the cell in front of it), `groundCell` |
| `./sparse` | `SparseGrid`: models far larger than memory holds densely (a 1,000,000-wide grid with two cells holds two chunks), stored as `@margoengine/voxel` chunks, edited by copy-on-write snapshots with `restore` undo; `editWindow` fills, erases, paints, dilates or erodes a box; `serialize` / `deserialize`; `snapshot` / `fromSnapshot` / `restoreSnapshots` and `deltaSnapshot` / `applyDeltaSnapshot` for workers (`snapshotBuffers` is the transfer list); `toWorld` writes into a `VoxelWorld` |
| `./mesh` | `meshGrid`: greedy quads per palette index with optional corner ambient occlusion and crease-limited smooth normals; dense or sparse, chunk seams leave no inner faces; `partitionMesh` splits a mesh into one-palette parts of at most 250,000 quads (one million vertices, core `Geometry`'s limit), attributes copied |
| `./vox` | `gridFromVox` / `voxFromGrid` (MagicaVoxel's Z up to Y up and back; an unedited model is returned as it was) and scene-graph edits: layers, names, transform and shape keys, groups, instances, `moveVoxNode` (keeps world poses), `deleteVoxNode`; `voxTiles` splits a large dense or sparse grid into filled tiles of at most 256 cells per axis, each with its exact cell offset and no axis turned |
| `./animation` | `packFrames` / `unpackFrames` (each distinct model stored once) and `localFrame` (a clip's clock: offset, speed, loop or hold) |

Selections, picking and meshing take a dense or a sparse grid. Errors follow
[docs/conventions.md](../../docs/conventions.md): `TypeError` and `RangeError` for arguments and budgets,
`MargoError` with code `state` for a stale undo token, a non-empty target world, or a `.vox` edit the scene's
structure refuses (the last key of a track, the root, a cycle, moving a visible node into a hidden group).

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
