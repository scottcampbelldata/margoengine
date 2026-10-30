# Project instructions

## v1.0.0 core freeze

- Treat `@margoengine/core` and the stage facade as feature-frozen for v1.0.0. Do not add features to either, including material graphs, skinning math, or post-processing passes.
- Freeze = no new features; core bug fixes go in core (Scott, 2026-10-24). Fix a bug or unsafe API in core itself, with a test, within the size gate; never leave it because core is frozen. Details: `docs/conventions.md#core-freeze`.
- Exception (Scott, 2026-10-27): the stage facade was lifted from the freeze for ONE restructuring, a bug against "pay only for what you import": its optional-package methods moved out of the `Stage` class into feature entries (`@margoengine/stage/gltf` `addGLTF`, `/sky`, `/particles`, `/effects`, `/environment`, `/shadows`; the `./cad` entry was removed on Scott's go, 2026-10-29), so the stage root holds no `import()` of an optional package. Core stays untouched; the freeze applies again after this change.
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

## Before every push to main

Several agents push to `main`. Each push must leave it at least as clean as it found it:

- `npm run verify` passes. For changes to shaders, anything a demo draws, a package README or package exports, run `npm run check:merge` (adds the site build, the visual check and `modern:test:packages`, which packs every package,
  installs the tarballs into a clean project and type-checks each README example; a few minutes for a one-package
  change).
- Check only what a change can affect (Scott, 2026-10-30, session rule 20): `check:merge` runs the GPU tests of the
  changed packages plus their dependents, not every package (their GPU tests, the visual demos and views that import
  them, the WGSL compile for their shaders). A package's own package.json counts as that package; a script runs only
  the checks that use it; a new standalone script no check imports runs none. Everything runs only for core, stage,
  shared code (and the margoengine umbrella), the check code itself, the root package.json or the lock file (also
  build configuration, a WGSL file outside a package, or more than 12 affected packages). An unplaceable file gets
  added to the map (`scripts/support/file-classes.mjs`; `tests/file-classes.test.js` fails on any tracked file it
  cannot place), not a full run. Never narrow by skipping a test the change can affect. A change to the GPU package
  runner runs its pinned `RUNNER_SMOKE` tests plus what it affects. `npm run check:merge:full` (or `MARGO_FULL=1`)
  forces the full run, and it prints which mode ran and why. The nightly full run (`node scripts/nightly-full.mjs`,
  not on the main dev PC; dated log in `test-results/nightly/`) is the backstop. A GPU step skipped as unaffected is
  not a failure; if you doubt the mapping, run `check:merge:full`.
- The two package-level steps are narrowed the same way (`scripts/support/affected-packages.mjs`). `verify` builds every
  package once, then runs its other checks side by side. `modern:test:packages` builds nothing again after `verify`
  (check:merge hands it that build), packs all packages in one `npm pack`, reuses the consumer project's third-party
  `node_modules` from `os.tmpdir()/margoengine-consumer-cache` (new key on a lock-file or dependency change, and weekly),
  and type-checks README examples in parallel shards: only for the affected packages (plus the umbrella's smoke test,
  always); the React docs, React unit tests and packed browser run when `react` is affected. `modern:test:bundlers`
  (no GPU, no GPU lock) runs only when a changed package is one the matrix builds or imports (react, shadows, controls,
  stage, core, the umbrella, the starters) or one they import. `check:merge:full` keeps all of it whole.
- `npm run hygiene`: no gate gets worse for the packages you touched. New public exports carry TSDoc; new throws follow `docs/conventions.md` (`MargoError` with a code, `TypeError`, `RangeError`; the message names the fix). Run `npx biome format --write` on files you touched.
- `npm run proofs -- --current` passes. If a deliberate change alters what a feature-off path emits, advance that proof's current reference to your commit and say why in `docs/whitepaper/claims.md`; never leave a proof failing.
- Public numbers stay true: `site/index.html`, `README.md` and `docs/limits.md` must match `npm run measure:size`. When work affects a launch gate, update its status in `docs/HANDOFF.md`.
- `git pull --rebase` before pushing (no merge commits of `main` into itself), one commit per change, and no repeated record-only commits.
- Generated records (`api/*.api.md`, `docs/api-surface.md`, `entry-sizes.json`, `basic-scene-network.json`, the quality
  baselines) no longer conflict on a rebase. `node scripts/worktree-node-modules.mjs` (main checkout:
  `node scripts/setup-merge-drivers.mjs`) registers two merge drivers once per clone: the generated files keep main's
  copy, the baselines merge item by item (limits only shrink, every reasoned history entry stays). Do not resolve them
  by hand. Inside the landing lock, right after the rebase and from a clean tree, run `node scripts/land-records.mjs`:
  it rebuilds, rewrites the API reports, shrinks the baselines (a baseline that would grow stops it, as
  `npm run quality -- --update` does), measures both size records at the rebased `HEAD`, checks that they name one
  commit and makes one `records:` commit. Then run `verify` and push. Commit nothing else by hand in those files.
  `build:site` and `test:basic-scene` take the GPU lock themselves, only around the browser; do not wrap them in it.
- GPU tests share 3 slots; benchmarks take the GPU exclusively; every lock hold has a time limit.

## One branch: main

Scott's rule (2026-10-21): main is the only branch that lasts. Many chats run at once, and branches left behind get
mixed up.

- Work in your chat's worktree, on its branch cut from current `main`. Never create extra branches (no test, backup,
  record or "land" branches); test in the worktree you have.
- Finish every task by landing it: `git pull --rebase` onto `origin/main`, run the checks above, push to `main` (after
  Scott's go-ahead), then delete your branch (local and on GitHub) and remove your worktree.
- If the work cannot land yet, rebase it onto current `main` anyway and say in your final report, in one line, what
  blocks it. Never leave a branch that is behind `main`.
- Never delete or rewrite another session's or agent's branch or uncommitted work without Scott's say-so.
- Every coding agent follows these rules. Work by another agent that is not on `main` is unlanded: report it, or,
  with Scott's go-ahead, rebase it onto `main`, run the checks and land it, keeping its authorship and saying where it
  came from in the commit message.
