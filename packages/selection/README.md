# @margoengine/selection

Visible core-mesh selection outlines using Jump Flood Algorithm distance fields or circular morphological dilation.

```ts
import {Selection} from '@margoengine/selection';
const selection = Selection.attach(engine, {algorithm: 'jfa', width: 3, color: [1,0.5,0]});
selection.set([mesh]);
```

Width is viewport pixels, 1..32. The selection mask uses an identical core vertex transform and equal depth, so occluded selected surfaces do not appear. The composite excludes the mask interior. Morphology costs more for large widths; JFA uses logarithmic ping-pong steps. Invisible/disposed meshes are omitted. Separate glTF-pro/skinned buffers, custom vertex deformation and TAA-jittered geometry are not included in the core replay. Dispose releases all targets and passes.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/selection

