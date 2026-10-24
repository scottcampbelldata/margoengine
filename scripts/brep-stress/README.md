# B-rep stress harness

Finds and records failures in `@margoengine/brep`: seeded primitives and Booleans, blends and profiles, bad input and
the CAD corpus. It only calls the package's public API and never changes kernel source. Case descriptions use
millimetres; the modeler is called in metres.

Build the packages first (`npm run build:packages`), then run each suite on its own:

```bash
node scripts/brep-stress/primitives.mjs --matrix=staged
node scripts/brep-stress/blends-profiles.mjs
node scripts/brep-stress/bad-input.mjs
node scripts/brep-stress/corpus.mjs --inventory
node scripts/brep-stress/corpus.mjs --generate
node scripts/brep-stress/corpus.mjs --run --campaign=centres
node scripts/brep-stress/corpus.mjs --run --campaign=operations
node scripts/brep-stress/summarize.mjs
```

`primitives.mjs` takes `--list`, `--suite=A,B,D`, `--offset`, `--limit`, `--match` and `--output`; its module exports
`cases({ matrix: 'full' })` for the larger matrix. `corpus.mjs` takes `--only`, `--offset`, `--limit`, `--workers`,
`--output` and a campaign. Corpus files come from `test-results/cad-corpus` (set `BREP_CORPUS` for another folder);
CAD files are never committed.

Each case runs in its own Node process with a 60-second limit. Results are appended as JSONL under
`test-results/brep-stress/<date>/` after every case, and a rerun skips IDs already recorded. A timeout covers the
whole case, not one kernel call. `BREP_STRESS_TRACE=1` prints the last check reached to stderr.

Every result body gets topology validation, `checkBody`, exact mass, finite-number checks, a STEP round trip, mesh
closure and mesh volume; empty Boolean results only get the mass and topology checks. The operation suites add closed
forms, volume partitions, rigid motion, operand swaps and repeat runs. Mesh volume comparisons need the requested
chord error to be reached: near the tessellator's default 50,000-vertex face cap, rerun with a higher cap before
calling a difference a kernel bug. The summary keeps those cap and blend-radius policy cases apart from confirmed
geometry failures.

## Optional OpenCascade check

OpenCascade is only an outside reference: it is never imported or bundled. `native-oracle.mjs` and
`blend-reference.mjs` send exported STEP files to a separate Python process that runs `BRepCheck_Analyzer` and GProp
volume integration. Install it in an ignored folder:

```bash
py -3.12 -m venv test-results/brep-occt-env
test-results/brep-occt-env/Scripts/python.exe -m pip install cadquery-ocp
node scripts/brep-stress/native-oracle.mjs --workers=3
node scripts/brep-stress/summarize.mjs
```

`BREP_STRESS_PYTHON` points at another interpreter with OCP. Exports are in metres; OpenCascade's millimetre volume is
divided by 1e9. Each Python call has 55 seconds inside the case's 60. Run the native check after the other suites, as
it only sees exports that exist when it starts.
