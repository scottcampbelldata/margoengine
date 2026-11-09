# Optional package quality restoration

Scott's 2026-11-10 optional-package rule permits sensible ceiling growth instead
of reducing quality or complicating an API. Core and stage root are out of scope.
Measurements use `scripts/measure-size.js` bundleBytes, default gzip, bare imports
external, and `measureCoreStage` for the unchanged combined root.

## Labels duplicate attachment (audit finding 1)

Verified on c0e7053ee: the state failure was a TypeError saying `reuse/rename`.
Restore `shared/errors.js` fault, check the name before constructing the renderer,
and give the user both reuse and a complete alternate-name call. Root 5450 to
5550 B gzip; ceiling 5546 to 5806 B. Keeping this synchronous diagnostic in its
owner avoids a needless diagnostic entry or asynchronous attach contract.
Core plus stage remains 23924 B. No speed claim.

Research: Ecma International / TC39, *ECMAScript 2026 Language Specification*,
2026, [Error Objects](https://tc39.es/ecma262/2026/multipage/fundamental-objects.html#sec-error-objects),
permits user-defined Error classes. The existing Margo convention uses TypeError
for arguments and coded MargoError for state failures. W3C / WHATWG, *Web IDL*,
living standard, [Exceptions](https://webidl.spec.whatwg.org/#idl-exceptions),
also separates failure identity from its human-readable message. Use the existing
Margo error identity and retain actionable message detail; no foreign source read
or copied and no new error framework.

Regression: `packages/labels/tests/testpage-attach.test.js` fails on the shortened
TypeError, checks MargoError identity, code, link, name and full repair guidance,
and preserves the renderer and DOM for default and custom-name collisions.

## Shared codec diagnostics (audit findings 2 and 5)

Verified on 17e876ee3: inflate still collapsed distinct failures into three
messages, called caller size limits damage, and did not link errors. GLB did not
identify its failed header field or chunk constraint. Restore diagnostics in the
shared owners, including byte counts and policy-specific repair hints. Keep GLB
argument errors as TypeErrors and stream failures as coded MargoErrors. A valid
preset-dictionary zlib stream is unsupported, with recompression guidance.

The fixed Huffman distance alphabet now includes all 32 specified codewords so
reserved symbols 30 and 31 reach their explicit rejection, rather than appearing
undefined. No valid-stream work or output is reduced. Limits report at least the
bytes needed for the next write, not an uncomputed total decompressed size.
NIfTI/DICOM policy failures name maxSamples; paired image and Zarr metadata
failures name their actual metadata instead. No catch/rethrow masks a cause.

Research compared the container and compression specifications:

- Peter Deutsch and Jean-Loup Gailly, *ZLIB Compressed Data Format Specification
  version 3.3*, 1996, [RFC 1950](https://datatracker.ietf.org/doc/html/rfc1950),
  sections 2.2 and 2.3: method/window/header checks, dictionary support and Adler-32.
- Peter Deutsch, *DEFLATE Compressed Data Format Specification version 1.3*, 1996,
  [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951.html), sections 3.2.2 to 3.2.7:
  canonical codes, stored-block checks, reserved symbols and code-length repeats.
- Peter Deutsch, *GZIP file format specification version 4.3*, 1996,
  [RFC 1952](https://datatracker.ietf.org/doc/html/rfc1952), section 2.2: separate
  members, each with its own compressed stream. Later member limits are remaining
  byte allowances, which the sciviz README now explains.
- Khronos 3D Formats Working Group, *glTF 2.0 Specification*, 2017 (2.0.1 edition
  2021), [Binary glTF layout](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout):
  three header fields, chunk lengths, four-byte alignment, JSON/BIN order and
  unknown-chunk preservation.

These standards determine the existing checks and their diagnostic subjects; no
companion or other engine source was read or copied. No codec redesign, timing
claim or shader-text transformation. Detailed before/after sizes and ceilings are
in `docs/limits.md`. The additional strings remain in their synchronous owning
entries; a lazy diagnostic module would complicate every failure path.

Regression evidence: `tests/shared-inflate-diagnostics.test.js` exercises each
restored failure family; `tests/shared-inflate.test.js` retains 300 node:zlib
parity cases; `tests/shared-glb.test.js` covers fields, counts, ordering, bounds,
alignment and zero-copy unknown chunks. `packages/sciviz/tests/formats.test.js`
proves valid 600000-sample NIfTI/DICOM files fail with a policy error at a small
maxSamples and decode unchanged after it is raised; Zarr names metadata.

Consumer validation on the restoration build: lint and hygiene pass. Verify
completed all API, quality, size, proof, documentation and build steps; its one
unit failure was an old worker diagnostic expectation, corrected and rechecked
with all 17 worker/llms tests passing. Forty shared codec tests, fourteen sciviz
format tests and all six sciviz GPU suites pass. The eleven-package README run
has 155 passes and fourteen existing known failures; Blender's live example was
the sole fresh failure and now passes after its owner harness repair
(`docs/readme-live.md`). Only failed steps were rerun. All nine remaining real
GPU consumer suites pass: decoders, environment, gltf, gltf-pro extensions,
exporters, tiles, rigging, USDZ and Blender. USDZ required an explicit GPU-leaf
reason because its command name is unclassified; its pixel/shader checks ran
under one shared slot, not outside the lock. Remaining consumer requests use wait-max 60 and
no timing work. Detailed logs remain in this worktree's test-results/size-restore.

Rebase onto ba9248a85 preserved concurrent preview, teardown, decoder and scatter
work. The package build, entry/lazy measurements and API surface were regenerated
from the combined source. The limits table now compares current main's record
with this combined build and keeps standard headroom in all 38 raised ceilings;
historical figures above describe the original restoration build. Core plus
stage is still 23924 B. No codec implementation conflict or output change was
introduced by the rebase.
