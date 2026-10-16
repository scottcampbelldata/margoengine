# Retired gap-pass planning note

Retired on 16 October 2026 after the repository consolidation addressed or superseded its action items. The original note is retained in the recovery archive as `next-fixes-before-retirement.md` under `C:/Users/ScottCampbell/.codex/repo-backups/margoengine-20261016/`, alongside the source-history bundle.

Use the [consolidation record](repository-consolidation-2026-10-16.md) for the complete 74-package inventory, retained optional capabilities, source provenance and audit decisions. Final release verification is recorded separately; retiring this planning note does not assert that every release or browser gate has finished.

| Previous action | Disposition |
| --- | --- |
| Measure the stage bounds change | Current mesh-source integration handles retained PBR geometry without copying it into core Geometry. Core plus stage measures 20,282 bytes gzip under the 25,000-byte ceiling. The earlier symbol-only prescription is superseded. |
| Exclude optional React peers from its standalone measurement | The measurer reads the React peer manifest and externalizes those peers. React measures 20,966 bytes gzip; peer and application bytes remain additional. |
| Align README sizes and ceiling | Root/catalog READMEs and the benchmark guide now distinguish final measurements from historical captures and use the 25,000-byte gate. |
| Unify current install guidance | Current instructions use source or local tarballs until a verified registry release. The benchmark guide explicitly identifies its October 11 release checks as historical and links to the current source setup. |
| Update 1.0.0 core dependency pins | Current workspace manifests use 1.0-compatible core pins; none remain pinned exclusively to 0.1.0. |
| Retain packages and kernel coverage | All 74 public packages remain, including gizmo/usdz-export and the individual gameplay/rendering packages; kernel/shared remain support directories. Kernel tests and package scripts remain in the build workflow. |

The meta-package remains the batteries-included entry with its optional-domain dependencies. Import `@margoengine/core` for the smaller base; choose optional packages explicitly for application features.
