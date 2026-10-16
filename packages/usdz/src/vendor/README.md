# USD parsers

`USDAParser.js` and `USDCParser.js` are copied from the Three.js 0.186.1
distribution at `examples/jsm/loaders/usd/`. Their only local changes are the
provenance headers. Both parsers operate on plain data and typed arrays and have
no imports or renderer dependencies.

The adjacent declarations describe the internal surface used by Margo's bounded
adapters in `../index.ts`. Keep those adapters outside the upstream files so
parser updates remain easy to compare. When updating, preserve the MIT license
in `../../THIRD-PARTY-NOTICES.txt` and run the USDZ fixture and browser tests.
