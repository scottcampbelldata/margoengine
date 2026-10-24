# Project instructions

## graphify

- When the user types `/graphify`, read and use `~/.Codex/skills/graphify/SKILL.md` before doing anything else.

## v1.0.0 core freeze

- Treat `@margoengine/core` and the stage facade as feature-frozen for v1.0.0. Do not add features to either, including material graphs, skinning math, or post-processing passes.
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
- Other engines are run only where they live (for benchmarks: `../engine-bench`). Margo's own benchmark scenes,
  harnesses and scripts are written clean room too.
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

## Before every push to main

Several agents push to `main`. Each push must leave it at least as clean as it found it:

- `npm run verify` passes. For changes to shaders, anything a demo draws, a package README or package exports, run `npm run check:merge` (adds the site build, the visual check and `modern:test:packages`, which packs every package,
  installs the tarballs into a clean project and type-checks each README example; about 11 minutes).
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
- Never delete or rewrite another chat's or Codex's branch or uncommitted work without Scott's say-so.
- This applies to Codex as well. Codex: rebase your own branches and worktree commits onto current `main` and land
  them the same way; a `codex/*` branch, a commit in a `~/.codex/worktrees` checkout or a `refs/codex/snapshots` entry
  that is not on `main` is unlanded work.
- Claude: when you find Codex work that is not on `main`, do not leave it behind. Either tell Scott in your report so
  he can have Codex rebase and land it, or, with his go-ahead, rebase it onto `main` yourself, run the checks and land
  it (keep Codex's authorship and say where it came from in the commit message). Report which one you did.
