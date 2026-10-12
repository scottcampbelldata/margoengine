# @margoengine/cinematic

A virtual camera with analytically integrated critically damped follow and look-at springs plus additive screen shake.

```ts
import {Cinematic} from '@margoengine/cinematic';
const rig = Cinematic.attach(engine, {offset: [0,3,6], damping: 6});
rig.follow(player);
rig.shake(0.2, 0.4);
```

follow accepts a live mesh from the attached engine or a world-position tuple. Mesh targets use world transforms. Shake amplitude is in world units and duration is seconds; it does not alter the settled spring position. The frame plugin owns camera position/target while attached, so disable competing camera controls. dispose detaches it.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/cinematic

