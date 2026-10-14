# Afterlight native Chrome long sampling comparison

The complete Off ABBA shows a substantial local improvement from 1× sampling
at identical 1432×768 GPU pixels and engine DPR1. The full experiment failed
during the third 1M window; it does not prove sustained 1M stability, a strict
60 Hz floor, newer-build startup or physical display presentation.

No production defaults, Core/Stage APIs or source files changed for this test.
Chrome 155.0.8059.40 ran headful, with desktop viewport 1432×768 and browser DPR2.
Profiling stayed off, with no timestamp queries or timed GPU readbacks. The
private rewrite changed only the existing sampling policy and fixed engine DPR.
Every completed window retained desktop terrain, grass, settlement, 256-cell
water, spray, shadows, fixed hours and exactly matching cameras. Other user
browser workloads remained open.

The retained immutable snapshot is
`test-results/site-retained-streaming-20261013T095448496Z`. It predates the later
first-reflection startup fix. Its full steady graph is the attribution scope;
recorded startup/readiness is separate and cannot prove the newer startup path.

| Workload/window | Samples | Successful render/submit Hz | Median gap ms | p95 ms | p99 ms | Max ms | Gaps >25 ms | Gaps >33.333 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Off A1 | 4 | 28.11 | 34.10 | 48.50 | 56.80 | 530.90 | 1,584 | 990 |
| Off B1 | 1 | 60.75 | 16.40 | 27.00 | 34.00 | 67.20 | 333 | 47 |
| Off B2 | 1 | 63.29 | 16.30 | 25.30 | 30.50 | 78.00 | 218 | 25 |
| Off A2 | 4 | 27.91 | 34.10 | 50.90 | 59.30 | 138.30 | 1,524 | 971 |
| 1M A1 | 4 | 20.36 | 49.00 | 62.30 | 76.20 | 159.40 | 1,215 | 1,205 |
| 1M B1 | 1 | 33.11 | 29.40 | 42.20 | 56.00 | 132.50 | 1,560 | 532 |

Each window lasted approximately 60.2–60.5 seconds. A counted frame required
the original `Engine.render` to return and contain exactly one successful native
GPU queue submission with one command buffer. Counts matched the original app
frame counter, including every per-second bucket. No frame loop or RAF was
replaced. Exact camera, actual visible/focused state, zero query/buffer allocation
delta, zero page/GPU errors and sample policy checks passed for all six completed
windows. Completion-gap timestamps measure browser render/submit cadence,
not GPU hardware execution or physical presentation.

The 1M B2 page evaluation exceeded its 75-second deadline. Its resource cleanup
exceeded five seconds and Chrome close exceeded 30 seconds. No B2 timings were
accepted, and 1M A2 did not run. The last completed 1M indirect readbacks were
`[6,1000000,0,0,0]`; this does not prove continuous million-instance occupancy.
Finite authored lifetimes permit natural occupancy variation. Device-lost
events and start/config/dispatch boundaries were not captured by this version.
The cause of the later responsiveness failure remains unresolved.

Off cleanup retired four devices exactly once with zero live tracked textures
or buffers. The unresponsive 1M page prevented proof of its exact resource
retirement. Focused identity checks tracked runner PID 33564, Chrome main PID
2768, its matching profile and children. They exited without forced termination;
the runner exited 1, the preview closed and subsequent checks found no owned
profile processes or children. Prior CPU/start identities and the limitations
of the failed uptime snapshot are saved in the terminal sidecar.

Twenty quality PNGs were saved outside speed windows: three exact static camera
angles and seven stepped yaw poses for each AA path. Every PNG hash and actual
1432×768 header was read back; camera poses matched across paths. This is a visual
AA comparison, with no cross-AA pixel-equality assertion or continuous-motion
performance claim. The complete absolute paths and hashes are in the evidence
manifest; the three static pairs are:

- `test-results/afterlight-sampling-long-native-chrome-v1-{4,1}x-angle-0.png`
- `test-results/afterlight-sampling-long-native-chrome-v1-{4,1}x-angle-1.png`
- `test-results/afterlight-sampling-long-native-chrome-v1-{4,1}x-angle-2.png`

Raw report:
`test-results/afterlight-sampling-long-chrome-60s-native-chrome-v1.json`.
SHA-256: `787a7e5720273b5abc5bd3fd05b90c87aa7e788a1cd05548f6e9a8fe86aa21fc`.
Full stdout SHA-256:
`0aa52613d9f2276bc612c5a2218619b65398f07444ccfeb7987699dd6727d193`.
Evidence manifest:
`test-results/afterlight-sampling-long-chrome-60s-native-chrome-v1.evidence.json`.
The actual v1 runner/browser initializer were preserved as sibling source files
before preparing the corrected variant.

The corrected private `config-boundaries-v2` preparation records indirect start
and end only outside speed windows; requires valid six-index indirect draws and
natural integer occupancy from zero to the unchanged capacity; verifies authored
capacity, initialCount, rate, lifetime, size and option equality; identifies the
unchanged VFX simulation source; and observes its existing full-capacity dispatch
and capacity/lifetime/size uniform on every timed frame without extra GPU work.
It also records device-lost events. Syntax and metadata-only preparation pass;
this version has not run. The failed v1 report and assertions were preserved.

Prepared command, requiring a fresh exclusive hardware grant:

```sh
node test-results/afterlight-retained-sampling-long-abba.mjs --run --seconds=60 --label=config-boundaries-v2
```

There is currently no public sampling configuration: `EngineOptions` exposes
capacity/backend/camera and the private `sceneSamples()` uses the existing
mobile/desktop policy. A freeze-safe future choice is separate application build
flavors: retain the unchanged 4× quality bundle and compile a performance bundle
whose existing helper selects 1×, with identical DPR policy in both. Application
route/build selection adds no Core API or feature. Each resulting Core+Stage
artifact still requires the less-than-20,000-byte gzip gate. No such production
policy change is applied here.
