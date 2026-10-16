# USD parsers

`USDAParser.js` and `USDCParser.js` are copied from the Three.js 0.186.1
distribution at `examples/jsm/loaders/usd/`. Their only local changes are the
provenance headers. Both parsers operate on plain data and typed arrays and have
no imports or renderer dependencies.

These files are retained as upstream reference material. The package runtime uses
`@margoengine/loaders`' bounded `readUSDA` tokenizer and `../crate.ts`'s native
Crate decoder. Neither vendored parser is imported or bundled. Keep the source
provenance headers and MIT attribution with these reference files.
