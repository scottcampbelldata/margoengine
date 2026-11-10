# Matrix correctness preflight (batch 159, 2026-11-10)

The speed ledger remains historical until tonight's quiet run. Run this preflight on
the busy PC to exercise the same catalog cases and full input sizes once per engine:

```sh
npm run build:packages
node scripts/gpu-lock.mjs run --owner=parity-preflight --max=30 --wait-max=20 -- node scripts/parity-smoke-browser.mjs --runs=1
```

The external black-box adapters must already exist in the adjacent `engine-bench`
checkout. Override that location with `--engine-bench=<path>`. `--cases=p-background,p-orbit-controls`
selects exact case IDs; `--engines=margo` selects the local implementation alone.
The smoke runner executes one `task(0)` or one `render(0)` plus GPU idle. It never
runs the throughput, timestamp, serial-frame or repeated-task phases. It does not
enable `MARGO_SPEED_PHASE`, write a baseline, or enter `perf-vs-threejs.json`.
It rejects `--runs` other than 1 and refuses to run outside the GPU lock.

`test-results/bp-159-smoke.json` is updated after each engine/case with success,
explicit unsupported status, output counts, native API work counts, and errors.
Setup and the single operation are counted separately. These counts describe the
first operation, including deferred initialization, rather than steady-state work.
Native WebGPU and WebGL calls are counted without reading external shader text.
`writeBufferBytes` follows the specification's element-based typed-array ranges
and byte-based ArrayBuffer/DataView ranges. Counts do not prove pixel equivalence,
rival quality, or a speed improvement. Any error fails the run after the inventory
is saved; unsupported cases remain visible and require their own diagnosis.
The wrapping GPU runner kills the process tree at its hard limit.

Evidence: `tests/parity-smoke.test.js` proves a single complete task/frame, no
timing callback, exact upload ranges, unchanged arguments/values, and restoration
of wrapped methods. The initial browser check exercised `p-background` and
`p-orbit-controls` on Margo and both external backends, six successful calls.

Research: compared Kai Ninomiya, Brandon Jones and Jim Blandy (editors), W3C,
*WebGPU* (2026), command encoding, buffer mapping and queue writes,
https://www.w3.org/TR/2026/CRD-webgpu-20260915/, with the Khronos 3D Formats Working
Group, *glTF 2.0.1 Specification* (2021), buffers, accessors and GLB chunks,
https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html. Queue calls provide
deterministic work counts; complete glTF task output counts remain outside timing.
No external engine source or companion implementation was read or copied.
