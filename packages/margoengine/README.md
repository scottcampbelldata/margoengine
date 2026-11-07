# margoengine

Margo Engine in one install. The root is the stage (`createStage`, everything `@margoengine/core` exports), and every
engine package is a subpath: `margoengine/gltf`, `margoengine/shadows`, `margoengine/physics`, `margoengine/react`,
including their smaller entries (`margoengine/controls/orbit`, `margoengine/geometry/primitives`, ...).

The packages are not on npm yet: `npm i margoengine` gets only a name placeholder (0.0.1, no engine) until 1.0.0 is published. Use the clone or local-tarball routes in the [Install](../../README.md#install) section until then.

```ts
import {createStage} from 'margoengine';
import {Shadows} from 'margoengine/shadows';
import {OrbitControls} from 'margoengine/controls/orbit';

const stage = await createStage('#viewport', {controls: false});
const shadows = Shadows.attach(stage.engine, {resolution: 2048});
const ground = stage.box({size: [10, 0.2, 10], color: '#c8c8c8'});
const cube = stage.box({position: [0, 1, 0], color: '#84d6bd'});
shadows.add(ground);
shadows.add(cube);
const controls = new OrbitControls(stage.engine.camera, stage.engine.canvas as HTMLCanvasElement);
stage.onTick((delta) => {
  cube.rotation.y += delta;
  controls.update(delta);
});
```

## You load only what you import

`margoengine/<name>` is a one-line re-export of `@margoengine/<name>`, the same module with the same classes, and
every file is free of side effects. An app that imports `margoengine/shadows` bundles exactly the bytes it would bundle
from `@margoengine/shadows` (`tests/umbrella.test.js` compares the two bundles); the other packages are installed but
never loaded. `import {createStage} from 'margoengine'` is core + stage alone, 23,013 B gzip.

Use either name; they are interchangeable. Each package is still published on its own (`@margoengine/shadows`) for
apps that want a smaller install.

## Short names

```ts
import * as M from 'margoengine';
import * as Physics from 'margoengine/physics';

const stage = await M.createStage('#viewport');
const mesh = stage.box({color: '#84d6bd'});
mesh.position.y = 1;
const cubes: M.Mesh[] = [mesh];          // types come along: M.Mesh, M.Vec3, Physics.PhysicsOptions
console.log(cubes.length, typeof Physics.Physics);
```

A namespace import tree-shakes like named imports in every modern bundler: only the members you use are kept.

## Third-party libraries

Two packages use a library you install yourself, only when you use that package. Everything else is in the one
install.

| Package | Install | Why |
| --- | --- | --- |
| `margoengine/physics` | `npm i @dimforge/rapier3d-compat` | The solver; `await Physics.load()` readies it once per app |
| `margoengine/react` | `npm i react react-dom` | It is a React component library |

`margoengine/react` holds every React binding but five groups, each its own entry: `margoengine/react/gltf-pro`
(`Model`, `Gltf`), `/fbx`, `/animation`, `/materials` and `/physics`. The first four reach the Draco and Basis decoders,
and Vite copies a decoder's Wasm into the build as soon as it reads the module, used or not. A page that imports none
of them builds with no Wasm of theirs:

```tsx
import { Canvas, Mesh, BoxGeometry } from 'margoengine/react';
import { Model } from 'margoengine/react/gltf-pro'; // only on a page that loads a model
```

The kits `margoengine/game`, `/web` and `/viz` include `loadGLTF`, so their builds hold the decoder files; the browser
fetches them only for a file that uses Draco or KTX2.

Without them nothing else changes; the package that needs one says which to install when you use it.
