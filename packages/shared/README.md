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

## Owned Zstandard output

Run this example from the repository root. `destination` is optional: omitting
it preserves allocating decode. When supplied, its capacity is an additional
output limit and the result shares its storage. The decoder writes each output
byte directly there, verifies checksums and retains its normal cancellation,
frame, window and dictionary behavior. Defaults remain 256 MiB of output and a
128 MiB frame window.

```js
import { decompressZstd } from './packages/shared/zstd.js';
const frame = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x20, 5, 0x29, 0, 0, 77, 97, 114, 103, 111);
const destination = new Uint8Array(5);
const result = await decompressZstd(frame, { destination });
console.log(new TextDecoder().decode(result)); // Margo
```

The caller owns the destination exclusively until the promise settles. Do not
resize, transfer, detach or grow its Wasm memory during that borrow. Input and
output ranges may not overlap. A rejection leaves destination contents
unspecified; do not publish them as decoded data. A caller providing Wasm storage
must retain its allocation until completion and use checked ranges afterwards.

The regression in `packages/decoders/tests/zstd-destination.test.js` checks output
storage identity, allocation sizes, canaries, truncation, checksums, dictionaries,
limits, cancellation and detachment. It runs in verify and check:merge.
