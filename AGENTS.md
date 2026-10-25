# Project instructions

## v1.0.0 core freeze

- Treat `@margoengine/core` and the stage facade as feature-frozen for v1.0.0. Do not add features to either, including material graphs, skinning math, or post-processing passes.
- Freeze = no new features; core bug fixes go in core (Scott, 2026-10-24). Fix a bug or unsafe API in core itself, with a test, within the size gate; never leave it because core is frozen. Details: `docs/conventions.md#core-freeze`.
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

## brep is private

Scott's decision (2026-10-25): `@margoengine/brep` is a private, future paid product. It no longer lives in this
repo: it moved, with its history, to the private repo `scottcampbelldata/margo-cad-kernel`. Public docs, the site, the
whitepaper, the catalog and package READMEs present CAD as built on OpenCascade (STEP and IGES through
`occt-import-js` in machinery's worker). Do not advertise or reintroduce brep, its formats, exact Booleans or other
brep-only features here, and never claim a CAD kernel on par with OpenCascade. Machinery's generic `importer` option
(`loadCAD`, `parseCADAsync`) is the only plug-in point; it never names the kernel.

## Before every push to main

Several agents push to `main`. Each push must leave it at least as clean as it found it:

- `npm run verify` passes. For changes to shaders, anything a demo draws, a package README or package exports, run `npm run check:merge` (adds the site build, the visual check and `modern:test:packages`, which packs every package,
  installs the tarballs into a clean project and type-checks each README example; about 11 minutes).
- `check:merge` runs only the GPU work the change affects: the packages you changed plus everything that depends on
  them (their GPU tests, the visual demos and views that import them, the WGSL compile for their shaders). Core, stage,
  shared, the margoengine umbrella, build and check scripts, package.json or lock files, a file it cannot classify, or
  more than 12 affected packages run everything. `npm run check:merge:full` (or `MARGO_FULL=1`) forces the full run,
  and it prints which mode ran and why. A nightly job runs the full one: `node scripts/nightly-full.mjs` (dated log in
  `test-results/nightly/`). A GPU step skipped as unaffected is not a failure; if you doubt the mapping, run
  `check:merge:full`.
- `npm run hygiene`: no gate gets worse for the packages you touched. New public exports carry TSDoc; new throws follow `docs/conventions.md` (`MargoError` with a code, `TypeError`, `RangeError`; the message names the fix). Run `npx biome format --write` on files you touched.
- `npm run proofs -- --current` passes. If a deliberate change alters what a feature-off path emits, advance that proof's current reference to your commit and say why in `docs/whitepaper/claims.md`; never leave a proof failing.
- Public numbers stay true: `site/index.html`, `README.md` and `docs/limits.md` must match `npm run measure:size`. When work affects a launch gate, update its status in `docs/HANDOFF.md`.
- `git pull --rebase` before pushing (no merge commits of `main` into itself), one commit per change, and no repeated record-only commits.

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
