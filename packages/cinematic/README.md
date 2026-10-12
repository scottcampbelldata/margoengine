# @margoengine/cinematic

`rig.setOrbitOffset(yaw, pitch, distance, height = 0)` updates the retained camera
offset from orbit angles without allocating a new vector. The sandbox uses this
public method after its shared locomotion step.

A virtual camera with analytically integrated critically damped follow and look-at springs plus additive screen shake.

```ts
import {Cinematic} from '@margoengine/cinematic';
const rig = Cinematic.attach(engine, {offset: [0,3,6], damping: 6});
rig.follow(player);
rig.shake(0.2, 0.4);
```

follow accepts a live mesh from the attached engine or a world-position tuple. Mesh targets use world transforms. Shake amplitude is in world units and duration is seconds; it does not alter the settled spring position. The frame plugin owns camera position/target while attached, so disable competing camera controls. dispose detaches it.

Set `ground: (x,z) => height` to keep the camera arm above a CPU heightfield.
`clearance` defaults to 0.65 world units. The rig checks both its desired arm and
the resulting damped/shaken camera, without changing your requested `offset`.
For a below-target orbit, it raises the rendered aim point with the camera so
terrain clearance preserves upward look instead of forcing the view back down.
Six samples along each arm suit broad terrain; narrow ridges and buildings need
collision geometry. Heights must be finite. Ground handling is disabled by default.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cinematic

