# Margo against other libraries

Three.js has no equivalent for these packages, so the rows live here instead of `perf-vs-threejs.md` (that file is
rewritten by `bench/parity-report.mjs`). Each rival is installed outside this repository and run as a black box.
Margo's harness is in the package's `scripts/rival-bench.mjs`. Both sides run in one process, taking turns, and the
time is the fastest round. These numbers were taken on a busy machine and are diagnostic, not a release claim.

| Package | Work | Margo | Rival | Result |
| --- | --- | --- | --- | --- |
| `@margoengine/behavior` | 1,000 agents, one flock step (separation, alignment, cohesion, radius 2) | 3.098 ms | Yuka 0.7.8, 9.472 ms | win |
| `@margoengine/navmesh` | gapped floor, build | 3.190 ms | recast-navigation 0.44.0, 1.130 ms | loss |
| `@margoengine/navmesh` | gapped floor, one path query | 0.064 ms | recast-navigation 0.44.0, 0.082 ms | win |
| `@margoengine/navmesh` | gapped floor, path length | 24.212 | recast-navigation 0.44.0, 23.778 | loss |
| `@margoengine/navmesh` | open floor, path length | 22.627416997969522 | recast-navigation 0.44.0, same value, the Euclidean length | equal |
| `@margoengine/ecs` | 100,000 entities, one `position += velocity` query | 1.249 ms | bitECS 0.4.0, 11.054 ms | win |
| `@margoengine/fsm` | 10,000 transitions of a two-state toggle | 1.443 ms | XState 5.33.4, 27.935 ms | win |
| `@margoengine/tween` | 10,000 linear tweens, one 16 ms step | 0.371 ms | tween.js 25.0.0, 1.018 ms | win |
| `@margoengine/netcode` | 180 frames, two peers, rollback against a forward-only run | 0.0176 ms/frame (rollback), 0.0086 ms/frame (forward) | no JavaScript rollback rival | published |
| `@margoengine/save` | 200 seeded migration round trips | 0.086 ms each, 87,234 bytes, 0 failures | no rival package | published |

The flock checksums after that step were 31517.19 (Margo) and 31516.70 (Yuka). Both moved from the same grid. They are
not bit-equal: Yuka keeps a neighbourhood per vehicle and Margo uses one uniform grid. The behaviours are the ones in
Reynolds 1987, weights 1.5, 1 and 1, max speed 3, max force 6. Rerun: `node packages/behavior/scripts/rival-bench.mjs`
after `npm run build --workspace @margoengine/behavior`. The Yuka install is `batch-167` under engine-bench
(`MARGO_ENGINE_BENCH` overrides the folder).

The navmesh rows use one gapped floor (four quads, cell size 0.25) and one open floor. Build time and the path query are
separate paired runs. Margo's gapped path takes the north hall (4 points, length 24.212). Detour takes the south hall
(5 points, length 23.778). The straight line through the gap corners is about 23.26. Both open-floor paths equal
`hypot(16, 16)`. The build loss and the length loss stay open in `docs/known-bugs.md`. The open floor and the rule that
the gapped path stays out of the hole are `packages/navmesh/test/path-length.test.js` (that test does not freeze
Detour's length). Rerun: `node packages/navmesh/scripts/rival-bench.mjs`.

The ecs row is one query over 100,000 entities, `position += velocity`, setup outside the timer. Both sides finished at
`n = 100000` and `sum = 5000050000`. Rerun: `node packages/ecs/scripts/rival-bench.mjs`.

The fsm row is 10,000 `NEXT` events on a two-state toggle. Construction is outside the timer. Both machines end in
state `a`. Rerun: `node packages/fsm/scripts/rival-bench.mjs`.

The tween row is 10,000 linear tweens from 0 to 100 over 1 second, one step of 16 ms. Both checksums are
16000.000000002541, which is 10,000 times 1.6. Halfway through a linear tween is halfway to the target
(`packages/tween/test/linear-oracle.test.js`). Rerun: `node packages/tween/scripts/rival-bench.mjs`.

The netcode row has no JavaScript rival. GGPO is C++ and Colyseus is not rollback. Two peers play the README fighter for
180 frames. A forward-only run (no latency, steady input) takes 0.0086 ms/frame. A rollback run (40 ms latency, input
that changes every frame) takes 0.0176 ms/frame. The last counted round resimulated 346 frames across both peers
(166 rollbacks each). The extra time per resimulated frame, using each round's own count, is 2.403 microseconds at
the minimum. The rollback run is slower because it simulates those extra frames, not because a rolled frame costs
many times a forward step. Busy machine, diagnostic. Rerun: `node packages/netcode/scripts/rival-bench.mjs`.

The save row has no rival package. Two hundred documents from seed 167 (version 1, entities, parents, components and
`$ref`) are migrated to version 2, validated, encoded, decoded, parsed and migrated again. The two results match and
validation is empty. One run on a busy machine: 87,234 bytes, 0.086 ms each. The same generator is locked by
`packages/save/tests/migration-fuzz.test.js`. Rerun: `node packages/save/scripts/fuzz-roundtrip.mjs`.
