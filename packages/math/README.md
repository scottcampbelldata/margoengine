# @margoengine/math

Install `npm i margoengine` and import `margoengine/math` (or this package alone: `npm i @margoengine/math`, imported as `@margoengine/math`; the two are the same module).

Vector2, Vector3, Vector4, Quaternion, Euler, Matrix3, Matrix4, Color, Box3, Sphere, Plane, Ray, Frustum, Spherical and MathUtils. Methods write into `this` (chainable) or an `out` argument instead of returning new objects; only `clone()` and `toArray()` with no target return new ones.

```ts
import {Vector3, Quaternion, Euler, Color} from 'margoengine/math';
const position = new Vector3(0, 1, 0).addScaledVector(new Vector3(1, 0, 0), 2);
mesh.setPosition(position.toArray()).setQuaternion(new Quaternion().setFromEuler(new Euler(0, Math.PI / 4, 0)).toArray());
engine.camera.position = new Vector3().copy(mesh.position).add(new Vector3(0, 2, 5)).toArray();
new Color('#ff8800').toArray(mesh.material.data); // linear RGB, recolors in place
```

Each type is its own module: `import {Vector3} from '@margoengine/math/vector3'` (or from the root, which tree-shakes the same) ships about 1.3 kB min+gzip. The whole package is about 10.4 kB min+gzip ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)).

Array helpers: the other Margo packages work on plain arrays (`number[]`, `Float32Array`, `Float64Array`) rather than these classes, and share one copy of those helpers from here, each bundled into the package that uses it. `@margoengine/math/mat4`: `multiplyMatrices(a, b, out)`, `invertMatrix(m, out)` (cofactors), `invertMatrixStable(m, out, workspace?)` (pivoted, rejects non-finite input and Float32 overflow; `out` may be `m`) and `composeMatrix(t, q, s, out)`, column-major like `camera.matrix`, float64 arithmetic; the inverses return null (`out` untouched) when they fail. `@margoengine/math/quat`: `eulerToQuaternion(x, y, z)` (XYZ, like `Mesh.setRotation`), `multiplyQuaternions(a, b)`, `axisAngleToQuaternion(axis, angle)`, `conjugateQuaternion(q)`, `normalizeQuaternion(q)` and `rotateByQuaternion(v, q)`, returning new arrays, and `rotationToQuaternion(m, out?, sx?, sy?, sz?)`: the rotation of a column-major 3x3 or 4x4 (columns divided by the given scales; a negative `sx` undoes a mirror), the one conversion every package uses.

Checked contracts for saved data (each reproduces Margo Voxel Studio's saved arithmetic bit for bit, `test/checked.test.js`; nothing else changes): `@margoengine/math/quat` `interpolateQuaternions(a, b, t, linearAbove)` interpolates along the shorter arc, linearly above dot `linearAbove` (0.9995 is Studio's saved curve) and spherically below, always normalized; `Quaternion.slerp` keeps its own switch. `@margoengine/math/mat4` `transformPointChecked(m, p, minW = 1e-12)` divides by w like `Vector3.applyMatrix4` but returns `{ok: false, reason, w}` for a non-finite w, |w| below `minW` or a non-finite point instead of a NaN or huge point. `@margoengine/math/affine` `decomposeAffine(matrix, tolerance = 1e-5)` returns `Matrix4.decompose`'s translation, rotation (normalized) and scale with what that reading drops: Gram-Schmidt `shear` factors, `handedness` (`'right'`, `'left'` for a reflection, `'degenerate'`), `projective`, and the recomposition `error` with `lossless` (error <= tolerance). `Matrix4.decompose` always returns parts, even for a sheared matrix; check `lossless` before treating them as the whole transform. `@margoengine/math/color` also has `parseColor(value, out?, offset?)` for the packages' `ColorInput` (`'#rrggbb'`, `'#rgb'`, `0xrrggbb` decoded from sRGB, CSS `color(display-p3 r g b)` and the `srgb`, `srgb-linear` and `display-p3-linear` spaces, or linear `[r, g, b]`). Display P3 input: `ColorSpace` has `'display-p3'` and `'display-p3-linear'` (`Color.setRGB/setHex/setHSL/setStyle/getRGB/getHex/getHSL` take them), `P3_TO_SRGB`/`SRGB_TO_P3` are the linear matrices derived from the two sets of primaries (D65), `linearP3ToLinearSRGB` and `linearSRGBToLinearP3` apply them, and colours outside sRGB keep their negative linear sRGB channels for the shaders that carry them to a wide-gamut canvas (tonemap's excess output with environment's `ColorOutput`). `clipToSRGB(rgb)` desaturates such a colour toward its luminance until no channel is negative, for inputs that take sRGB only, such as core's sun. `@margoengine/math/vec3`: `add`, `sub`, `scale`, `dot`, `cross`, `length`, `normalize` on `[x, y, z]` (new arrays). `@margoengine/math/validate`: `finiteVector(v, size, name)` throws unless `v` is `size` Float32-finite numbers. These are kept bit-for-bit identical to the package copies they replaced (`examples/package-benchmarks/proofs/math-consolidation.proof.js`), so their operand order is fixed.

Core interop: `toArray()` with no target returns a tuple that `setPosition`, `setScale`, `setRotation`, `setQuaternion`, `camera.position` and `fitToBoundingBox` accept. `copy()` reads any `{x, y, z}`, including `mesh.position`; `Euler.setFromVector3(mesh.rotation)` reads core's XYZ angles. `Matrix4.fromArray` reads `camera.matrix` and world matrices from `@margoengine/core/extension`. `Frustum.fromArray(camera.planes)` and `setFromProjectionMatrix` use core's plane order and WebGPU depth range ([0, 1], reversed-Z included); pass `false` for WebGL [-1, 1]. `Color` stores linear sRGB; hex, CSS and HSL inputs are decoded from sRGB.

`Euler.setFromQuaternion` and `setFromRotationMatrix` keep the exact orientation in all six orders, also at and next to ±90° (the middle angle is in [-π/2, π/2]). At a pole many angle triples give the same rotation, so compare orientations, not angles.

Angles saved in degrees (editors, file formats): `degreesToQuaternion([x, y, z], order)` returns `[x, y, z, w]` for the
same intrinsic convention as `Euler` (default `'XYZ'`), and `quaternionToDegrees(q, order)` normalizes `q` and returns
degrees. Both throw `RangeError` for non-finite input.

`gradeSRGB(rgb, {brightness, contrast, hue, tint, tintStrength}, out?)` grades a display-space (sRGB, 0..1) colour as
palette editors do: hue rotation in degrees through HSL, contrast about 0.5, added brightness, then a multiply by
white blended toward `tint`. The result is not clamped.

Shared types and errors (type-only, 0 runtime bytes for the types): every Margo package takes its tuple and colour types from here (`Vec2`, `Vec3`, `Vec4`, `Quat`, `MutableVec2`, `MutableVec3`, `Mat4`, `ColorInput`, `HeightField`, the `*Like` shapes), and throws `MargoError` (`code`: `disposed`, `attached`, `state`, `unsupported`, `failed`) for everything that is not an argument `TypeError`/`RangeError`; see [docs/conventions.md](../../docs/conventions.md). `@margoengine/math/mesh` has `meshWorldMatrix(engine, mesh)`, the live world matrix of a visible core mesh (or null), which lines, points and text re-export; it is the one entry that imports `@margoengine/core/extension` at runtime.

Billboards (`@margoengine/math/billboard`, Crocotile-style object billboards; the mesh's front faces its local +Z):
`billboardRotation(cameraWorld, position, {mode, lockY, snap, parent})` returns the `[x, y, z, w]` rotation that turns
the mesh toward the camera. `mode: 'direction'` (default) matches the camera's orientation (parallel to the view
plane), `'position'` points +Z at the camera position; `lockY` keeps up at +Y (yaw only); `snap` rounds the yaw to that
many degrees; `parent` (its world matrix) makes the result the local rotation. `billboardDirection(facing, toCamera,
available?)` picks the 8-direction animation suffix (`'N'` ... `'NW'`) sprite-sheet style: a camera in front of the
object shows `'S'`, behind it `'N'`, at the object's left (its local +X) `'W'`; `available` limits it to the suffixes
an animation has. Per frame, for unparented meshes:

```ts
import {Matrix4, Vector3} from 'margoengine/math';
import {billboardDirection, billboardRotation} from 'margoengine/math/billboard';
const c = engine.camera,
  eye = new Vector3(...c.position),
  cameraWorld = new Matrix4().lookAt(eye, new Vector3(...c.target), new Vector3(...c.up)).setPosition(eye).elements;
for (const mesh of billboards) {
  const p = [mesh.position.x, mesh.position.y, mesh.position.z];
  mesh.setQuaternion(billboardRotation(cameraWorld, p, {lockY: true, snap: 45}));
  play(`walk_${billboardDirection(heading, [eye.x - p[0], eye.y - p[1], eye.z - p[2]])}`);
}
```

Limits: matrices are Float64Array (copy into a Float32Array for GPU upload). No input validation, so NaN propagates. `Color.setStyle` reads `#rgb`, `#rrggbb`, `rgb()` and `hsl()` but not named colors. Not included: Line3, Triangle, Cylindrical, Matrix2, `Vector3.project`/`unproject` (no camera object), `Euler.reorder`, ColorManagement and Display-P3, `generateUUID`. `Sphere.setFromPoints` is a bounding-box-centered sphere, not the minimal one.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/math
