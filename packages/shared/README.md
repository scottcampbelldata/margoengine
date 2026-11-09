# Internal shared helpers

These source modules are bundled into their consuming optional entries, not
published as another package. Keep diagnostics readable and actionable; optional
ceilings may grow instead of reducing error detail.

`inflateZlib` and `inflateRaw` check each DEFLATE read, write and back-reference.
Corrupt streams throw linked `MargoError` code `failed`, naming the failing header,
Huffman rule, symbol, block, output size or checksum. Preset dictionaries are
unsupported and report code `unsupported` with recompression guidance.

Exact-size output mismatches report expected and observed/minimum required bytes.
Growable output uses `{ limit, limitHint? }`: exceeding `limit` is a policy failure,
not evidence of damage. The error reports the minimum required bytes, the byte
limit and `limitHint` (by default, raise `limit`). Callers should name their actual
option or metadata in that hint, as sciviz does for `maxSamples` and Zarr chunks.

From this directory, this complete empty-stream example runs in Node:

```js
import { inflateZlib } from './inflate.js';
const emptyZlib = Uint8Array.of(120, 156, 3, 0, 0, 0, 0, 1);
const output = inflateZlib(emptyZlib, { limit: 1024 });
console.assert(output.length === 0);
```

`glbChunks` returns zero-copy chunk views and preserves unknown chunk types. Its
linked TypeErrors name the GLB header field, byte counts, alignment, bounds or
JSON/BIN ordering that failed and ask for a complete glTF 2.0 GLB file. This is a
container check; consumers still validate JSON and asset versions.

Specifications and regression evidence: [size restoration](../../docs/size-restore.md).
