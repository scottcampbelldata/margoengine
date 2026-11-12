# Plugin lifetime fixtures (check:owners)

Every plugin package that attaches with `engine.use` or `scene.use` keeps one owner/lifetime fixture,
`packages/<name>/test(s)/owner-lifetime.fixture.js`. `npm run check:owners` runs them: first the CPU model (the real
core scene router and frame graph on a fake GPU), then, per package, a real WebGPU device and the WebGL2 compatibility
layer, each under one GPU slot. Packages with no fixture are printed as pending, never passed. Integration job J1 (work
list 5, batch I1) folded its own runner into this check instead of keeping a second one (manager ruling, 2026-11-11).

Run: `npm run check:owners -- --packages=taa,stats` (add `--cpu-only` for the CPU model alone). The fast gate in
AGENTS.md runs it for every changed package.

## Fixture contract

`export async function fixtures(load)` returns a list of entries. `load('../dist/<entry>.js')` imports the package's
own built entries (the browser leaf loads them by plain URL, so class and brand checks see one module instance). Each
entry is `{ name, visible?, viewDraws?, create(ctx) }`; `create` returns a handle:

- `plugin`: the registration under test. When `create` leaves it unattached, the harness attaches it with
  `scene.use(plugin)`.
- `dispose()`: detaches and disposes the way the package README says.
- `dependencies`: caller-owned plugins `create` installed through `ctx.dependency(fn)` (an Environment, an Animation).
- `check({ phase, host, views })`: optional package assertions after each render and after disposal.
- `cleanup()`: releases what the caller owns (meshes, models, its own textures), after the leak checks.

`ctx` is `{ engine, scene, host, dependency }`. `create` runs inside a setup of `scene`, so `engine.use` and
`X.attach(engine)` join `scene`, as they do for an app. Meshes and textures the caller owns are made inside
`dependency(fn)`, so they are its, not the plugin's.

## Cases

`tests/support/owner-lifetime.js` runs each entry in the default scene and in a second, non-active scene (`target`),
on two engines (a peer engine runs its own instance), through these modes:

- `direct`, `detach`, `scene`, `engine`: dispose through the handle, remove the plugin first, dispose the scene, dispose
  the engine.
- `loss-attached`, `loss-detached`: a real device loss and restore while attached, or after a detach.
- `cycles`: three more attaches and disposals on one device; GPU buffers, textures and query sets left alive, owned or
  not, must not grow from the second disposal to the third.

Every case renders two owner views and a view of the other scene and checks: no pixel writes outside the views'
scissors, the viewport and scissor restored before each draw, view state unchanged by passes, no cross-engine
registration or camera writes, the same-name plugin placed in the other scene (the decoy) left in place by disposal and
by a stale second dispose, a same-name replacement surviving a stale dispose, no frame graph pass running after
disposal, no event listener, GPU object or `onFrame` callback left by the owner, and `engine.views` left as found.

## What J1's runner added

J1's runner (tag lane-o-runner, aecb954eb, never landed) covered three things check:owners lacked; they are cases here:

| J1 runner check | check:owners case | Deliberate break that fails it |
| --- | --- | --- |
| Second scene, same-name decoy untouched | `secondary` target, decoy sentinels (already on main) | `tests/owner-lifetime.test.js` registration fault; the taa, stats and quality revert proofs below |
| GPU objects growing from cycle 2 to 3 | `cycles` mode | `cycle-growth` fault (an unowned buffer per disposal; passes `direct`) |
| Leftover frame graph passes | "no retained frame graph passes after disposal" (already on main) | |
| Leftover `onFrame` callbacks | "no leaked onFrame callbacks" | `frame-callback` fault; Stats without its frame listener removal: 26 of 65 cases fail |
| Leftover views | "disposal leaves engine.views as it found them" | `views` fault |

The runner's per-fixture `assert` (a package doing its job, such as a lit pixel or a cluster light count) is not a
lifetime check; those assertions live in each package's own GPU tests.

## Revert proofs

Each fix's source was reverted locally (never pushed), the package rebuilt, and
`node scripts/check-owner-lifetime-gate.mjs --packages=<p> --cpu-only` run, then the fix restored:

| Fix | Reverted | With the fix |
| --- | --- | --- |
| taa 25fa87f74 | 3 of 11 fail: "TAA releases its registration" (secondary direct and both loss cases) | 11 of 11 pass |
| stats f7947b63d | 15 of 55 fail: the same 3 cases for each of its 5 entries | 55 of 55 pass |
| quality c7b7273aa | 8 of 22 fail: registration, "same-name neighbor survives", "stale disposal preserves replacement" | 22 of 22 pass |

## Not covered

See docs/limits.md, "Owner/lifetime check (check:owners) limits".
