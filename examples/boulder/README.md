# Boulder

A robot on an indoor climbing wall. Click or tap a hold and the nearer hand or foot goes for it, or choose a route and
watch it climb. The arms stay clear of the wall, the volumes, the torso and the head the whole way, and each limb is
checked as its own convex hull, not as a capsule.

Run it with `npm run build:boulder`, then serve `test-results/boulder-site`. On the site it lives at `/demos/boulder/`.

A frame allocates nothing: every vector `Climb` writes each frame is a `Float64Array`, made with `vec()` in `climb.ts`. A plain
array can be widened by V8 so that each number written to it is boxed.

## Where things are

| File | What it owns |
| --- | --- |
| `rig.ts` | Everything tied to one character: asset, bone names, hull settings, hand and foot offsets |
| `wall.ts` | The wall profile, volumes, holds and routes, as plain data |
| `climb.ts` | The body's plan: contacts, the pelvis, the moving limb's path, the gaze. Plain numbers |
| `climber.ts` | Hands those numbers to the look-at, the avoidance solvers and the CCD chains, once a frame |
| `gym.ts` | The room, built in code from `wall.ts`. No textures |
| `tiers.ts` | What each quality tier turns on |
| `sound.ts` | Synthesized grip, chalk and landing sounds, off until pressed |

## Another character

Another GLB with the same 20 bone names works by changing `rig.ts`. Bone lengths, shoulder and hip positions and the head
joint are read from the file at load (`measureRig`), and the link hulls come from its skin weights (`jointHulls`). The
routes in `wall.ts` assume arms of about 0.54 m and legs of about 0.52 m; `tests/boulder-climb.test.js` says which stance
fails if a character cannot reach them.

## The order of a frame

1. `Climb.update` moves the pelvis, the moving limb and the gaze.
2. The animator poses the skeleton and runs the look-at.
3. The avoidance solvers run inside the animator (`animator.addSolver`), so they see this frame's shoulders, torso and head.
4. The CCD chains put the bones on the poses the solvers cleared.

```ts
import { addLookAt, Animator } from '@margoengine/animator';

declare const animator: Animator, look: Parameters<typeof addLookAt>[1], solveLimbs: () => void;
// Solvers run in the order they were added.
addLookAt(animator, look);
animator.addSolver(solveLimbs);
```

## When an arm has no clear pose

The hand stays on its hold, the elbow walks toward the solver's best try at the swivel speed limit, and the head lets go of
its gaze until the arm is clear. It never carries the old pose along with the shoulder, because that takes a planted hand
off its hold and into the wall.

## Checks

`node scripts/test-boulder-browser.mjs` climbs every route on the high tier and blue on the phone tier, and fails on a hull
gap under -5 mm, a knee past the armour limit, a move that comes up short or a console error. It also checks that under reduced
motion a move is instant and reaches the screen. `--shots=<dir>` saves
screenshots and `--closeups` adds the nearest views the orbit allows. `tests/boulder-climb.test.js` covers the plain logic.
