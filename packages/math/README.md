# @margoengine/math

Vector2, Vector3, Vector4, Quaternion, Euler, Matrix3, Matrix4, Color, Box3, Sphere, Plane, Ray, Frustum, Spherical and MathUtils, with three.js method names. Methods write into `this` (chainable) or an `out` argument; nothing allocates except `clone()` and `toArray()` with no target.

```ts
import {Vector3, Quaternion, Euler, Color} from '@margoengine/math';
const position = new Vector3(0, 1, 0).addScaledVector(new Vector3(1, 0, 0), 2);
mesh.setPosition(position.toArray()).setQuaternion(new Quaternion().setFromEuler(new Euler(0, Math.PI / 4, 0)).toArray());
engine.camera.position = new Vector3().copy(mesh.position).add(new Vector3(0, 2, 5)).toArray();
new Color('#ff8800').toArray(mesh.material.data); // linear RGB, recolors in place
```

Each type is its own module: `import {Vector3} from '@margoengine/math/vector3'` (or from the root, which tree-shakes the same) ships about 1.3 kB gzip. The whole package is about 10.4 kB gzip.

Array helpers: the other Margo packages work on plain arrays (`number[]`, `Float32Array`, `Float64Array`) rather than these classes, and share one copy of those helpers from here, each bundled into the package that uses it. `@margoengine/math/mat4`: `multiplyMatrices(a, b, out)`, column-major like `camera.matrix`, float64 arithmetic, no allocation. These are kept bit-for-bit identical to the package copies they replaced (`examples/package-benchmarks/proofs/math-consolidation.proof.js`), so their operand order is fixed.

Core interop: `toArray()` with no target returns a tuple that `setPosition`, `setScale`, `setRotation`, `setQuaternion`, `camera.position` and `fitToBoundingBox` accept. `copy()` reads any `{x, y, z}`, including `mesh.position`; `Euler.setFromVector3(mesh.rotation)` reads core's XYZ angles. `Matrix4.fromArray` reads `camera.matrix` and world matrices from `@margoengine/core/extension`. `Frustum.fromArray(camera.planes)` and `setFromProjectionMatrix` use core's plane order and WebGPU depth range ([0, 1], reversed-Z included); pass `false` for WebGL [-1, 1]. `Color` stores linear sRGB; hex, CSS and HSL inputs are decoded from sRGB, as in three.js.

Limits: matrices are Float64Array (copy into a Float32Array for GPU upload). No input validation, so NaN propagates. `Color.setStyle` reads `#rgb`, `#rrggbb`, `rgb()` and `hsl()` but not named colors. Not included: Line3, Triangle, Cylindrical, Matrix2, `Vector3.project`/`unproject` (no camera object), `Euler.reorder`, ColorManagement and Display-P3, `generateUUID`. `Sphere.setFromPoints` is a bounding-box-centered sphere, not the minimal one.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/math
