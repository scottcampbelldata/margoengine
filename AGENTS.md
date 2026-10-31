# Project instructions

## v1.0.0 core freeze

- Treat `@margoengine/core` and the stage facade as feature-frozen for v1.0.0. Do not add features to either, including material graphs, skinning math, or post-processing passes.
- Freeze = no new features; core bug fixes go in core (Scott, 2026-10-24). Fix a bug or unsafe API in core itself, with a test, within the size gate; never leave it because core is frozen. Details: `docs/conventions.md#core-freeze`.
- Core is the last resort (Scott, 2026-10-31): change `@margoengine/core` only when no package can hold the change AND it fixes a bug or flaw that will cause an engine failure. Looks, quality, options and features go in packages. A core change states in its commit why no package can hold it and which failure it prevents; ask the coordinator first.
- Exception (Scott, 2026-10-27): the stage facade was lifted from the freeze for ONE restructuring, a bug against "pay only for what you import": its optional-package methods moved out of the `Stage` class into feature entries (`@margoengine/stage/gltf` `addGLTF`, `/sky`, `/particles`, `/effects`, `/environment`, `/shadows`; the `./cad` entry was removed on Scott's go, 2026-10-29), so the stage root holds no `import()` of an optional package. Core stays untouched; the freeze applies again after this change.
- Exception (Scott, 2026-10-29, "do the core add i agree"): core gains ONE option, `EngineOptions.powerPreference` ('low-power' | 'high-performance'), passed to `requestAdapter` at creation and on device restore; unset keeps the old behaviour. The freeze applies again after this change.
- CI must automatically fail any pull request that pushes the combined core + stage gzip size to **25,000 bytes or above**. A measured result from 22,000 through 24,999 bytes is inside the allowed band.
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
- When you see a place where Margo is harder to use than the tools people come from, fix it or list it in HANDOFF.

## No CAD in this repository

Scott's decision (2026-10-29): CAD import and CAD tooling are not part of this repository and must not be added back. `npm run check:banned-terms` (in verify) enforces it; its encoded list is `scripts/banned-terms.json`.

## Before every push to main (Scott approved D1 to D7, 2026-10-31)

Agents never push. One integrator (`scripts/integrate.mjs`, run by the coordinator or a cheap runner) is the only pusher, one at a time. Until that script and `scripts/tier2-loop.mjs` exist, the coordinator pushes batches by hand with the tier 1 steps below.

- Tier 0, in the agent before it declares READY: `npm run lint`, `npm run hygiene`, `npm run verify` once (build, typecheck, `api:check`, quality, `proofs -- --current`, size gate, unit tests), and the GPU test of the package you changed. A change that alters exports commits the `npm run api:update` output. No `check:merge`, narrowed or full.
- READY: write `READY <sha>` in `private/queue/`. The branch is cut from current `main`, is local to its worktree, lives one task and at most one day, and is rebased by its agent when it is a day old or 30 commits behind. At most 6 unlanded branches exist at once.
- Tier 1, the integrator's gate on the batch tip, CPU only, once per batch (every 30 min, or as soon as 3 branches are READY): rebase each branch onto `main` in order (a conflict sends that branch back to its agent), then `npm run verify`, `npm run check:examples-types`, `modern:test:packages` narrowed to the batch's packages (`scripts/support/affected-packages.mjs`), and `node scripts/land-records.mjs --no-build` (one `records:` commit; the merge drivers from `node scripts/worktree-node-modules.mjs` keep generated records from conflicting; never edit them by hand). Then push and append the batch's commits and the tier 1 log to `private/queue/landed.log`. A failing test names a package, which names one branch: that branch leaves the batch, the gate runs again on the rest, and the branch goes back to its agent with the log. No rerun without a change.
- Tier 2, after the push, on the newest `main` tip, continuously (`scripts/tier2-loop.mjs`): `npm run check:merge:full`, uncached, in a detached worktree. It takes GPU slots first. Each pass tags `green/<sha>`; site deploys, releases and benchmarks use green tags only.
- RED: when tier 2 fails, `main` is RED. The integrator writes `private/queue/RED.json` (failed step, suite, commit range since the last green tag) and pushes only the fix. The culprit is found from the failed suite's file footprint (`scripts/support/affected-gpu.mjs`); rerun that one suite at the candidate and its parent, and bisect the range with that one suite only when no candidate shows. The fix is a regression test plus the fix, pushed ahead of the queue. Past 2 hours from RED, `git revert` the culprit (history kept) and re-enter the work as a new branch.
- Tier 3, nightly on the other machines: pinned proofs and benchmarks, exclusive, results to the status repo.
- Quality that every change keeps: new public exports carry TSDoc; new throws follow `docs/conventions.md` (`MargoError` with a code, `TypeError`, `RangeError`; the message names the fix); run `npx biome format --write` on files you touched; `npm run proofs -- --current` passes, and a deliberate change to what a feature-off path emits advances that proof's reference with the reason in `docs/whitepaper/claims.md`; public numbers in `site/index.html`, `README.md` and `docs/limits.md` match `npm run measure:size`; a launch-gate change updates `docs/HANDOFF.md`.
- GPU use: at most 3 GPU users at once including tier 2 (so 2 GPU builders while it runs), plus up to 3 CPU-only helpers; 6 agents in total. GPU tests share 3 slots, benchmarks take the GPU exclusively, every lock hold has a time limit.
- Stop orders: `private/control.json` lists stopped tags (`stopped`, `at`, `words`). Read it before each commit and before READY; if your tag is stopped, stop with a handoff. The integrator refuses a stopped class of paths.

## Working rules (from the retired session-rules file)

- Quiet: no progress messages. Run long commands in the background and message the coordinator only when something lands, you are blocked or you need a decision, in one short paragraph.
- Own files only: keep scripts and logs in your own worktree, never a shared scratch folder.
- Timeouts: every test, check, benchmark and wait has a hard time limit; never hold a lock without one. On a hang, kill the process tree, release the lock and report it.
- Nothing is skipped, loosened or retried until green. A failing step is yours to resolve whether or not your change caused it: find the root cause and fix it in the owning package with a regression test, unless the coordinator already assigned a fix helper to that exact failure.
- This ships publicly: any bug you find, related to your task or not, is tracked to its root cause and fixed in the owning package. If it cannot be fixed now, it goes in `docs/known-bugs.md` with a repro and cause, and you tell the coordinator.
- Every bug fix has a regression test. If the bug is hard (GPU or timing, concurrency, maths, unclear owner) and you are on a cheaper model, stop and tell the coordinator so a stronger model can take it.
- Never skip, weaken or shrink work to match another engine's speed. A speed fix does the same work with the same output. If a rival is faster because it does less, keep the work, publish the number as an accepted difference with its cause, what Margo does extra and the trade-off, and add a like-for-like row. Never change a benchmark scene so Margo does less; keep the old scene beside a new one.
- Being slower than three.js is acceptable only with a measured, documented reason (Margo does more or better work, or three.js cuts a corner we should not). A row with no valid reason is a loss to fix.
- Model and effort: every helper gets both chosen for the job. Chores (docs, renames, landings, running tests, searches): Haiku or Sonnet, low or medium. Normal feature work: Sonnet or Opus, medium. Hard work (GPU or timing bugs, architecture, tricky maths, risky changes): Opus high, max only when needed. State both in the brief and the handoff note. Switch a stuck job to a stronger model.
- Core is the last resort: add to `@margoengine/core` only when no package can hold the change and it fixes a bug or flaw that would make the engine fail. The commit and report say why no package can hold it and which failure it prevents; ask the coordinator first.
- Shared git config: every worktree shares one `.git/config`. Never write git config from a worktree, add worktrees with `--no-track`, avoid `git push -u` and `git branch -m` while checks run. If a check names `.git/config` in a failure, tell the coordinator; do not retry silently.
- Pictures over 3,932,160 bytes are re-encoded with a reduced palette when read by an agent, which shows false bands. Run `scripts/review-png.mjs` first (lossless rewrite), or compare numbers.

## How agents are run

Details in `docs/architecture/operational-playbook.md`.

- Coordinators run Opus 5.5 at high effort. Design-heavy or risky work gets a planner first (playbook 1.2).
- The to-do list sets what is built, in its order; work not on it is left alone (playbook 1.11). Demo work is stopped until the engine is done; never stop a running service without the maintainer's word.
- Builders never run `check:merge`. It runs once, at landing, in the mode it prints; landings are batched (playbook 2.6.5). Anything to be proven with a check is proven by a run that was happening anyway, and a check never runs twice on one code tree. At most three `check:merge` runs at once on the video card (about eight at once forced a reboot on 2026-10-30); pushes stay one at a time under the land lock. A stacked batch pushes after the batch below it lands without a new check only if `git diff` against its checked tip shows generated records alone.
- Quick checks before a branch is READY: quality, hygiene, the tests you touched, the root unit tests (`node --test tests/*.test.js`) and `npm run api:check`. A change that alters exports commits the `npm run api:update` output.
- Result reuse (session rule 25): a step whose recorded inputs are byte-identical to a first-try pass counts as passed on the pushed tree, and the report names the source run and commit. Failures, rerun passes, timing tests, benchmarks and pinned proofs are never reused. Reuse is recorded only until 3 landings and 2 nightlies agree, per step kind (playbook 2.10.4). The parallel check is under way, off by default.
- The to-do list stays short: one row per item, jobs in a working file.
- Coordinator handoff: about 500,000 tokens or the first auto-compaction. Remote Control cannot start a session, so the successor is started from the desktop app (playbook 1.6.5).
- Every worktree shares one `.git/config`: add worktrees with `--no-track` and never write git config from a worktree.

## One branch: main

Scott's rule (2026-10-21): main is the only branch that lasts. Many chats run at once, and branches left behind get
mixed up.

- Work in your chat's worktree, on its branch cut from current `main`. Never create extra branches (no test, backup,
  record or "land" branches); test in the worktree you have.
- Finish a task by declaring READY (see "Before every push to main"), not by pushing. The integrator rebases, gates,
  pushes and records the batch; after it lands, delete your branch and remove your worktree.
- If the work cannot be READY yet, rebase it onto current `main` anyway and say in your final report, in one line, what
  blocks it. Never leave a branch that is behind `main`.
- Never delete or rewrite another session's or agent's branch or uncommitted work without Scott's say-so.
- Every coding agent follows these rules. Work by another agent that is not on `main` is unlanded: report it, or,
  with Scott's go-ahead, rebase it onto `main`, run the checks and land it, keeping its authorship and saying where it
  came from in the commit message.
