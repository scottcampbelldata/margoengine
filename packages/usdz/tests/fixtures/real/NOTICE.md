# Real USD test files

`usd-wg/` holds the composition scenes of the Alliance for OpenUSD working group's assets repository,
https://github.com/usd-wg/assets, commit 091bb5c6f8eb665ad4cf9d6c10025cecc07eda88, under the Apache License 2.0 (`usd-wg/LICENSE`).
Only `.usda` files of `test_assets/foundation/stage_composition`, `test_assets/_common` and `test_assets/References` are
copied, unchanged, except that `_common/teapot.usda` is left out for its size; nothing here references it.

`../openusd.json` is what OpenUSD 26.08 reads from these files and from `../fuzz` (`tests/oracle/truth.py`, run in Blender
5.3's Python). `../fuzz` scenes are random stand-ins made for this test; only their expected results come from OpenUSD.

`rigged/` holds RiggedSimple.usdz and RiggedFigure.usdz, unchanged, from `test_assets/USDZ` of the same commit: models donated by Cesium for glTF testing, under the Creative Commons Attribution 4.0 International licence as their READMEs there state. `../skel/openusd.json` is what OpenUSD 26.08 computes for them and for `../skel/cases.usda`, a stand-in written for this test.

`animated/` holds three files, unchanged, from `test_assets/USDZ` of the same commit: BoxAnimated.usdz (donated by Cesium for glTF testing, Creative Commons Attribution 4.0 International), AnimatedTriangle.usdz and InterpolationTest.usdz (public domain, CC0), as their READMEs there state. `../anim/openusd.json` is what OpenUSD 26.08 computes for them and for `../anim/cases.usda`, a stand-in written here (`tests/oracle/anim-truth.py`).

Pixar's Kitchen Set and the UsdSkel examples and Apple's Quick Look gallery are not free to redistribute: they are read
from a local download and never stored here. See `docs/whitepaper/reproduce.md`.
