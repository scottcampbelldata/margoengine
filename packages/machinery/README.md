# @vexel/machinery

Revolute/prismatic joints, gear and piston couplings, bounded IK, STL/OBJ ingestion, exploded views, sections, metrology and industrial material presets for Vexel.

```sh
npm install @vexel/core @vexel/machinery
```

```ts
import { Engine, box } from '@vexel/core';
import { Kinematics, industrialMaterial } from '@vexel/machinery';

const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const engine = await Engine.create(canvas);
const arm = engine.createMesh().setGeometry(box()).setScale([0.3, 1.5, 0.3])
  .setMaterial(industrialMaterial('anodizedAluminum'));
const kinematics = new Kinematics([
  { node: arm, axis: 'y', kind: 'revolute', min: -Math.PI / 2, max: Math.PI / 2 },
]);
engine.use(kinematics);
let elapsed = 0;
engine.onFrame((_, delta) => {
  elapsed += delta;
  kinematics.setAngle(0, Math.sin(elapsed));
});
engine.start();
```

Call `engine.dispose()` on teardown. Joints are configured through `Kinematics`; CAD files use `loadCAD` or `parseCAD`. Native STEP/IGES import is deferred. CPU machinery tools work with either backend; section rendering requires WebGPU, and solid caps require depth32float-stencil8 plus closed, consistently oriented meshes.

This ESM package includes TypeScript declarations and requires `@vexel/core` 0.1.0. See the [API and supported geometry guide](https://github.com/scottcampbelldata/vexel/blob/main/MODERN-ENGINE.md).

MIT licensed.
