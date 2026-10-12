# @margoengine/water

A separate WebGPU water grid evaluates up to eight Gerstner waves in the vertex shader, including analytical normals. Shoreline foam uses linearized reversed-Z scene depth and a decaying ping-pong foam history.

```ts
import {Water} from '@margoengine/water';
const water = Water.attach(engine, {size: [100,100], segments: 128, height: 0});
```

Directions are XZ, dimensions/amplitudes are world units, wavelengths are positive, and phase is radians. Invalid steepness that would fold the surface is rejected. Default water owns a shared sampleable scene-depth target with HTML. With SSAO/DOF, pass depth: () => effect.depthTexture explicitly; dimensions must match the viewport. Water is opaque, Y-up, and does not write scene depth. Reflection is a Fresnel-colored sky approximation, not a planar reflection pass. Foam history is screen-space and resets on resize/restoration.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/water

