# Sciviz batch 171 progress

Lane X, after batch 118. Data drawing only; physics remains on hold.

| Job | State | Evidence and remaining work |
| --- | --- | --- |
| 1. Moving flow | Done | GPU physical-time RK4 particles on 2D/3D steady/unsteady fields, fading generation-cut trails, all four deterministic seed layouts, fixed-seed respawn, CPU pathlines/streaklines and bounded exact device replay. NOAA Moving wind passes both layouts/backends; numeric, all-pixel parity, cancellation and all 23 README examples pass. Core/stage unchanged. |
| 2. Line integral convolution | Done | Optional retained GPU LIC, phase animation, scalar colour and affine 3D slices. CPU and analytical box/circular, mask, animation, exact restoration and zero-difference backend pixel checks pass, including after rebase. NOAA demo passes both layouts/backends and late-update regression. Full verify ran once with four metadata/test-fixture failures corrected and affected checks passing; all package GPU, 24 README, lint/hygiene/quality gates pass. 23,461 B gzip after main restored full-precision colormaps (ceiling 24,165 B); core/stage 23,924 B. Latest-main integration, coherent records and affected acceptance pass. |
| 3. Tubes and ribbons | Done | Existing geometry mesher reused; scalar radius/colour, half-vorticity twist, correct normals, seam/inflection and ownership regressions pass. Tracer critical-point root fix passes analytical and all 96 NOAA day/seed cases; old tracer fails both regressions. Single full verify: 14012 tests, 14010 passed; two metadata failures repaired and seven affected checks pass. 190 sciviz/site CPU, six GPU suites, 40 demo/layout/backend checks and 25 README runtime examples pass. Tube/ribbon parity is exact with actual-device restoration. Entry 2533 B, LIC 23461 B, core/stage 23924 B. LIC +13032 B exactly reproduces required restored colour data/lookup with unchanged measurement. [Receipt](../whitepaper/results/batch-171-tubes-validation.json). |
| 4. Derived fields | Done | CPU/GPU gradient, divergence, curl, vorticity, Q and lambda-2 with volume/isosurface integration. Source audit retained at sciviz-derive-source-461e82a93, byte hashes unchanged. Fast gate and both-backend GPU checks pass after main repaired Chromium shutdown. Entry 3993 B, ceiling 4249. |
| 5. Climate and solver formats | Done | CDF-1/2 lazy bounded hyperslabs, shared-owner VTK XML datasets and legacy 5.1. Six hash-pinned NOAA writer files; 734 affected CPU cases, both-backend rendering and 57 README runtime examples pass. Single full verify completed with three metadata failures; all 27 affected checks pass after repair. [Receipt](../whitepaper/results/batch-171-formats-validation.json). |
| 6. Atmosphere on globe | Done | Optional sky-owned Hillaire ECEF transport, UTC solar globe, per-fragment aerial perspective, GPU geographic wind, scalar/point layers and density clouds. Real NOAA demo and exact device replay on both GPU backends; 1095 CPU tests, 36 metadata tests and the fast gate pass. Atmosphere 32092 B, sky/planet 4687 B, flow 9118 B; core/stage unchanged at 23950 B. [Receipt](../whitepaper/results/batch-171-atmosphere-validation.json). |

Native WebGL2 batch 181 job 1 has surface/rectangle drawing and strict real-backend parity on main through
`6a09f480f`. Its axes, points/lines, volumes/slices, integrated CPU isosurfaces and real-data demos remain
unfinished. Compatibility-backed WebGL2 coverage does not establish those native paths.



Batch 171 job 5: the full verify completed within its 40-minute limit (1291.6 s), with 14250 of 14253 tests passing.
The three error-catalogue, reserved-port and generated-notice mismatches were corrected in their owners; all 27
affected checks pass. All other verify chains passed. The six format variants pass again on both GPU backends
through the free-port browser mode, with unchanged image hashes. Lint, hygiene and regenerated quality/API pass.
No second full verify ran, and the original invocation is recorded honestly as failed before these repairs.
Job 4 landed as 4f859923d after the shared Chromium repair, with its source audit and original paired evidence retained.

Job 5 final fast gate: package and dependent CPU, lint, hygiene, banned terms, build, API and quality pass; format, loader, root, bricks, entries, restoration, demos and native WebGL2 GPU checks pass. The shared Chromium repair is included; shutdown completes. No verify or README command was run during this landing.

Batch 171 is DONE: all six features are built and landed as complete jobs. The build phase defers README work and speed measurement. Small quality follow-ups are recorded in the private finish-later handoff; model limits remain explicit.
