# @margoengine/cad

Install profile. CAD models: the shared scene packages, the B-rep kernel, and STEP and JT import.

It holds no code of its own and only re-exports its member packages: it installs only its declared domain members and forwards their original typed modules.
The root contains common exports; member subpaths expose the complete installed member APIs.
All packages release together at one version. Optional third-party peers remain app choices.

See the [kits guide](https://margoengine.com/llms/docs/guides/kits.md) for profile contents, independent installs,
model-loading entries and measured package counts.

With a `<div id="viewport" style="height:400px"></div>` in the page:

```ts
import {createStage, loadCAD} from '@margoengine/cad';

const stage = await createStage('#viewport');
const model = await loadCAD(stage.engine, '/bracket.step');
console.log(model.meshes.length);
```

A STEP file is a separate import from the same package: `loadCAD(stage.engine, url)`.
