# DOF performance investigation — 2026-10-13

Status: **private candidate measured; not retained**. The existing
optional package and its usable authored demo remain unchanged. Core/Stage is
unchanged. Focal/near/mixed workloads and the actual authored demo improve, but
the fully-far workload regresses, blocking generic adoption.

## Traced workload and candidate

`packages/dof/src/index.ts` compiles `bokehShader` during setup, dispatches it
after the unchanged signed thin-lens CoC pass, and reuses owned targets/groups.
Its linear HDR source is `rgba16float`; CoC/depth pairs use `rg32float`; output
uses `rgba16float`. The public `maxRadius` range remains 1–32 pixels, with the
same 64 deterministic disk points, foreground spread, depth rejection,
disabled passthrough, alpha, resize/restoration and Tonemap/TAA integration.

The original loop computes `farPixel` and loads `farCoC` before evaluating the
existing `center.x > 0.5` predicate. When that predicate is false, neither value
contributes to far color/weight. The private candidate moves only those two
operations behind that exact predicate, removes the redundant inner conjunct
and leaves every contributing addition in its original iteration/order. It
preserves `disk(i)`, `max`, `round`, `clamp`, both far depth/radius conditions,
all near arithmetic, thresholds and final composition. CoC and presentation
shader strings are unchanged. Preparation verifies those source boundaries.

This source rewrite alone does not establish a redundant hardware load: GPU
compilers can sink or eliminate noncontributing work. The measured results below
are therefore reported by actual CoC coverage. Defined finite-input parity is
verified on the local GPU; invalid/NaN CoC is not a new API contract.

## Current inputs and source-only size estimates

| Artifact | Original raw / gzip | Candidate raw / gzip | Delta |
| --- | --- | --- | --- |
| Bokeh WGSL string | 2,066 / 937 bytes | 2,092 / 946 bytes | +26 raw / +9 gzip |
| Complete shader source, normalized LF | 3,175 / 1,293 bytes | 3,201 / 1,303 bytes | +26 raw / +10 gzip |
| Matched write:false package build | 16,604 / 5,058 bytes | 16,630 / 5,069 bytes | +26 raw / +11 gzip |
| Published-path normalized estimate | 16,585 / 5,050 bytes | 16,611 / 5,061 bytes | +26 raw / +11 gzip |

Source-only compression is **not** package or consuming-app size acceptance.
The matched package build executed with `write:false`. Its control differs from
the published entry only in two generated region-comment paths; normalizing
those paths reproduces the published entry exactly, including its SHA-256.
Both paths have the same +11 gzip candidate delta. The normalized candidate is
a postprocessing estimate; the original build report is preserved. Consuming
application bytes have not been measured for this candidate.

- Normalized source SHA-256: `4833b5532c8068c55f8af4860bc84f0e44444a5fde0e78ccd7360d666ec1834f`.
- Original bokeh SHA-256: `c52c3fcef33f3f634641cd1c8c053a01243a119d6ef4414389eca2948eb40ac1`.
- Candidate bokeh SHA-256: `0daf2b57ae2ae4ccb674729669f03a585e37eaf8455df2ad66820a46f2985d52`.
- Published entry SHA-256: `351843afe730e826cc550c4d0ea2249548a87ef344f27fe0b798e6fe6b982067`.

## Actual GPU proof

The private fixture uses two actual compute pipelines with their own automatic
layouts/bind groups. It checks every RGBA16F output channel bit for bit,
including alpha, before timing. Controlled 1,024 × 512 linear-HDR/CoC images
cover focal, near, far, mixed, exact/adjacent Float32 thresholds and disabled
conditions. HDR highlights and varied alpha exercise real bokeh accumulation.
The near/far depth rejection boundaries are represented in the threshold case.

A separate fresh headed native demo phase uses all 16 authored objects, the
actual package CoC stage, current lens controls and captured HDR/CoC inputs.
The fixture stops its RAF loop, checks that the packaged bokeh source matches
the original, and preserves its inputs. It records the complete principal-view
readiness, options and actual packed uniform values. It does not replace the
demo with synthetic rectangles or claim that its shader timing proves FPS.

Each case warms both pipelines, then encodes ten alternating original/candidate
pairs in **one measured command buffer**. Pass duration and a dependent
output-read span are recorded separately; fixed query/read resources and bind
groups are reused. The measured windows must allocate zero GPU buffers,
textures, bind groups or query sets. A separate histogram records actual CoC
coverage above/below the exact far predicate and checks finite inputs. All
validation/compilation errors and failures are retained. Contexts, devices and
servers must close before another hardware measurement starts.

The commands ran sequentially with the exclusive hardware slot:

```sh
node test-results/prepare-dof-bokeh-far-gate.mjs
node test-results/measure-dof-bokeh-far-gate.mjs
node test-results/dof-bokeh-far-gate.mjs synthetic
node test-results/dof-bokeh-far-gate.mjs demo
```

All six 1024×512 controlled cases passed every RGBA16F channel bit for bit:
524,288 pixels per case, zero nonfinite inputs/outputs, no shader/GPU/page errors
and zero timed buffer/texture/group/query allocations. The original 64-point
disk, accumulation order, near behavior, alpha and exact thresholds are retained.

| Case | Pixels excluded from far path | Original / guard median ms | Median paired saving ms | Wins / ties / losses |
| --- | ---: | ---: | ---: | --- |
| Focal | 524,288 | 1.8350 / 1.3107 | 0.5243 | 10 / 0 / 0 |
| Near | 524,288 | 2.2282 / 1.7695 | 0.4588 | 9 / 1 / 0 |
| Fully far | 0 | 2.7525 / 2.9491 | **−0.1966** | 3 / 0 / 7 |
| Mixed | 262,144 | 2.9491 / 2.4248 | 0.5243 | 7 / 0 / 3 |
| Thresholds | 393,216 | 2.6214 / 1.9005 | 0.3932 | 10 / 0 / 0 |
| Disabled | 0; shader bypasses bokeh | 0.0655 / 0.0655 | 0 | 1 / 8 / 1 |

These are pass durations; the separately timestamped dependent output-read span
is not silently included as shader execution. Timestamp steps are about
0.065536 ms. The ten-pair summaries retain the fixture's upper-middle order
statistic for even sample counts; raw samples and order are preserved. No single
saving applies to all scenes. The disabled controlled
input paints far CoC even though the actual disabled CoC stage would not; this
checks the existing bokeh bypass, not normal disabled CoC output.

The actual authored demo retained all 16 objects and its real CoC stage, lens
settings and packed uniforms. Its 1100×461 output compared all 507,100 RGBA16F
pixels exactly, with 273,630 far / 220,000 near / 13,470 focal-or-threshold pixels.
The guard excludes 46.04% of centers. Bokeh median duration is 3.3423 → 2.8836 ms;
the paired saving is 0.4588 ms with nine wins and one tie. The dependent span's
paired saving is 0.3932 ms with ten wins. This selective win does not cancel the
fully-far regression or prove whole-demo cadence. Principal submission was
1305.0 ms, GPU completion 1718.6 ms and presentation opportunity 1733.6 ms in
this functional test, missing one second. It is not a three-cold-load result.

Raw reports are `test-results/dof-bokeh-far-gate-{synthetic,demo,size}.json` and
`dof-bokeh-far-gate-size-path-attribution.json`. Hardware sessions 60007 and
22017 completed successfully and closed all owned resources/browser/server.
The fully-far regression justifies a narrow fresh confirmation before deciding
whether an outer-loop specialization is worth preparing. Retention requires
exact pixels, a useful paired win without material far-path regression,
package/consumer byte acceptance and whole-demo cadence/load checks. Physical
mobile remains separate; production source and distributions stay unchanged.

## Queued narrow far confirmation and outer-loop alternative

No new GPU/build run has occurred since the measurements above. The prepared
confirmation writes both timed pipelines to the **same output allocation**,
eliminating dedicated-target placement as a possible comparison confound.
Separate full RGBA16F output equality still precedes each of three ten-pair
fully-far batches; each batch uses one command buffer and pooled resources.
The original reports remain untouched. Pass time and dependent output-read span
remain separate.

If that confirmation repeats the far regression, a private alternative puts
the existing center predicate outside the loop. Its far branch contains the
original complete loop byte-for-byte; the other branch uses the exact original
disk and near-tail bytes. Each invocation still visits all 64 disk positions
once, preserving every contributing addition, order, threshold and final alpha.
Duplicating that code adds 550 raw / 20 gzip bytes to the shader string; no
package/consumer compression or speed benefit is assumed. The candidate remains
private pending measured far/mixed/demo proof and size recovery.

Priority after an explicit hardware grant:

```sh
node test-results/dof-bokeh-far-confirm.mjs gate far-confirm
# Only if the far regression repeats and the owner grants the next step:
node test-results/dof-bokeh-far-confirm.mjs outer-loop far-confirm
# Only after far evidence justifies broader parity/timing:
node test-results/dof-bokeh-far-confirm.mjs outer-loop all
```

The fallback also needs the actual authored-demo input check and matched
`write:false` optional/consumer byte builds before retention. Preparation and
syntax checks pass. Scope/source hashes are retained in
`test-results/dof-bokeh-far-confirm-preparation.json`; no new result is claimed.
