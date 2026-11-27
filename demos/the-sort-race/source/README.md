# The Sort Race

Queue entry 69. **Run the sort** gives a seeded permutation of every unsigned integer from 0 through 999,999 to two sort implementations and displays their measured elapsed times. Run again changes the input order while preserving the values and verification criterion.

## Computation and clocks

- A dedicated worker creates the million 32-bit keys and transfers an identical copy to the Margo lane. The 20-bit mapping uses only bijective operations, followed by cycle walking back into the one-million-key range. Both result arrays are checked at every index, so missing, duplicated or out-of-order values fail verification.
- The CPU clock brackets the browser's numeric `Uint32Array.prototype.sort()` in the worker. Array generation, messaging and verification are outside that clock.
- Margo `compute.sort(input, {bits:20})` uses the key width for this data. An upload fence, sort completion fence and full readback are measured separately. The sort clock includes submission, completion and any first-use pipeline setup. The two measured sorts run in sequence even when the device is warming up.
- The worker forms populated bins of 1,000 values from the verified Margo output. Margo `compute.scan()` produces all 1,000 inclusive cumulative ranks. The app checks every rank and displays the four quarter boundaries.
- The plots use 2,048 evenly spaced input indices and the corresponding sampled output indices. Once the result is verified, the sampled input keys move horizontally to their verified ranks. This reveal follows computation and uses the same coordinates on desktop and phone. Reduced-motion preference displays the final result immediately.
- The WebGPU lane uses native WebGPU when available. The pinned Margo WebGL2 compatibility layer sorts using its CPU-routed radix kernel and exposes a CPU-tier dispatch count. The page labels that mode and identifies both timings as CPU-backed. If there is no compatible device, the JavaScript lane still runs and verifies. The same page and charts serve all modes.

## References

- [Margo Engine compute documentation, verified public revision 0efd9cff8230507a32deb49907ecd499d46925f5](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/compute/README.md). The demo calls the public sort, scan and completion APIs and uses the documented compatibility behavior.
- [ECMA-262, TypedArray.prototype.sort](https://tc39.es/ecma262/#sec-%typedarray%.prototype.sort). Numeric typed-array ordering for the CPU baseline.
- [Nadathur Satish, Mark Harris and Michael Garland. Designing Efficient Sorting Algorithms for Manycore GPUs. IPDPS, 2009.](https://mgarland.org/files/papers/gpusort-ipdps09.pdf) Radix sorting and parallel scan background.
- [Andy Adinets and Duane Merrill. Onesweep: A Faster Least Significant Digit Radix Sort for GPUs. 2022.](https://arxiv.org/abs/2206.01784) GPU radix and memory traffic context.
- [John Black and Phillip Rogaway. Ciphers with Arbitrary Finite Domains. 2002.](https://web.cs.ucdavis.edu/~rogaway/papers/subset.htm) Cycle walking as a way to restrict a permutation to a smaller domain. The demo's data generator is a reproducible shuffle.

## Local review

Build from the showcase root with the gallery's pinned checkout. The isolated harness `qa-output/the-sort-race/check.mjs` builds this source using the gallery resolver and runs native WebGPU, automatic compatibility and forced compatibility browser cases. Set `SORT_REPEAT=1` for a second desktop run on both paths. The mobile case uses trusted touch at 390 CSS pixels and DPR 2 with a cold cache, 150 ms latency, 1.6 Mbps download and 4× CPU throttling. It checks the physical tap, complete million-key input generation, verified outputs, cumulative ranks, compatibility dispatch tier and chart labels. The same harness accepts `SORT_RACE_URL` for hosted testing.
