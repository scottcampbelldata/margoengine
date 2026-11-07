# @margoengine/math

Import `margoengine/math` from the `margoengine` package, or `@margoengine/math` from this package alone; the two are the same module. Neither is on npm yet: the [Install](../../README.md#install) section lists the two routes that work today (run in a clone, or install local tarballs).

Vector2, Vector3, Vector4, Quaternion, Euler, Matrix3, Matrix4, Color, Box3, OBB, Line3, Triangle, Capsule, Sphere, Plane, Ray, Frustum, Spherical, Cylindrical, SH3, MathUtils and the project functions. Methods write into `this` (chainable) or an `out` argument instead of returning new objects; only `clone()` and `toArray()` with no target return new ones.

```ts
import {Vector3, Quaternion, Euler, Color} from 'margoengine/math';
import {Engine} from 'margoengine/core';
import {createMesh} from 'margoengine/materials';
import {box} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const mesh = engine.createMesh().setGeometry(box());
const position = new Vector3(0, 1, 0).addScaledVector(new Vector3(1, 0, 0), 2);
mesh.setPosition(position.toArray()).setQuaternion(new Quaternion().setFromEuler(new Euler(0, Math.PI / 4, 0)).toArray());
engine.camera.position = new Vector3().copy(mesh.position).add(new Vector3(0, 2, 5)).toArray();
new Color('#ff8800').toArray(mesh.material.data); // linear RGB, recolors in place
```

Each type is its own module: `import {Vector3} from '@margoengine/math/vector3'` (or from the root, which tree-shakes the same) ships about 1.3 kB min+gzip. The whole package is about 10.4 kB min+gzip ([entry-sizes.json](../../examples/package-benchmarks/results/entry-sizes.json)).

Array helpers: the other Margo packages work on plain arrays (`number[]`, `Float32Array`, `Float64Array`) rather than these classes, and share one copy of those helpers from here, each bundled into the package that uses it. `@margoengine/math/mat4`: `multiplyMatrices(a, b, out)`, `invertMatrix(m, out)` (cofactors), `invertMatrixStable(m, out, workspace?)` (pivoted, rejects non-finite input and Float32 overflow; `out` may be `m`) and `composeMatrix(t, q, s, out)`, column-major like `camera.matrix`, float64 arithmetic; the inverses return null (`out` untouched) when they fail. `@margoengine/math/quat`: `eulerToQuaternion(x, y, z)` (XYZ, like `Mesh.setRotation`), `multiplyQuaternions(a, b)`, `axisAngleToQuaternion(axis, angle)`, `conjugateQuaternion(q)`, `normalizeQuaternion(q)` and `rotateByQuaternion(v, q)`, returning new arrays, and `rotationToQuaternion(m, out?, sx?, sy?, sz?)`: the rotation of a column-major 3x3 or 4x4 (columns divided by the given scales; a negative `sx` undoes a mirror), the one conversion every package uses.

Checked contracts for saved data (each reproduces Margo Voxel Studio's saved arithmetic bit for bit, `test/checked.test.js`; nothing else changes): `@margoengine/math/quat` `interpolateQuaternions(a, b, t, linearAbove)` interpolates along the shorter arc, linearly above dot `linearAbove` (0.9995 is Studio's saved curve) and spherically below, always normalized; `Quaternion.slerp` keeps its own switch. `@margoengine/math/mat4` `transformPointChecked(m, p, minW = 1e-12)` divides by w like `Vector3.applyMatrix4` but returns `{ok: false, reason, w}` for a non-finite w, |w| below `minW` or a non-finite point instead of a NaN or huge point. `@margoengine/math/affine` `decomposeAffine(matrix, tolerance = 1e-5)` returns `Matrix4.decompose`'s translation, rotation (normalized) and scale with what that reading drops: Gram-Schmidt `shear` factors, `handedness` (`'right'`, `'left'` for a reflection, `'degenerate'`), `projective`, and the recomposition `error` with `lossless` (error <= tolerance). `Matrix4.decompose` always returns parts, even for a sheared matrix; check `lossless` before treating them as the whole transform. `@margoengine/math/color` also has `parseColor(value, out?, offset?)` for the packages' `ColorInput` (`'#rrggbb'`, `'#rgb'`, `0xrrggbb` decoded from sRGB, CSS `color(display-p3 r g b)` and the `srgb`, `srgb-linear` and `display-p3-linear` spaces, or linear `[r, g, b]`). Display P3 input: `ColorSpace` has `'display-p3'` and `'display-p3-linear'` (`Color.setRGB/setHex/setHSL/setStyle/getRGB/getHex/getHSL` take them), `P3_TO_SRGB`/`SRGB_TO_P3` are the linear matrices derived from the two sets of primaries (D65), `linearP3ToLinearSRGB` and `linearSRGBToLinearP3` apply them, and colours outside sRGB keep their negative linear sRGB channels for the shaders that carry them to a wide-gamut canvas (tonemap's excess output with environment's `ColorOutput`). `clipToSRGB(rgb)` desaturates such a colour toward its luminance until no channel is negative, for inputs that take sRGB only, such as core's sun. `@margoengine/math/vec3`: `add`, `sub`, `scale`, `dot`, `cross`, `length`, `normalize` on `[x, y, z]` (new arrays). `@margoengine/math/validate`: `finiteVector(v, size, name)` throws unless `v` is `size` Float32-finite numbers. These are kept bit-for-bit identical to the package copies they replaced (`examples/package-benchmarks/proofs/math-consolidation.proof.js`), so their operand order is fixed. Bit for bit means on the same JavaScript engine: the sRGB curves use `**`, and `length`, `normalize` and `eulerToQuaternion` use `Math.hypot`, `Math.sin` and `Math.cos`, which each engine may round in its own way, so their last bit can differ between engines and versions (Node 26 on Windows computes `**` with the C library's pow, Node 22 with V8's own). Everything built only from `+ - * /` and `Math.sqrt`, such as the matrix products and inverses, gives the same bits everywhere.

Oriented boxes (`OBB`, also `@margoengine/math/obb`): `center`, `halfSize` and a pure-rotation `rotation` (Matrix3).
`fromBox3(box)` starts from an axis-aligned box and `applyMatrix4(world)` moves it (rotation, translation, mirroring,
and scale along the box's own axes, folded into `halfSize`). Queries: `containsPoint`, `clampPoint`, `distanceToPoint`,
`intersectsBox3`, `intersectsSphere`, `intersectsPlane`, `intersectsOBB(other, epsilon = 1e-6)` (separating-axis test
over the 15 face and edge axes; `epsilon` keeps near-parallel edges from reporting a false gap), and `intersectRay(ray,
out)` / `intersectsRay(ray)` (the nearest entry point, the origin when the ray starts inside, null on a miss). Touching
boxes intersect. `set`, the constructor, `fromBox3` and `applyMatrix4` throw `TypeError` or `RangeError` with the fix
for non-finite values, a negative half size, a rotation that is not orthonormal, an empty box, a projective or
zero-scale matrix, or a scale that would shear the box.

```ts
import {Box3, Matrix4, OBB, Quaternion, Ray, Vector3} from 'margoengine/math';
const turn = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4);
const crate = new OBB()
  .fromBox3(new Box3(new Vector3(-1, 0, -1), new Vector3(1, 2, 1)))
  .applyMatrix4(new Matrix4().compose(new Vector3(5, 0, 0), turn, new Vector3(1, 1, 1)));
const door = new OBB(new Vector3(6.2, 1, 0), new Vector3(0.1, 1, 0.5));
console.log(crate.intersectsOBB(door)); // true
console.log(crate.intersectRay(new Ray(new Vector3(0, 1, 0), new Vector3(1, 0, 0)), new Vector3())); // entry near x = 3.59
```

Segments and triangles (`Line3`, also `@margoengine/math/line3`; `Triangle`, also `@margoengine/math/triangle`). `Line3`
holds `start` and `end`: `at(t, out)`, `getCenter`, `delta`, `distance`, `closestPointToPointParameter(p, clampToLine)`,
`closestPointToPoint(p, clampToLine, out)`, `distanceToPoint` and `distanceSqToLine3(other, outThis?, outOther?)`, which also
writes the nearest point of each segment. A zero-length segment acts as a point. `Triangle` holds `a`, `b`, `c`
(counter-clockwise faces the viewer): `getNormal`, `getArea`, `getMidpoint`, `getPlane`, `getBarycoord(p, out)` (weights for
a, b, c in x, y, z), `getInterpolation(p, va, vb, vc, out)`, `containsPoint(p, epsilon = 0)`, `closestPointToPoint(p, out)`,
`distanceToPoint`, `isFrontFacing(direction)`, `intersectsBox(box)` (separating axes, touching counts) and
`setFromPositions(positions, ia, ib, ic)` to read a mesh. A degenerate triangle (corners in a line) has area 0, a zero normal
and null weights; its closest-point queries still answer for the segment it collapses to. For a ray, call
`ray.intersectTriangle(t.a, t.b, t.c, false, out)`.

`Cylindrical` (also `@margoengine/math/cylindrical`) holds `radius`, `theta` (azimuth around +y from +z, as in `Spherical`) and
height `y`: `setFromVector3(v)`, `setFromCartesianCoords(x, y, z)` and `toVector3(out)`.

```ts
import {Box3, Cylindrical, Line3, Triangle, Vector3} from 'margoengine/math';
const rail = new Line3(new Vector3(0, 0, 0), new Vector3(10, 0, 0));
const ramp = new Triangle(new Vector3(0, 0, 0), new Vector3(4, 0, 0), new Vector3(0, 0, -4));
console.log(rail.distanceToPoint(new Vector3(5, 3, 0))); // 3
console.log(ramp.getNormal(new Vector3()).toArray()); // [0, 1, 0]
console.log(ramp.closestPointToPoint(new Vector3(9, 2, 0), new Vector3()).toArray()); // [4, 0, 0]
console.log(ramp.intersectsBox(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)))); // true
const seat = new Cylindrical(3, Math.PI / 2, 1).toVector3(new Vector3()); // (3, 1, ~0): a quarter turn round the column
console.log(seat.toArray());
```

Project and unproject (also `@margoengine/math/project`), against anything with a view-projection `matrix`, such as
`engine.camera` once it has drawn a frame: `projectPoint(point, camera, out)` writes normalized device coordinates (x and y run
-1..1, +y up), `unprojectPoint(ndc, camera, out)` goes back, `worldToScreen(point, camera, width, height, out)` writes pixels
from the top-left corner, and `screenToWorld(x, y, depth, camera, width, height, out)` goes back. z is the camera's own depth:
on WebGPU near = 1 and far = 0, on WebGL near = -1 and far = 1, so a depth from `projectPoint` always round-trips. A point on or
behind the camera plane has no place on screen: the project functions return null instead of a mirrored position, and leave
`out` alone. `out` may be the input. `unprojectPoint` and `screenToWorld` throw `RangeError` for a matrix with no inverse, as in
a camera that has not drawn yet. Orthographic views from `@margoengine/cameras` work the same.

```ts
import {Vector3, screenToWorld, worldToScreen} from 'margoengine/math';
import {Engine} from 'margoengine/core';
const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const {clientWidth: width, clientHeight: height} = canvas;
const spot = worldToScreen(new Vector3(0, 2, 0), engine.camera, width, height, new Vector3());
const label = document.querySelector<HTMLElement>('#label')!;
if (spot) label.style.transform = `translate(${spot.x}px, ${spot.y}px)`; // null: behind the camera, hide the label
const atSameDepth = spot && screenToWorld(spot.x + 10, spot.y, spot.z, engine.camera, width, height, new Vector3());
```

Spherical harmonics (`SH3`, also `@margoengine/math/sh`): three bands of RGB radiance, for light probes and irradiance on the CPU.
`coefficients` is a Float64Array of 27 numbers, `k * 3 + channel`, in the order and with the signs of
`@margoengine/environment` radiance coefficients. Build one with `addAmbient(color)` and `addSample(direction, color, weight = 1)`,
where `weight` is the solid angle the sample stands for (`4 * Math.PI / count` for uniform samples, 1 for a distant light of that
irradiance). Read it with `getAt(direction, out)` (radiance) and `getIrradianceAt(normal, out)` (the clamped cosine applied;
multiply by albedo / PI for reflected light). Blend with `add`, `addScaledSH`, `scale` and `lerp`; `fromArray` and `toArray` move
the numbers. `shBasis(direction, out?)` gives the nine basis values. Directions need not be unit length; a zero or non-finite one
throws `RangeError`. Colours are any `{r, g, b}`. Three bands ring around a bright point of light, so a result can be a little
above the truth or below 0; results are not clamped.

```ts
import {Color, SH3, Vector3} from 'margoengine/math';
const sky = new SH3().addAmbient({r: 0.2, g: 0.3, b: 0.5}).addSample(new Vector3(1, 2, 0), {r: 3, g: 2.8, b: 2.4});
const room = new SH3().addAmbient({r: 0.4, g: 0.35, b: 0.3});
const probe = sky.clone().lerp(room, 0.25); // blend two probes as the player walks between them
const light = probe.getIrradianceAt(new Vector3(0, 1, 0), new Color());
console.log(light.r, light.g, light.b);
const upload = probe.toArray(new Float32Array(27));
```

`rotate(quaternion)` turns the stored light in place, so a probe baked on a moving object follows it without projecting again.
The quaternion need not be unit length; a zero or non-finite one throws a `RangeError`. Bands 0 and 1 stay exact and band 2 is
rebuilt from five fixed directions, so a turn and its inverse return the same coefficients within 1e-12.

Capsules (`Capsule`, also `@margoengine/math/capsule`): every point within `radius` of the segment `start` to `end`, the usual
collider of a character. `new Capsule()` stands 2 tall on the origin with radius 0.5; `axis` is the `Line3` between the ends.
Queries: `containsPoint`, `distanceToPoint` (0 inside), `clampPoint`, `getBoundingBox`, `getBoundingSphere`, `intersectsSphere`,
`intersectsCapsule`, `intersectsPlane`, `intersectsBox`, `intersectsOBB`, `intersectsTriangle`, `intersectRay(ray, out)` and
`intersectsRay(ray)`, all exact, touching counts. `pushOutOfTriangle(triangle, out)` writes the move that takes the capsule off a
triangle, or returns null when they do not overlap; its direction is the contact normal. `translate` moves the capsule and
`applyMatrix4` takes rotation, translation and uniform scale (the radius scales too); any other matrix throws `RangeError`, as
does a negative or non-finite radius in the constructor or `set`.

```ts
import {Capsule, Triangle, Vector3} from 'margoengine/math';
const hero = new Capsule(); // 2 tall, radius 0.5, feet on the origin
const push = new Vector3();
const ground = new Triangle(new Vector3(-9, 0, 9), new Vector3(9, 0, 9), new Vector3(0, 0, -9));
hero.translate(new Vector3(0, -0.2, 0)); // gravity for this step
if (hero.pushOutOfTriangle(ground, push)) hero.translate(push); // back up by 0.2
console.log(hero.start.y); // 0.5
```

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
import {Engine} from 'margoengine/core';
const engine = await Engine.create(document.querySelector('canvas')!);
const c = engine.camera,
  eye = new Vector3(...c.position),
  cameraWorld = new Matrix4().lookAt(eye, new Vector3(...c.target), new Vector3(...c.up)).setPosition(eye).elements;
const billboards = [engine.createMesh()], heading: [number, number, number] = [0, 0, 1];
const play = (clip: string) => console.log(clip);
for (const mesh of billboards) {
  const p: [number, number, number] = [mesh.position.x, mesh.position.y, mesh.position.z];
  mesh.setQuaternion(billboardRotation(cameraWorld, p, {lockY: true, snap: 45}));
  play(`walk_${billboardDirection(heading, [eye.x - p[0], eye.y - p[1], eye.z - p[2]])}`);
}
```

`@margoengine/math/color-space` names the colour spaces and converts between them. `convertColor(rgb, from, to, out?, offset?)` takes components from one space to another; `from` and `to` are `SRGBColorSpace`, `LinearSRGBColorSpace`, `DisplayP3ColorSpace`, `LinearDisplayP3ColorSpace` or the same strings (`'srgb'`, `'srgb-linear'`, `'display-p3'`, `'display-p3-linear'`). The result is not clamped, so a colour outside the target space keeps channels below 0 or above 1 and converts back unchanged; `clipToSRGB` brings one inside sRGB. An unknown name throws `TypeError`.

```ts
import { DisplayP3ColorSpace, SRGBColorSpace, convertColor } from '@margoengine/math/color-space';

const p3 = convertColor([1, 0, 0], SRGBColorSpace, DisplayP3ColorSpace); // about [0.9175, 0.2003, 0.1386]
const back = convertColor(p3, DisplayP3ColorSpace, SRGBColorSpace); // about [1, 0, 0]
```

Limits: matrices are Float64Array (copy into a Float32Array for GPU upload). No input validation outside `OBB`, so NaN propagates. `Color.setStyle` reads `#rgb`, `#rrggbb`, `rgb()` and `hsl()` but not named colors. Not included: Matrix2, `Vector3.project` and `unproject` as methods (use `projectPoint(v, camera, v)` and `unprojectPoint(v, camera, v)`, so Vector3 stays small), `Euler.reorder`, a global `ColorManagement` switch (spaces are named per call, as in `color.setRGB(r, g, b, 'display-p3')` and `color.getRGB(out, 'display-p3')`), `generateUUID`. `Sphere.setFromPoints` is a bounding-box-centered sphere, not the minimal one.

Apache-2.0. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/math

## Speed

Every class here assigns its fields in the constructor and declares none before it (`useDefineForClassFields: false`). A number field declared first would start as `undefined`, and V8 would then allocate on each write of a fraction: 10,000 `quaternion.setFromEuler(euler)` calls take 0.29 ms this way and took 0.48 ms before, so reuse one `Euler` and one `Quaternion` in a loop:

```ts
import { Euler, Quaternion } from '@margoengine/math';

const euler = new Euler(),
  quaternion = new Quaternion();
for (let i = 0; i < 10000; i++) quaternion.setFromEuler(euler.set(0.3, i * 0.01, 0.2));
```
