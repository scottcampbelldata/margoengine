# Test fixtures

Fixtures are used only by the tests and are not part of the published package (`files` is `dist`).

- `tree.vox` is Margo-made: `scripts/make-vox-fixture.js` builds a small tree model and writes the minimal
  single-model layout (MAIN > SIZE, XYZI, RGBA, version 150) chunk by chunk from the public .vox description. It
  contains no third-party data.
