# @margoengine/gizmo

The standalone Margo gizmo entry point reuses the existing controls package's tested TransformControls implementation.

```ts
import {Gizmo} from '@margoengine/gizmo';
// Gizmo is TransformControls; use its existing constructor/options.
```

Exports TransformControls (also named Gizmo), buildGizmo, pickHandle, tessellate and their public types. Translation, rotation and scale behavior remains shared with controls rather than copied. See @margoengine/controls for attachment, camera interaction, snapping, local/world axes and disposal.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/gizmo

