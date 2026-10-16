# Pinned live phone scene: particle isolation

Four fresh Chrome **155.0.8059.40** contexts completed one 10-second window each,
with the old pinned live entry, authored phone scene, 1432×768 canvas, engine DPR1,
1× sampling, exact fixed camera and solar time 18.016666666666666. Default GPU
profiling was off and no developer driver flags were enabled.

| Particle work | Real render/submit Hz | Median gap ms | p95 ms | p99 ms | Max ms | >25 ms | >33.333 ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| Full | 43.6972 | 24.4 | 28.7 | 32.4 | 35.2 | 148 | 2 |
| Compute only | 54.0826 | 17.0 | 25.6 | 27.9 | 67.8 | 52 | 2 |
| Draw only, initialized state frozen | 49.5573 | 17.5 | 26.5 | 28.8 | 69.9 | 122 | 2 |
| Both off, initialized state retained | 65.1069 | 16.5 | 18.4 | 25.0 | 31.7 | 6 | 0 |

All four kept the actual authored capacity and initialCount at 1M, rate 50000,
lifetime 25–45, size .01, GPU allocations and two old-live particle state
buffers. Each initialized normally before a stopped, outside-window indirect
read verified [6,1000000,0,0,0]. The draw-only and both-off conditions replaced
the entire runtime simulate method after that verification: skipping only the
dispatch would still clear indirect state and flip ping-pong buffers. Frozen
front/time/remainder and actual indirect count were verified unchanged at end.
No particles were made immortal or regenerated to create a favorable count.
Compute-only retained full million-slot simulation and suppressed its draw.

Each of 439 / 543 / 497 / 652 counted frames successfully returned from the
original Engine.render with exactly one successful native GPU submission.
Original app frame counts matched, full-capacity simulation uniforms/dispatches
matched where enabled, and all conditions retained the same camera/foreground.
Draw counters were 132 / 131 / 132 / 131 and dispatch counters 14 / 14 / 13 / 13.
There were zero timed query/buffer/pipeline/shader creation deltas, zero query
resources and no page/GPU errors.

Both particle simulation and drawing materially affect this laptop's workload.
The total is not safely predicted by adding isolated differences: scene load,
overlap, cached work and system state can change between fresh contexts. This
four-window sequence has no repeated full baseline to quantify drift. Frozen
draw-only positions also differ intentionally from moving particles. These
are application render/submission gaps, not physical presentation times, and
neither near-60 cadence nor the both-off result proves a strict 16.67 ms floor.
This old-live matrix does not measure the newer locally edited VFX implementation
or the user's current desktop phone-settings source trial.

All four device destroy counts were exactly one, with zero live tracked GPU
buffers/textures after retirement. The preview server closed and the runner
exited 0 without cleanup errors. Exact owned Chrome/runner native inventories
were absent; no residual owned Chrome children were found and no process was
terminated.

Raw evidence: ignored test-results/afterlight-live-particles-default-chrome-10s-particle-isolation-v1.json,
SHA256 `8759717f2335b3ddf15404ccf4b61657424ee437cb6e6d27e2ac10b944d82209`.
Its .harness directory and .evidence.json preserve the eleven actual executed
helper copies/hashes; adjacent stdout, process-start and terminal-cleanup files
retain the complete run/cleanup evidence. No production source/API/defaults
changed for this matrix.
