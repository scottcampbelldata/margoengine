# Margo against other libraries

Three.js has no equivalent for these packages, so the rows live here instead of `perf-vs-threejs.md` (that file is
rewritten by `bench/parity-report.mjs`). Each rival is installed outside this repository and run as a black box.
Margo's harness is in the package's `scripts/rival-bench.mjs`. Both sides run in one process, taking turns, and the
time is the fastest round. These numbers were taken on a busy machine and are diagnostic, not a release claim.

| Package | Work | Margo | Rival | Result |
| --- | --- | --- | --- | --- |
| `@margoengine/behavior` | 1,000 agents, one flock step (separation, alignment, cohesion, radius 2) | 3.098 ms | Yuka 0.7.8, 9.472 ms | win |

The flock checksums after that step were 31517.19 (Margo) and 31516.70 (Yuka). Both moved from the same grid. They are
not bit-equal: Yuka keeps a neighbourhood per vehicle and Margo uses one uniform grid. The behaviours are the ones in
Reynolds 1987, weights 1.5, 1 and 1, max speed 3, max force 6. Rerun: `node packages/behavior/scripts/rival-bench.mjs`
after `npm run build --workspace @margoengine/behavior`. The Yuka install is `batch-167` under engine-bench
(`MARGO_ENGINE_BENCH` overrides the folder).
