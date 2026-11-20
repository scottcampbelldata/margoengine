# glTF interactivity fixtures

`Tests_required_operations`, `start`, `interpolate`, `setDelay_and_cancelDelay` and `eventOnSelect` (`.glb` and the `.json` that
holds what each must produce), and seven graphs under `invalid/`, one from each validation group: files of the
KHR_interactivity conformance suite under CC-BY-4.0, read 2026-11-06 and unchanged. Their source and credit are in this
folder's row of `THIRD-PARTY-NOTICES.md`.

The whole suite is 55 MB, so it stays out of the repository. `packages/animation/tests/interactivity.test.js` runs all of it
when `MARGO_SPLAT_SAMPLES` names a folder holding the suite's `Tests/Interactivity` as `interactivity/`, and passes over it
when absent.
