# Project instructions

## v1.0.0 core freeze

- Treat `@margoengine/core` and the stage facade as feature-frozen for v1.0.0. Do not add features to either, including material graphs, skinning math, or post-processing passes.
- Freeze = no new features; core bug fixes go in core (Scott, 2026-10-24). Fix a bug or unsafe API in core itself, with a test, within the size gate; never leave it because core is frozen. Details: `docs/conventions.md#core-freeze`.
- Core is the last resort (Scott, 2026-10-31): change `@margoengine/core` only when no package can hold the change AND it fixes a bug or flaw that will cause an engine failure. Looks, quality, options and features go in packages. A core change states in its commit why no package can hold it and which failure it prevents; ask Scott first.
- Zero-byte additions (Scott, 2026-11-10): a feature may go into core or the stage facade, freeze or not, when it adds 0 bytes to the core + stage root gzip (`npm run measure:size` unchanged), for example a lazy `import()` swap inside an existing feature entry. The commit states the measured before and after figures.
- Exception (Scott, 2026-10-27): the stage facade was lifted from the freeze for ONE restructuring, a bug against "pay only for what you import": its optional-package methods moved out of the `Stage` class into feature entries (`@margoengine/stage/gltf` `addGLTF`, `/sky`, `/particles`, `/effects`, `/environment`, `/shadows`; the `./cad` entry was removed on Scott's go, 2026-10-29), so the stage root holds no `import()` of an optional package. Core stays untouched; the freeze applies again after this change.
- Exception (Scott, 2026-10-29, "do the core add i agree"): core gains ONE option, `EngineOptions.powerPreference` ('low-power' | 'high-performance'), passed to `requestAdapter` at creation and on device restore; unset keeps the old behaviour. The freeze applies again after this change.
- The combined core + stage gzip size must stay below **25,000 bytes** (Scott, 2026-11-05). The build fails at 25,000 or above; `npm run measure:size` prints the figure. Anything below that is allowed.
- Exception (Scott, 2026-11-10, 'Yes, allow it'): core accepts an empty Geometry with zero vertices and zero indices. It uploads nothing, draws nothing and supports normal mesh updates/disposal; malformed partial inputs still reject. The freeze applies again after this change.
- Optional package sizes (Scott, 2026-11-10): an optional package entry may go over its recorded ceiling where that makes sense, rather than breaking code up unnecessarily or lowering quality. Raise the ceiling in the same commit, stating the measured size before and after, why the bytes are worth it and what a split would have cost. The core + stage limit above does not change.
- Build future capabilities strictly in separate, optional, tree-shakable packages:
  - `@margoengine/gltf-pro`: glTF 2.0 PBR.
  - `@margoengine/animation`: skeletal animation and morph targets.
  - `@margoengine/post`: SSAO and post-processing passes.

## Clean room: no files from other repos

Scott's rule (2026-10-24): Margo never uses files from other repositories, whatever their licence (MIT included).

- Write what Margo needs clean room, from public specs, papers and descriptions. Never copy, adapt or paste code or
  files from other engines or projects (three.js, Babylon, WAMR3D, WasmGPU, Blockbench, Crocotile, MagicaVoxel and
  the like), and never read their source while writing the matching Margo code.
- Other engines are run only where they live, in their own folder outside this repository (docs/benchmarking.md,
  "Comparing engines"). Margo's own benchmark scenes, harnesses and scripts are written clean room too.
- The one exception is large standard files that every engine uses, such as standard sample models, test assets and
  prebuilt decoders. Record each one's source and licence in `THIRD-PARTY-NOTICES.md`.

## Bugs: fix the cause, properly

Scott's rule (2026-10-24): as few bugs as possible at release, and every fix is a proper one.

- Find and fix the root cause in the package that owns it, core included (the freeze blocks features, not bug
  fixes). No band-aids: no try/catch that hides an error, no retry loops, no special cases for one input, no
  loosened tests or tolerances, no skipped tests, no "left as is" notes.
- Every fix ships with a regression test that fails without it. When a whole class of bug slipped through, add a
  check to `check:merge` that catches the class.
- A commit typed `fix` or `fix(scope)` must change a test file (under a `tests/`
  or `test/` folder, or `*.test.*`) or carry a body line `Regression: <repo path>` naming an existing test. No size
  or kind exemption: a commit that is not a bug fix is not typed `fix`.
- A bug you cannot fix now goes into `docs/known-bugs.md` with a repro and its cause. That list must be empty
  before release.

## Make it something people want to use

Scott's rule (2026-10-24): every API and tool should feel modern and familiar, so developers and artists want to use it.

- Modern JavaScript and TypeScript that developers expect:
  - ESM and full types;
  - `using` / `Symbol.dispose`;
  - `AbortSignal` on anything that loads or waits;
  - promises, not callbacks;
  - async iterators for streams;
  - coded errors with a help link;
  - no globals, no side effects on import.
- Familiar conventions from the tools people already know:
  - camera and mouse presets matching CAD and DCC apps (with the trademark notice);
  - glTF and real-world units by default;
  - common keyboard shortcuts;
  - names developers already search for.
- Good defaults: a working, good-looking result with zero configuration, and every option documented with its
  default.
- Every public feature ships with a short copy-paste example in its README that runs as written (the package test
  type-checks them).
- When you see a place where Margo is harder to use than the tools people come from, fix it or list it in `docs/known-bugs.md`.
- No partial packages (Scott, 2026-11-10): every package must at least match the best packages available today,
  combining the features of all of them, and be better where possible. The rivals are web 3D engines and web
  libraries (three.js and its ecosystem, Babylon.js, PlayCanvas, the best specialised web library); Godot, Unity,
  Unreal and Blender are export targets only, never the bar. A feature that only partly does what the best
  rival does is a gap to build, never a SKIPPED job; a skip needs the full match proven against the job text and the
  rivals. Physics stays on hold until Scott resumes it.

## No boundary-representation kernel or paid packages in this repository

Scott's decision (2026-11-06, replacing the 2026-10-29 no-CAD rule): CAD file import and CAD formats are fine here. Scott's boundary-representation kernel, and any package worth selling rather than open-sourcing, stay out and must not be added. `npm run check:banned-terms` (in verify) enforces the kernel's names; its encoded list is `scripts/banned-terms.json`.

## How work lands

Scott's rule (2026-11-05): no landing queue, no integrator, no hooks that block edits or commits. That setup cost a week of downtime and is gone. Do not rebuild it.

- Work in your chat's worktree, on a branch cut from current `main`. One worktree per chat, reused for every job in that chat: do not create a new worktree per job. Rebase onto `main` before each push.
- Before you push, run the fast gate (Scott, 2026-11-09: no full `npm run verify` per push; eleven lanes running it at once on one PC held the CPU at 94% and stretched it from 12 to 40 minutes): `npm run lint`, `npm run hygiene`, `npm run check:banned-terms`, `npm run build:packages`, `npm run api:check`, `npm run quality`, the tests of the packages you changed and of the packages that depend on them, their GPU tests on WebGPU and the WebGL2 compatibility layer if they have one, and `npm run check:readme-run -- --packages=<the packages you changed>` (Scott, 2026-11-07). A change that alters exports commits the `npm run api:update` output. A change to core, stage, shared code, the check machinery, the root package.json or the lock file still runs `npm run verify` once before its push.
- The full `npm run verify` runs after the push, once per newest `main`, in local CI on the dev PC (scheduled task "Margo CI (CPU)", result in `private/ci-status.json`). Nothing waits for it. A red run on `main` is fixed forward by the lane whose commit caused it within about 2 hours, with a regression test, or that commit is reverted. Nothing is released from a commit local CI has not passed.
- Agents push to `main` themselves once the checks above pass (Scott, 2026-11-05): rebase onto current `main`, fast-forward push, then keep your worktree for the next job (creating one takes minutes: dependencies and LFS). Remove a worktree only when its whole lane or task is finished. Never force-push.
- Never delete or rewrite another session's branch or uncommitted work without Scott's say-so.
- Never write git config from a worktree; add worktrees with `--no-track`.

## Documentation is part of the change

Scott's rule (2026-11-05): nothing lands undocumented. A change is not done until its docs are in the same push.

- The package README documents the feature with a copy-paste example that runs as written.
- `docs/architecture/operational-playbook.md` (the engine architecture and quality reference) is updated whenever a change touches the kernel, GPU maths, rendering backends, hardware tiers or the quality gates, including what evidence now exists or is still missing (section 5).
- `docs/whitepaper/` is updated for anything with a public claim: `claims.md` for each claim and its proof, `perf-history.md` and the `perf-vs-threejs` files for any measured speed result, losses and accepted differences included, with how to reproduce them in `reproduce.md`.
- `docs/limits.md` records every limit, size and accepted difference; `docs/known-bugs.md` records every open defect.
- Public numbers in `README.md`, `site/index.html` and `docs/limits.md` must match `npm run measure:size`.

## Working rules

- Build phase (Scott, 2026-11-10): speed work is deferred by `scripts/speed-phase.json`. No benchmarks, paired wall-clock A/B runs or timing assertions run in correctness gates; `npm run test:speed` lists its deferral. Keep every scene and budget in `docs/work-lists/speed-phase.md`. Deterministic work counts, clock/timeout correctness and local CI duration history (1.5x jump detection) stay enabled. Only Scott ends the build phase; the full named speed suite must pass on a quiet machine before release.
- CPU-heavy tight loops (Scott, 2026-11-09), including codecs, geometry builds such as convex decomposition and navmesh, and solvers, are built or rebuilt in Rust compiled to Wasm with SIMD where measurement shows the gain. Use one crate and one .wasm per feature, loaded lazily by its optional entry with `new URL(..., import.meta.url)`, never imported by core or stage and never in a shared Wasm bundle. Keep the public API TypeScript, the same output, a gain proven by a work count or paired A/B, and the entry size checked.
- Research first (Scott, 2026-11-07 and 2026-11-10): every improvement, fix, speed item and new feature starts with a wide search of research and scientific papers (Google Scholar, arXiv, ACM, IEEE, JCGT, SIGGRAPH, HPG, EGSR, theses, standards). Compare several and combine the best, then build from them clean room. Cite every source (title, authors, year, link) in the change's docs or clean-room record. A paper's companion code is another repository: read the paper, never the code. A review checks the citations and flags any improvement built without them.
- Quiet: no progress messages. Run long commands in the background and report only when something lands, you are blocked or you need a decision, in one short paragraph.
- Own files only: keep scripts and logs in your own worktree, never a shared scratch folder.
- Timeouts: every test, check, benchmark and wait has a hard time limit. On a hang, kill the process tree and report it.
- Nothing is skipped, loosened or retried until green. A failing step is resolved by finding the root cause and fixing it in the owning package with a regression test.
- Busy machines (Scott, 2026-11-07): every PC is busy with the batches, so a test that fails only on time (a timing assertion, a speed budget or a benchmark) while the machine is loaded is not a blocker. Record it in `docs/work-lists/busy-retests.md` (test, commit, machine, measured number against its budget, CPU load at the time) and move on; it is rerun on a quiet machine before release and the list must be empty then. The budget is never raised and the test is never skipped or edited. Any failure that is not purely about time (a wrong value, a crash, a hang past its hard limit) still stops the stream.
- Busy is never an excuse for a big or proven slowdown (Scott, 2026-11-07). A time failure is a real bug, fixed now with its root cause, when it misses its budget by more than 2 times, or when a side-by-side run against the parent commit (the same test, old and new taking turns in one session, compared by per-round minimums) shows the new commit slower beyond the round-to-round spread. Only a small miss with no regression against the parent goes on the retest list. Local CI also keeps every timed test's duration per `main` commit and flags a jump of 1.5 times or more between neighbouring commits run under similar load; a flagged jump is investigated as a bug.
- Never wait for a quiet machine, and never tune speed against wall-clock timings on a loaded one (Scott, 2026-11-07). Accuracy work, proven by its bars, comes first. A speed change is proven by a deterministic work count (contacts, rows, bytes, allocations) or a paired A/B run that interleaves old and new in one process and compares per-round minimums, with identical results either way. Spend about 30 minutes measuring one speed item; if the gain cannot be shown, land it only when it provably does less work with identical output, otherwise record it in `docs/work-lists/busy-retests.md` and move on. Published speed numbers come from the quiet rerun before release.
- This ships publicly: any bug you find, related to your task or not, is tracked to its root cause and fixed in the owning package. If it cannot be fixed now, it goes in `docs/known-bugs.md` with a repro and cause.
- Every bug fix has a regression test. If the bug is hard (GPU or timing, concurrency, maths, unclear owner) and you are on a cheaper model, stop and say so, so a stronger model can take it.
- Never skip, weaken or shrink work to match another engine's speed. A speed fix does the same work with the same output. If a rival is faster because it does less, keep the work, publish the number as an accepted difference with its cause, what Margo does extra and the trade-off, and add a like-for-like row. Never change a benchmark scene so Margo does less.
- Being slower than three.js is acceptable only with a measured, documented reason. A row with no valid reason is a loss to fix.
- Model and effort: choose both for the job. Chores: Haiku or Sonnet, low or medium. Normal feature work: Sonnet or Opus, medium. Hard work: Opus high. Switch a stuck job to a stronger model.
- Run at most 3 GPU jobs at once; benchmarks take the GPU alone.
- Pictures over 3,932,160 bytes are re-encoded with a reduced palette when read by an agent, which shows false bands. Run `scripts/review-png.mjs` first, or compare numbers.
- New features come from the missing-features list (kept outside the repository) or from Scott's request. Each is a new optional entry of a package, never core.
