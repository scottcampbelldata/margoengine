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

## Before every push to main

Several agents push to `main`. Each push must leave it at least as clean as it found it:

- `npm run verify` passes. For changes to shaders or anything a demo draws, run `npm run check:merge` (adds the site build and the visual check).
- `npm run hygiene`: no gate gets worse for the packages you touched. New public exports carry TSDoc; new throws follow `docs/conventions.md` (`MargoError` with a code, `TypeError`, `RangeError`; the message names the fix). Run `npx biome format --write` on files you touched.
- `npm run proofs -- --current` passes. If a deliberate change alters what a feature-off path emits, advance that proof's current reference to your commit and say why in `docs/whitepaper/claims.md`; never leave a proof failing.
- Public numbers stay true: `site/index.html`, `README.md` and `docs/limits.md` must match `npm run measure:size`. When work affects a launch gate, update its status in `docs/HANDOFF.md`.
- `git pull --rebase` before pushing (no merge commits of `main` into itself), one commit per change, and no repeated record-only commits.
