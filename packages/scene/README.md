# @margoengine/scene

Scene graph conveniences over core meshes, in an optional package so core stays small: `children`, `parent`, `traverse`, `userData`, `lookAt`, `getWorldPosition`, `getWorldQuaternion`, `getWorldScale` and `worldMatrix`. Import only the functions you use, or call `extendMeshes()` once to have them as members of every mesh.

```ts
import { box, Engine, PbrMaterial } from '@margoengine/core';
import { children, getWorldPosition, lookAt, traverse, userData } from '@margoengine/scene';

const canvas = document.querySelector('canvas')!;
const engine = await Engine.create(canvas);
const geometry = box();
const turret = engine.createMesh().setGeometry(geometry).setPosition([2, 0, 0]);
const barrel = engine.createMesh(turret).setGeometry(geometry).setPosition([0, 1, 0]);
barrel.setMaterial(new PbrMaterial({ color: '#d0a040' }));

userData(barrel).ammo = 12;
lookAt(turret, [0, 0, 5]);
console.log(children(turret).length, getWorldPosition(barrel));
traverse(engine.scene, (mesh) => {
  mesh.visible = true;
});
engine.start();
```

As members, for code that already reads this way:

```ts
import { box, Engine } from '@margoengine/core';
import { extendMeshes } from '@margoengine/scene/mesh';

extendMeshes();
const engine = await Engine.create(document.querySelector('canvas')!);
const parent = engine.createMesh().setGeometry(box());
const child = engine.createMesh(parent).setGeometry(box()).setPosition([0, 2, 0]);

child.userData.kind = 'lamp';
child.lookAt(0, 0, 5);
parent.traverse((mesh) => console.log(mesh.children.length, mesh.getWorldPosition()));
engine.start();
```

`extendMeshes()` adds the members to every mesh on this thread, existing ones included, and its types come with the entry. Importing changes nothing until you call it, and calling it again changes nothing.

| Function | Member | Result |
| --- | --- | --- |
| `children(mesh)` | `mesh.children` | Direct children in attach order, as a new array. |
| `parent(mesh)` | `mesh.parent` | The parent, or null. Change it with `mesh.setParent`. |
| `traverse(meshOrScene, visitor)` | `mesh.traverse(visitor)` | Calls `visitor` for each mesh, parents before children. A scene starts from its meshes with no parent. The visitor may dispose or move meshes. |
| `userData(mesh, value?)` | `mesh.userData` | The mesh's own object for your data, made on first use. Margo never reads it. |
| `lookAt(mesh, target, {up})` | `mesh.lookAt(target, {up})`, `mesh.lookAt(x, y, z)` | Turns the mesh so +Z points at the target, +Y leaning toward `up` (default `[0, 1, 0]`). |
| `getWorldPosition(mesh, out?)` | `mesh.getWorldPosition(out?)` | World position. |
| `getWorldQuaternion(mesh, out?)` | `mesh.getWorldQuaternion(out?)` | World rotation `[x, y, z, w]`. |
| `getWorldScale(mesh, out?)` | `mesh.getWorldScale(out?)` | World scale. A mirror shows as a negative x. |
| `worldMatrix(mesh)` | | World matrix, column-major, float64. |

`out` is an array of 3 numbers or an object with `x`, `y` and `z`, such as a `Vector3` from `@margoengine/math`; left out, the result is a new `[x, y, z]`. `target` is `[x, y, z]`, `{x, y, z}` or a mesh, meaning its world position.

## Good to know

- World results are right as soon as a value is written, before any frame: they read the local values up the parents, while `mesh.matrix` holds the last frame's matrix. Each call walks up the parents, so read `mesh.matrix` when a per-frame loop over many meshes needs no fresher value.
- Joint limits apply at the next frame. Until then a value outside its limit counts as written.
- `lookAt` turns +Z, the way a glTF model faces. A camera looks down its -Z and aims with `camera.target`.
- `lookAt` holds under any parent, scaled, mirrored or sheared: the direction goes back through the parent's matrix. At the target itself the mesh keeps its rotation, and looking straight along `up` uses the world axis furthest from it.
- Under a rotated, unevenly scaled parent the world matrix has shear, which no rotation and scale can hold: `getWorldQuaternion` and `getWorldScale` give the nearest ones, and `worldMatrix` stays exact.
