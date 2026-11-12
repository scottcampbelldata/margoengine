# MaterialX reference bakes (KB3108)

`*/source.mtlx`, `ramp.png` and `checker.png` are Margo's own test data (Apache-2.0, this repository's licence),
written by `packages/loaders/tests/oracle/materialx-bake.py`. Each `*/baked.mtlx` and its PNG are the output of the
MaterialX 1.39.5 texture baker (`baketextures.py` of the `MaterialX` package on PyPI, Academy Software Foundation,
Apache-2.0, https://github.com/AcademySoftwareFoundation/MaterialX) run on those documents by the same script, with only
the image path in `baked.mtlx` shortened to the bare file name. MaterialX was run as a black box; none of its source was
read or copied. Test data only, never shipped in a package tarball.
