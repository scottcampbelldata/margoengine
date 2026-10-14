# Remaining asset and effect workload measurements

The nine remaining prepared factories are Loaders, Exporters, USDZ-export,
Decoders, IFC, FBX, Points, Toon and Transitions. Each uses the actual built
optional package and a reproducible checked-in asset. Native/layout browser
measurements are queued behind the serial hardware slot; preparation alone is
not a performance result. These small fixtures establish concrete operations
and ownership, not complete format support or commercial-scene acceptance.

| Factory | Actual work and meaningful check | Explicit limit |
| --- | --- | --- |
| Loaders | Parse and draw 855-vertex/1,689-triangle PLY dolphins; repeat bounded parse jobs | One PLY fixture, not all loader formats |
| Exporters | Export knight to GLB, binary PLY, STL and OBJ/MTL; draw the emitted PLY; validate 502 vertices/1,000 triangles and output counters | GLB/FBX validator proof is CPU correctness; browser batch displays the PLY round trip |
| USDZ-export | Write aligned archive and parse its 1,000-triangle knight back into drawn surfaces | Static USDA archive; no Apple Quick Look or texture acceptance |
| Decoders | Actual two-worker Draco pool decodes 406 vertices/682 triangles; draws transferred geometry; owns worker termination | Draco geometry only; no KTX2/meshopt or source texture acceptance |
| IFC | Actual web-ifc Wasm tessellation; IFC4 wall, Express ID 25, name and meter extents 0.2/3/4 | One wall, no BIM property navigation or large-building claim |
| FBX | Real FBX-to-GLB conversion and drawn converted triangle; emitted geometry counters | Tiny static fixture; no skin, texture or animation acceptance |
| Points | Actual PCD clouds and sprites, per-frame range uploads, eye-dome toggle and actual pointer pick | 397 points/cloud, no large scan claim |
| Toon | Real stepped shading and inverted hull; toggle changes scene pixels | Small dolphin surfaces, no full material feature audit |
| Transitions | Real captured scene switches with wipe/dissolve/radial/chromatic passes; pause freezes progress | Small static scenes; captured image difference is not perceptual parity |

The runner preserves startup stages, actual visible/draw counts, nonblank canvas
images, OFF/ON/ON/OFF profiling windows, keyboard pause/resume, count rebuild,
resize and pagehide cleanup. The strict target remains first complete principal
scene within 1,000 ms, both unprofiled means at least 60 Hz and every unprofiled
interval within 16.67 ms plus 0.2 ms timestamp tolerance. Failures remain failures
after evidence is saved. Layout emulation uses the same Intel GPU; physical
Android and production cold-load proof remain open.

Queued command, to run only when the laptop hardware slot is free:

```powershell
$env:GPU_VENDOR = 'intel'
$env:WORKLOAD_PACKAGES = 'loaders,exporters,usdz-export,decoders,ifc,fbx,points,toon,transitions'
$env:WORKLOAD_REPORT_PREFIX = 'package-asset-effects-20261013'
node scripts/benchmark-package-workloads.js
```

## Failure attribution prepared for the five prior misses

Prior actual render/media evidence contains three native startup misses and two
isolated unprofiled interval misses. The saved startup stages show:

| Native startup case | First principal submit to GPU-complete ms | Synchronous mount ms | Interpretation |
| --- | ---: | ---: | --- |
| Animator | 252.0 | 42.2 | Completion wait is much larger than model mount |
| TAA | 755.9 | 40.8 | Temporal pipelines/first-use work are candidates, not isolated causes |
| Splats | 605.3 | Not separately recorded | The 11.3 ms engine-created-to-assembled stage is much smaller than completion wait |

Those waits include upload/driver/GPU/queue work and do not prove shader
compilation or memory bandwidth. The initial dynamic import/factory stage also
cost about 252–262 ms in all three; optional module/network timing will separate
that from actual source parsing. Root's exact-descriptor early async pipeline
experiment showed no comparable warmed startup improvement and was rejected.

Audio's 74.8 ms native interval happened with measured workload/render CPU maxima
of 0.3/1.3 ms. Blender's 25.1 ms layout interval happened with 0.5/1.1 ms maxima;
its recurring four-item decode batch took about 0.2 ms. The saved summaries do
not correlate those gaps with individual tasks, so no package cause is asserted.

`WORKLOAD_TRACE=1` now prepares a bounded diagnostic path: startup navigation and
resource waterfall, actual synchronous/async GPU API call latency, first submit
timestamps, main-thread long tasks, and previous/current/next callback rows around
missed intervals. Main-thread long tasks are limited to tasks of at least 50 ms;
absence of an entry cannot explain a 25 ms gap. GPU API timing does not measure
deferred compilation. Tracing stays off by default and requires an untraced
comparison before retaining a performance change. No production package has been
modified on the basis of these hypotheses.

## Completed traced functional batch

All 18 actual native/layout cases and 72 profiling windows completed. Package
operations, output counters, nonblank pixels, controls, pause/rebuild/resize and
terminal cleanup passed with zero GPU/page errors. Both Draco profiles created
nine owned decoder workers across the five rebuilds and terminated every worker
exactly once. All devices, contexts, browser and Vite server closed. The runner
exited 1 after saving all 16 strict target misses; no threshold was weakened.

| Profile | Package | Principal ms | OFF callback Hz | Worst OFF interval ms | Strict local target |
| --- | --- | ---: | --- | ---: | --- |
| Native Windows | loaders | 4973.4 | 118.840 / 120.002 | 33.3 | Fail startup and tail |
| Native Windows | exporters | 1136.4 | 117.228 / 117.619 | 33.3 | Fail startup and tail |
| Native Windows | usdz-export | 1259.5 | 111.347 / 113.272 | 75.1 | Fail startup and tail |
| Native Windows | decoders | 1812.7 | 119.998 / 120.000 | 10.1 | Fail startup |
| Native Windows | ifc | 11703.3 | 118.813 / 120.000 | 16.6 | Fail startup |
| Native Windows | fbx | 6940.3 | 119.997 / 120.003 | 9.6 | Fail startup |
| Native Windows | points | 1498.8 | 119.032 / 120.005 | 25.0 | Fail startup and tail |
| Native Windows | toon | 1105.1 | 120.002 / 119.995 | 13.1 | Fail startup |
| Native Windows | transitions | 1148.0 | 120.002 / 120.002 | 8.6 | Fail startup |
| Android layout on Intel | loaders | 583.1 | 117.206 / 119.995 | 66.7 | Fail tail |
| Android layout on Intel | exporters | 785.1 | 113.224 / 117.605 | 83.2 | Fail tail |
| Android layout on Intel | usdz-export | 599.3 | 112.846 / 114.810 | 58.3 | Fail tail |
| Android layout on Intel | decoders | 548.2 | 119.997 / 120.000 | 8.6 | Pass sampled traced windows |
| Android layout on Intel | ifc | 1258.9 | 119.995 / 120.000 | 10.2 | Fail startup |
| Android layout on Intel | fbx | 1016.5 | 119.998 / 120.002 | 8.7 | Fail startup |
| Android layout on Intel | points | 2249.2 | 119.997 / 120.005 | 10.7 | Fail startup |
| Android layout on Intel | toon | 648.5 | 118.411 / 120.005 | 41.5 | Fail tail |
| Android layout on Intel | transitions | 546.0 | 119.598 / 119.997 | 16.7 | Pass sampled traced windows |

Tracing was enabled in this batch. These numbers include observer/API-wrapper
overhead and development-server behavior; they are diagnostic evidence, not
untraced production/cold-hosted or physical-phone acceptance. The tracked
[measurement summary](package-asset-effect-workloads-2026-10-13.json) preserves
individual frame rows and overlapping long tasks. Full bounded resource/API
traces and named screenshots remain in test-results/package-asset-effects-trace-20261013.json.

Confirmed attribution within these fixtures:

- Exporters' repeated real four-format work precedes 24–42 ms gaps with about
  25–44 ms synchronous workload CPU. USDZ's repeated jobs precede 42–75 ms gaps
  with about 34–50 ms synchronous export CPU plus asynchronous reimport work;
  multiple gaps overlap 58–75 ms main-thread long tasks. Their GPU pass timers
  are small/quantized, so GPU fill rate does not explain those specific gaps.
- Initial native IFC imports wait 5.88 seconds for the development server's
  19.8 MB transformed web-ifc module; FBX Three imports wait about 4.9 seconds.
  Layout Points waits 1.02 seconds for the local bunny response before parsing.
  These source-serving delays require a built-artifact comparison; treating
  them as measured production serialization cost would be incorrect.
- Initial Loader Core createRenderPipelineAsync request takes about 1.54 seconds
  between request and completion. This is API/driver completion latency, not an
  isolated GPU shader-execution measurement. Core/Stage source was unchanged.
- Isolated Points, Toon and layout Loaders intervals have short neighboring CPU
  work and no recorded task of at least 50 ms. Their causes remain unresolved;
  absence of a long-task entry cannot explain short scheduling/driver gaps.

All nine package statuses remain Open. The next useful tests are built-artifact
startup, untraced paired cadence, and targeted CPU serialization candidates.
