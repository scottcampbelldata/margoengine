# Batch 170 vfx work counts (2026-11-10)

`VFX` simulates its particles on the GPU in compute passes, so a steady frame sends the GPU one uniform block whatever
the particle count. Counted in Node on the traced GPU stand-in (`packages/vfx/test/frame-work.test.js`, a guard that
fails if per-frame uploads grow), with the `afterlight` test configuration: 100,000 particles live from the first frame.

| Work per steady frame, 100,000 live particles | Margo `VFX` | three.quarks 0.17.1 |
| --- | --- | --- |
| Bytes sent to the GPU | 224 B in 1 `writeBuffer` | 4,800,000 B of instance attributes marked for upload |
| GPU commands recorded | 24 | not counted (three.js renderer not run) |

No loss: nothing to fix. three.quarks simulates on the CPU and rewrites its billboard instance attributes each frame,
48 bytes per particle. Frame time is timing pending the quiet rerun; no speed ratio is claimed.

The rival ran as a black box outside this repository (`engine-bench/batch-170/quarks-rival.mjs`, three.quarks 0.17.1 on
three 0.186.1, public API only, Node without a renderer): it counts the bytes of every instance attribute whose
version changed in a frame, using its update ranges when set, over 60 frames after 3 warm-up frames.

Reproduce: `npm test --workspace @margoengine/vfx`; the rival with `node engine-bench/batch-170/quarks-rival.mjs 100000`
after `npm install three@0.186.1 three.quarks@0.17.1` in that folder.

Research: W3C *WebGPU* (Candidate Recommendation Draft, accessed 2026-11-10), https://www.w3.org/TR/webgpu/ ,
`GPUQueue.writeBuffer` and compute passes. No other implementation was read or copied.
