# USDZ serializer CRC optimization

The retained change replaces one conditional CRC32 bit step with its exact
branchless form in `packages/exporters/src/usdz.ts`. It improves the actual
USDZ serializer CPU workload without changing the ZIP archive, USDA text,
scene validation, Float32 number formatting, public API or output allocation.
Core and stage source were not changed by this fix.

| Isolated A/B run | Original export ms | Candidate export ms | Export ratio | Original CRC ms | Candidate CRC ms | CRC ratio |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial, 15 correctness checks | 39.2248 | 28.2846 | 1.3868x | 10.4494 | 4.9232 | 2.1225x |
| Independent ZIP proof, 18 checks | 33.6397 | 26.5024 | 1.2693x | 9.9003 | 4.6775 | 2.1166x |

Both runs used the actual checked-in knight and complete USDZ serializer with
interleaved A/B order. The independent run also wrote three original/candidate
archive pairs and checked them with Python `zipfile` and `zlib`: stored entries,
64-byte payload alignment, local/central/Python CRC agreement, UTF-8 content and
matching content hashes. Complete archive bytes and actual loader output match.
Focused existing USDZ tests passed 5/5 before and after the source adoption.

The write:false measured full optional bundles have no size growth:

| Optional bundle | Original raw bytes | Candidate raw bytes | Original gzip bytes | Candidate gzip bytes |
| --- | ---: | ---: | ---: | ---: |
| Exporters | 25,287 | 25,284 | 9,311 | 9,311 |
| USDZ-export with exporter bundled | 12,518 | 12,515 | 4,892 | 4,891 |

The full baseline and candidate bundle hashes are in
`test-results/usdz-crc-private-candidate.json`. That JSON is the independent
second run; the initial stdout is preserved in
`test-results/usdz-crc-run-20261013.log`, and independent stdout is preserved in
`test-results/usdz-crc-independent-20261013.log`.

The exact source substitution has been adopted and the targeted production
build completed with exit 0 on 2026-10-13 at 16:38:22 UTC. The existing Exporter
TypeScript/module build and USDZ-export Vite/declaration build both passed.
`scripts/build-verify-exporter-crc.js` read back the emitted branchless arithmetic
and invoked both actual built package entry points. Each returned a fresh
1,270-byte archive exactly equal to the Git `5fc55a0` baseline, with SHA-256
`d3a668586f35d0bea9b45b258351ae8ae13de40e638d291290a56f4fc5613514`.
Python independently verified each emitted archive's stored member, CRC and
64-byte alignment. Core and stage emitted entry hashes stayed unchanged.

Current emitted entries and declaration hashes are recorded in
`test-results/usdz-production-build-verification.json`; full executed output is
preserved in `test-results/usdz-production-build-verification-20261013.log`.
The current emitted USDZ module SHA-256 is
`49107807bc0ccc8745db8e3fc4d55d4b23cf9e62b6e1d3e979b01bae836da2b5`.
The source adoption, targeted type/build checks and actual local emitted-entry
read-back are now complete.

These are local CPU and exact-output results. The prior browser batch still has
its recorded strict startup/frame-tail failures. Browser app improvement and
production publication have not yet been established for this source fix.

The separate tuple-formatting and shared decimal-conversion variants remain
private candidates pending their own exact-quality, CPU and no-byte-growth
gates. Minimal Animation passed exact parity and improved its bounded CPU run,
but grew seven gzip bytes and was rejected for production adoption; details are
in [the minimal Animation evidence](animation-minimal-performance-2026-10-13.md).
