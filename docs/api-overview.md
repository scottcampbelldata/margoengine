# API overview

A short tour. Each package README has the full reference. The public API of every entry point is recorded in
[`api/`](../api), and `npm run api:check` fails when it changes by accident.

## Three levels

| Level | Import | Use it when |
| --- | --- | --- |
| Stage | `margoengine` (`@margoengine/stage`) | You want a canvas, a camera, controls and loading in a few lines. |
| Engine | `@margoengine/core` | You manage the canvas, the frame loop and the scene yourself. |
| Packages | `@margoengine/<name>` or `margoengine/<name>` | You need a feature that is not in core. |

`margoengine/<name>` is a one-line re-export of `@margoengine/<name>`. Import either; the bundles are the same.

## Stage

```ts
import { createStage, Geometry } from 'margoengine';

const stage = await createStage('#scene', { controls: true, autoStart: true, onError: console.error });

stage.box({ size: [1, 1, 1], color: '#84d6bd', position: [0, 0.5, 0] });
stage.sphere({ radius: 0.5, metalness: 1, roughness: 0.2 });
stage.mesh(new Geometry(positions, normals, indices), { color: '#c3c9d0' });

const model = await stage.load('/part.step'); // glTF, GLB, STL, OBJ, STEP, IGES
stage.fit(model.meshes);

const off = stage.onTick((delta) => {}); // seconds since the last frame
stage.dispose();
```

`stage.engine` is the core `Engine` underneath.

## Engine

```ts
import { Engine, box } from '@margoengine/core';

// WebGPU; pass { fallback } from @margoengine/webgl to fall back to WebGL2
const engine = await Engine.create(canvas, { camera: { position: [0, 2, 5], target: [0, 0, 0] } });
const cube = engine.createMesh().setGeometry(box()).setPosition([0, 0.5, 0]);
engine.start();

const hit = await engine.pick(x, y); // GPU picking, a Mesh or null
engine.use(plugin); // attach a package (shadows, post effects, physics, ...)
engine.dispose();
```

Meshes are handles into the Wasm kernel's transform storage. `mesh.position`, `mesh.rotation` and `mesh.scale` are
live views, so writing to them costs no allocation. Geometry is shared: meshes with the same `Geometry` draw as one
instanced batch.

## Packages

Packages attach to an engine through plugins and the `@margoengine/core/extension` entry. They never change core, so
core stays inside its size budget no matter how many packages exist. Some examples:

```ts
import { Shadows } from 'margoengine/shadows';

const shadows = Shadows.attach(engine, { resolution: 2048 });
shadows.add(cube);
```

The [package list](../README.md#packages) and the [catalog](README.md) describe each one.

## B-rep

```ts
import { parseSTEP, tessellateSTEP, validateSTEP, parseSAT, parseXT, parseJT, model } from '@margoengine/brep';

const step = parseSTEP(bytes); // header, products, instances, bodies
const meshes = tessellateSTEP(step, { relativeDeflection: 0.001, angle: 0.5 });

const body = model.box('block', [0.05, 0.05, 0.02]); // metres
const step2 = model.bodiesToSTEP([body]);
```

See the [brep README](../packages/brep/README.md) and [examples/brep](../examples/brep/README.md).

## Errors

Bad arguments throw `TypeError` or `RangeError`. Everything else throws a `MargoError` with a stable `code`:
`disposed`, `attached`, `state`, `unsupported` or `failed`. Branch on the code, not the message. The conventions are in
[conventions.md](conventions.md).

## Limits

What is supported, what is not, and where each limit is enforced: [limits.md](limits.md).
