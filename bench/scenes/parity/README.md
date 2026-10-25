# Parity scene implementations (Margo side)

`bench/scenes/parity.js` describes every scene of the three.js parity matrix once, as plain data. Margo's
implementation of each lives here, one module per area: `margo-<area>.js` exports `builders`, a map from scene id
to `async (canvas, data, marks, params) => app`. `../margo.js` loads the module only for the scene that runs. The
three.js implementations never live in this repository (clean room). They are in `engine-bench/margo-bench/parity/`,
next to the main checkout.

## Rules for every scene

- **The same job.** Build exactly what the scene's `draws` text and `data` say, with the engine's normal public API
  for the feature. One object per item when the data lists items, unless the scene says instanced or batched. Use
  the same counts, sizes, settings, resolution and camera path. Never lower quality, resolution or work to win. If
  the two engines cannot do the same job, say how they differ in `info().note`.
- **Frame scenes** return the harness app: `{render(t), idle(), info?(), samples}` (`app()` from `../margo.js`).
  Margo's defaults (4x MSAA, PBR Neutral display curve, the default light) are what an app gets.
- **Task scenes** (`kind: 'task'`) fetch bytes and build inputs in `create`, outside the timing. They return
  `{task(i), output(), idle?, info?}`. `task(i)` does the job once and may return a promise. `output()` returns counts
  that show both engines did the same job, such as `{meshes, vertices, triangles}`.
- **A feature Margo lacks** throws `new Error('unsupported: <what is missing>')` instead of building a substitute.
- Fill `marks.createMs` (engine creation; `engineFor` does it) and `marks.buildMs` (scene build).

## Checking a scene

```sh
node bench/cli.mjs parity --cases=p-unlit,p-lambert --engines=margo,three-webgpu-parity,three-webgl-parity --runs=1 --warmup=0 --frames=30 --no-gate --no-compare
node bench/parity-report.mjs --print
```

The first command takes the GPU lock itself. The second prints the verdict, the medians, the image match (SSIM and
mean delta E between the Margo and three.js screenshots) and task outputs for the newest run. Screenshots are in
`benchmarks/runs/<run id>/parity-<case>.png`.
