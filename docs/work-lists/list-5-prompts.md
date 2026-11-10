# Batch prompts for work list 5

Each section is the full prompt for one batch.

### Batch R6: AMD GPU bug hunt (part 1 of 1, 4 jobs)

```text
Read AGENTS.md and follow it. This machine has the project's only AMD GPU (Radeon 680M). Find the bugs NVIDIA never
shows.

JOBS:
1. [High] Run every package's GPU tests (npm run check:gpu-packages, or each package's GPU test through the gpu-lock
   runner, one slot, hard time limits) on WebGPU and on the WebGL2 compat backend. Record each failure in
   docs/work-lists/amd-gpu-hunt.md: package, test, backend, what was expected and what came out, first commit seen.
2. [High] Find the root cause of every failure that is not purely about time, and fix it in the owning package with a
   regression test that fails without the fix (one fix(scope) commit each). A cause below Margo (driver, ANGLE, Dawn)
   is proven with a recorded command stream and a second backend that is exact, then added to docs/known-bugs.md with
   the repro, like the ANGLE D3D11 entry. Never loosen a tolerance, skip a test or retry until green.
3. [Medium] A failure only about time goes to docs/work-lists/busy-retests.md with this machine's numbers; budgets
   never rise.
4. [Medium] Rerun the failed suites after the fixes land and mark each row of amd-gpu-hunt.md fixed (commit),
   known-bugs (entry) or time-only.
```

### Batch I1: packages work together, part 1 (part 1 of 1, 2 jobs)

```text
Read AGENTS.md and follow it. The full integration plan lives on the dev PC; its two jobs for this machine are
copied here. Goal: no pair or group of public packages that a reader can compose from the READMEs fails, leaks,
fights over state or renders wrong on either backend. Leave sciviz out until its batches are done.

JOBS:
1. [High] J1, fixture contract and plugin lifetime plus device loss. Define tests/fixtures/integration.mjs (in each
   package folder: how to create the package's object, attach it, drive one frame, assert, dispose) and write it for
   the plugin packages that use engine.use or scene.use (shadows, taa, oit, clustered, culling, lod, scatter,
   selection, sprites, splats, stats, inspector, quality, pixel, dof, cameras, cinematic, lighting2d, html, materials,
   animation, animator, staging, stage). One runner attaches every fixture, renders, loses and restores the device,
   disposes, and checks for leaks, GPU validation errors and unhandled rejections, on WebGPU and WebGL2. Show it
   catches three old fixed bugs by reverting each fix locally (never pushed). check:merge runs it for a changed plugin
   package.
2. [High] J5, packaging. A type project that imports every public entry of every package in one file (generated from
   the exports maps, run by check:examples-types); for each group of packages that share a contract, a bundle
   importing them in two orders must give the same results and byte-identical output; a bundle of core plus one
   package must not pull in another; core reachable by two paths plus the umbrella must share one Engine class. A
   check that would need a core change goes to Scott first. CPU only.

Every failure found: root-cause fix in the owning package with a regression test, or a docs/known-bugs.md entry with
a repro and cause. No timings anywhere.
```
