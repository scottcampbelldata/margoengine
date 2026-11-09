# Complete checked-step profile, finite-trim kernel

This bundle is a reproducible diagnostic record of Margo's own 2D kernel at pushed commit `fc88da4205dd62f7f4ea33cab624fc51e55cd108`. It contains its instrumentation patch, both new diagnostic Rust files, complete harness sources, method, original failures, raw measurements, summaries and source/artifact hashes. It needs no pre-existing ignored `.lane` files and does not change production source, docs or Git metadata.

`source-equivalence.json` checks all 51 original copied inputs against that commit's blobs, allowing only uniform LF/CRLF representation differences. `production-instrumentation.json` stores the exact original seven-file patch as a UTF-8 JSON string, with its original byte length and SHA256. JSON escaping preserves the patch's required blank context markers without trailing whitespace in repository lines. `decode-patch.mjs` verifies and decodes that original byte sequence. The two added Rust files are under `diagnostics/`. All physical floating operations, fixtures, settings, expected hashes and assertions remain unchanged. The archive's README is included in the equivalence check because the kernel uses `include_str!`.

To inspect the recorded run, start with `evidence/design.md`, `evidence/summary.md`, `evidence/summary.json` and `evidence/results-v2.json`. The original environment paths in these immutable records identify provenance; the relative paths below supply every diagnostic input needed for a fresh reproduction.

| Original role | Bundled path |
|---|---|
| Lossless review patch and decoder | `production-instrumentation.json`, `decode-patch.mjs`, `patch-encoding-validation.json` |
| Source/compiler/artifact metadata | `evidence/manifest.json`, `evidence/artifacts.json`, `source-equivalence.json` |
| Corrected complete raw run | `evidence/results-v2.json` |
| Original failed run | `evidence/results.json`, `evidence/logs/run.log`, `templates/run.mjs` |
| Corrected harness and directed representation regression | `templates/run-v2.mjs`, `u64-regression.mjs`, `evidence/harness-u64-regression.json` |
| Build/loop inspection and phase summaries | `templates/prepare.mjs`, `templates/inspect.mjs`, `templates/summarize.mjs` |
| Hard-deadline runner and orchestrator | `job-run.mjs`, `reproduce.mjs` |

To decode the review patch into a new owned output file:

```text
node <bundle>/decode-patch.mjs --out=<own-output>/production-instrumentation.patch
```

The decoder refuses to overwrite an existing file. Both `verify.mjs` and `reproduce.mjs` verify the encoded patch's exact original bytes before continuing. The marker-checked reproduction generator remains unchanged; decoding is unnecessary for staging or building.

Use a checkout or extracted archive of the exact commit with the repository's normal Node dependencies installed, including Playwright/Vite/Binaryen, and Rust's `wasm32-unknown-unknown` target. Node, Cargo and the repository's supported Edge/Firefox executables must be available. A source-only archive does not need a `.git` directory. The verifier requires the exact normalized source inputs and refuses existing output tags.

From any directory, stage source and run the directed u64 harness regression without building or timing:

```text
node <bundle>/reproduce.mjs --repo=<fc88-repository-root> --tag=complete-step-profile-review --stage-only
```

Build the matched release Wasm artifacts and inspect the retained calibration loops, with no profiling timing:

```text
node <bundle>/reproduce.mjs --repo=<fc88-repository-root> --tag=complete-step-profile-build
```

To run a bounded exclusive profiling session, use another unique tag:

```text
node <bundle>/reproduce.mjs --repo=<fc88-repository-root> --tag=complete-step-profile-run --profile --firefox=<supported-firefox-executable>
```

Outputs stay under `<repo>/.lane/p/<tag>`. Each build has a 600-second process-tree deadline; preparation/inspection/summary have 180 seconds. The complete profile has a 900-second process-tree deadline and uses the repository's exclusive GPU lease with a 6-second acquisition limit and 15-minute hold limit. On timeout the child process tree is killed. No phase, test or timing is retried automatically. The copied runner uses only its own output's TEMP/TMP/npm-cache folders. Omit `--firefox` only when the normal repository browser resolver already supplies the intended Firefox.

The recorded run passes the three explicit u64 pins and shipped checks on both modules, then compares two 100-step Node traces and 1,280 measured browser module-step visits against complete public body/contact/cache state and work fingerprints. Every measured visit returns 5,050 awake bodies. The 17 phases are non-overlapping; raw vectors preserve each real complete step. Phase shares use aggregate sums, and the selected minimum-step vector identifies its actual sample. Marginal phase minima are never added together.

The run occurred at **99.2917% aggregate host CPU busy**. Extra post-timer state/cache reads and instrumentation can alter cache/optimizer/layout behavior. These absolute profile times must stay separate from the original unchanged browser benchmark rows. The 39 imported clock calls are independently counted in Rust and the host. Clock-minus-empty-loop calibration is approximate because their checksum/black-box work differs; raw calibration values and outer-minus-phase residuals remain intact, with no exact overhead subtraction or layout-invariance claim.

The first attempt stopped before timed samples because Wasm's signed i64 BigInt representation was printed as signed hexadecimal. `BigInt.asUintN(64)` corrects the representation; directed assertions cover signed and unsigned forms of every pin. Frozen physics modules, expected bits, scenes and predicates did not change. Both the original failure and the corrected session remain in this bundle.

`bundle-manifest.json` lists the relative size/hash of every included file and records provenance to the original frozen bundle manifest `7e4140d3fb2d5113f68f806ae4a845168c481e1deb748c94746c2f34faacae9a`. Only the public patch representation and its checked decoding path changed; original raw measurements and historical evidence remain verbatim. Run `node <bundle>/verify.mjs` to verify the bundle without builds or timing. The portable staging smoke test was performed in a source-only extracted archive and compared its generated instrumentation against the frozen original, without a new profiling run.
