# Project instructions

## graphify

- When the user types `/graphify`, read and use `~/.Codex/skills/graphify/SKILL.md` before doing anything else.

## v1.0.0 core freeze

- Treat `@margoengine/core` and the stage facade as feature-frozen for v1.0.0. Do not add features to either, including material graphs, skinning math, or post-processing passes.
- CI must automatically fail any pull request that pushes the combined core + stage gzip size to **20,000 bytes or above**.
- Build future capabilities strictly in separate, optional, tree-shakable packages:
  - `@margoengine/gltf-pro`: glTF 2.0 PBR.
  - `@margoengine/animation`: skeletal animation and morph targets.
  - `@margoengine/post`: SSAO and post-processing passes.
