# @margoengine/cad

CAD import for Margo Engine: STL and OBJ, and the B-rep formats STEP (AP203, AP214, AP242), IGES 5.3, ACIS SAT,
Parasolid XT (.x_t, .x_b) and JT (ISO 14306), read and meshed by Margo's own kernel, `@margoengine/brep`, in a
worker. No third-party CAD code: the kernel is TypeScript written from the published standards.

```ts
import { Engine } from '@margoengine/core';
import { loadCAD } from '@margoengine/cad';

const engine = await Engine.create(document.querySelector<HTMLCanvasElement>('canvas')!);
const model = await loadCAD(engine, '/bracket.step', { signal: AbortSignal.timeout(30_000) });
console.log(model.meshes.length, model.failedFaces, model.warnings);
engine.start();
```

## Import

- `loadCAD(engine, url, options)` downloads a file and imports it; the format comes from the `format` option or the
  extension (`.stp`, `.igs`, `.x_t`, `.x_b` and `.xmt_txt` too). `parseCADAsync(engine, bytes, format, options)` does
  the same for an `ArrayBuffer` it transfers (and detaches). Both run in a worker and resolve with a `CADModel`: a
  hidden `root` shown once the whole file has loaded, one child mesh per part, and `dispose()`.
- `parseCAD(engine, input, 'stl' | 'obj')` reads STL and OBJ synchronously, units as in the file.
- B-rep files come in meters. Each placed body is meshed once from its exact geometry and every placement of it reuses
  that geometry with its own position, rotation and scale (a mirror is a negative x scale; a sheared placement gets its
  own copy with the matrix baked in). A body whose faces have different colours gives one mesh per colour; each colour
  is its own material. So `meshes` holds one mesh per placed body and colour, and repeated parts share one geometry.
- Shading: B-rep formats use the kernel's exact surface normals, smooth across each curved face and hard at every
  B-rep edge. STL and OBJ weld corners at the same point and smooth up to `creaseAngle` (default 40 degrees), so a box
  stays sharp and a cylinder cut into 9 or more sides shades round. `{ smoothing: false }` gives one flat normal per
  triangle.
- `linearDeflection` (B-rep only) is the largest distance in meters the mesh may stray from the true surface, the same
  for every body. Omitted, each body gets 0.001 of its bounding-box diagonal.
- `model.failedFaces` counts the faces the kernel could not mesh (each left out of its part; a body the kernel cannot
  read at all counts all its faces and the rest of the file still loads). `model.warnings` lists what the reader left
  out or assumed. Both are set only for B-rep files read by the bundled worker.
- `importer` reads the B-rep formats with a function of your own instead of the kernel. It gets the engine, the bytes,
  the format and the options after the size and option checks, and its `CADModel` is returned as is.
- Limits (each a RangeError that names it): 64 MiB per file, 1,000,000 vertices per geometry, 3,000,000 distinct
  triangle indices, `maxParts` meshes (default 100,000), `timeoutMs` (default 120,000) for the worker.

### Changes from the earlier CAD importer

Before 2026-11-13, STEP and IGES were read by a third-party WebAssembly importer. The kernel keeps the API and the
result shape; what changes for code written against the earlier importer:

- Per-placement transforms: parts used to be baked into world coordinates with identity transforms, one mesh per
  placement. Now each placement is a transform (position, rotation, scale) on a geometry shared by every placement of
  the same body.
- Multi-colour bodies: a body whose faces have several colours is split into several meshes, one per colour.
- Triangle counts: the default tessellation is the kernel's (0.001 of each body's diagonal, 0.5 rad between edge
  samples), so triangle counts differ from the earlier importer's.
- Mesh-only JT parts: JT parts that carry only triangle LODs and no exact B-rep are not read; the model lists each in
  `warnings`. Parts with an XT B-rep are read.
- No `.brep` input: the native file format of the earlier importer's kernel is not read.

## PartInstancer and deduplicateParts

`PartInstancer.attach(engine)` (WebGPU) first runs `deduplicateParts`, which shares Geometry between identical core
parts and points identical static glTF-pro primitives of one model at one GPU buffer pair (skinned and morphed
primitives keep their own). It then packs small closed static parts that have their own Geometry and equal material
values under one root into root-space GPU buffers: each part stays a visible mesh with its name, Geometry, material and
parent, core skips its claimed batch, and the plugin draws each pack once inside every core draw. A part returns to its
own draw when it moves, hides, changes material or geometry, or another visible mesh starts sharing its geometry. Big
parts (`partVertices`, default 4,096), shared Geometry and open shells stay on their own draws.

## Entries

- `@margoengine/cad/cad-async`: `parseCADAsync` and its types (`CADFormat`, `CADImportOptions`, `CADImporter`) on
  their own, without the synchronous STL and OBJ parser or `PartInstancer`.
- `@margoengine/cad/closed`: `capsAsSolid(geometry)`, true when every edge of a geometry is shared by exactly two
  consistently wound triangles (positions welded as `edgesGeometry` welds them): the test `PartInstancer` packs by,
  and the one a section view caps by.

## Stage

`addCAD(stage, url, options)` from `@margoengine/cad/stage` imports a file with `loadCAD`, adds it to the stage
and fits the camera to it.

## Package

ESM with TypeScript declarations, Apache-2.0. Peers: `@margoengine/core` and, optionally, `@margoengine/stage`.
Dependencies: `@margoengine/brep`, `@margoengine/geometry` and `@margoengine/math`. The worker
(`dist/workers/cad-runtime.js`) bundles the B-rep kernel and resolves relative to the shipped JavaScript; keep that
directory when copying the package. The package's `NOTICE` carries the Siemens JT notice for the JT reader the worker
bundles (`docs/jt-licensing.md`).
