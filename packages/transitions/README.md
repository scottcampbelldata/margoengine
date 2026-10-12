# @margoengine/transitions

WebGPU scene-to-scene wipes, seeded pixel-noise dissolves, radial clock wipes and chromatic displacement.

```ts
import {Transitions} from '@margoengine/transitions';
const transitions = Transitions.attach(engine);
engine.render(); // establishes the outgoing image
transitions.start('dissolve', 0.75);
// Change the active scene; subsequent renders advance the transition.
```

start freezes the last rendered color target on the next frame. Durations use seconds. progress ends at one and rendering continues normally. Resize/device restoration cancels an active transition because old-sized images cannot be reused. Capture order is -80 and composite order 50; effects drawing after 50 are not part of the transition. No core or stage code changes are required.

MIT. Optional, tree-shakable package; core peer: ^0.1.0 || ^1.0.0.

Build and unit tests: npm test --workspace @margoengine/transitions

