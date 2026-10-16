# Afterlight optional WGSL byte estimate — 2026-10-13

This is an isolated, unaccepted build candidate. No source, package distribution,
Core, Stage, site output or build configuration changed. Two Vite `write:false`
builds compare the current staged consumer with removal of WGSL comments and
line indentation in explicit optional packages. Identifiers, literals,
operators, statement order, shader concatenation boundaries and public strings
are preserved.

| JavaScript payload | Current | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Initial raw | 285,889 | 284,258 | −1,631 |
| Initial gzip | 94,478 | 93,700 | −778 |
| Complete raw | 306,191 | 304,560 | −1,631 |
| Complete gzip, sum of independently compressed chunks | 102,472 | 101,693 | −779 |

The deferred chunk has the same 20,302 raw bytes. Its hash-dependent import
filename changes compressed size by one byte. The candidate still exceeds the
saved live consumer's 99,299 gzip bytes by 2,394; it does not close the size gap.
It does preserve the dynamic detail boundary and its independent load-failure
behavior, unlike the rejected static-import estimate.

The published JavaScript is parsed with the workspace's existing
`rolldown/utils.parseSync` Oxc/ESTree parser. Only recognized WGSL literal values
in shader variable declarations/concatenations or shader-module code fields are
eligible. Interpolated templates and shader-hook argument strings remain
unchanged. Nested and line comments are handled separately from JavaScript.
Every edit checks identical WGSL token sequences, boundary whitespace,
JavaScript escape decoding/source offsets and literal round-trip decoding.
There are 166 checks of local string/regular-expression shader-hook match counts.
These local checks do not prove every cross-package hook or rendered image.

| Optional package | Edited literals | Embedded comments removed | Raw WGSL characters removed |
| --- | ---: | ---: | ---: |
| VFX | 2 | 1 | 157 |
| Water | 10 | 9 | 1,044 |
| Sky | 9 | 2 | 251 |
| Scatter | 4 | 1 | 156 |
| Post | 5 | 0 | 26 |
| Terrain | 2 | 0 | 74 |

Three interpolated shader templates are intentionally preserved. Shadows and
Creative are in the explicit candidate allowlist but have no eligible changed
literal in this consumer. Nearby TypeScript comments already disappear during
normal builds and contribute no runtime saving.

Candidate entry SHA-256:
`0997b9ead30269137d89c59048f5215481d7a2e0b14f4a00d57a813cebe7f628`.
Current entry SHA-256:
`4186741f7639c2eafe9a3bdafbbf67ae93d376b1e4e3466be05610794a068edf`.
Complete literal/token hashes and chunk inventories are in
`test-results/afterlight-optional-wgsl-byte-estimate.json`; the run log is
`test-results/afterlight-wgsl-rolldown-estimate.log`. The ignored local reproducer
is `node test-results/estimate-wgsl-comment-bytes.mjs --run`; reserve the CPU/build
slot. Core and Stage are excluded, so their 19,975-byte artifact is unchanged.

Two fixture failures remain part of the history. The first used TypeScript 7
compiler APIs that this installation does not expose and failed before a
candidate result. The first parser repair produced zero edits because its walker
missed object children; that result is preserved in
`afterlight-wgsl-empty-walker-result.json` and rejected. The repaired fixture now
requires a nonzero eligible edit count and completes both builds successfully.

GPU compilation, full shader-hook behavior, first-principal/final image equality,
startup and steady frame timing have not been tested for this candidate. It is
a potential build-byte saving, with no claimed GPU execution improvement.
