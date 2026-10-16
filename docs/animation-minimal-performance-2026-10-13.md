# Minimal Animation arithmetic candidate: rejected

The private candidate precomputes `ai`/`bi` sample offsets, uses direct
interpolation comparisons and checks output finiteness with
`!out.every(Number.isFinite)`. It retains the original `Math.hypot(...out)`,
fresh public Float32 output, all validation/errors and the original Core
quaternion setter path. No production Animation or Core source was changed.

The focused exact suite completed with exit 0: four tests passed, zero failed,
cancelled or skipped. The minimal variant matches original Float32 bits and
errors across STEP/LINEAR/CUBICSPLINE, sample widths, quaternion paths and edge
times; actual Core transforms/Euler normalization, looping, morph state and
mutated-track outcomes match. Public buffers remain fresh. Typed output and
rotation-copy allocations remain unchanged.

The CPU-only actual `Animation.seek` benchmark used 5,000 frames per timed
window, four tracks per model, three clips and interleaved ABBA/BAAB order:

| Models | Original ms/model update | Candidate ms/model update | Speed ratio |
| --- | ---: | ---: | ---: |
| 1 | 0.01430008 | 0.00993488 | 1.43938x |
| 16 | 0.00831161 | 0.00806112 | 1.03107x |

The sixteen-model change is small in this single bounded run. Neither result
establishes GPU, sustained app FPS or startup improvement.

The actual write:false package build changes 13,376 to 13,378 raw bytes (+2),
and 4,838 to 4,845 gzip bytes (+7). **Rejected for production adoption:** the
candidate fails the no-byte-growth requirement despite exact parity and a
measured CPU improvement. Core/stage emitted hashes were captured by the
benchmark; Core/stage source and emitted output were not edited by this experiment.

Full executed outputs are saved in
`test-results/animation-minimal-exact-20261013.log` and
`test-results/animation-minimal-private-20261013.log`; timings, source hashes,
allocations and consumer bundle hashes are in
`test-results/animation-minimal-private-candidate.json`. The exclusive CPU slot
was released immediately after this one candidate completed. No second heavy
candidate or browser workload was started by this agent.
