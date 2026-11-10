# Render-pass composition (integration J2)

`scripts/generate-composition.mjs` builds sparse binary strength-2 arrays. A greedy
positive-pair construction is followed by a separate repair of 00, 01 and 10 states.
The independent tuple checker covers all four states, rather than only counting
co-occurrence. Maximum row width is five. Input order breaks ties deterministically.
This trades a few more rows for bounded resources and easier failure diagnosis.

The target is 24 members and 276 positive pairs. The plan's creative/toon family is
represented by creative post grading and the separate toon package. Sciviz is
excluded while it is building. The initial executable subset is post (FXAA), TAA,
DOF and Tonemap: six positive pairs. The full target array is tested on the CPU;
unimplemented target rows are not represented as GPU passes.

Generated `.html` and `.ts` files live in `tests/composition/`. Regenerate with
`node scripts/generate-composition.mjs`; the CPU test fails on stale output.
`npm run test:composition:browser` holds one shared GPU slot and runs one browser
per backend, with every row at 1x and 4x MSAA. Use `-- --packages=taa,dof` to select
rows containing those packages. `check:gpu-packages` registers it as a ROOT suite;
affected-GPU footprints include every generated page and the packages it imports.

Every row creates four distinct core material batches, with red, green, blue and
yellow front faces. Six pixels are read from the rendered canvas, including two
background probes. Half-intensity ambient lighting keeps colours below the
neutral curve's desaturation knee. Interior probes assert sRGB [188 or 0] within
one quantization level and opaque alpha; both background probes assert exact
opaque black. Core drawCalls must equal four. Validation scopes,
uncaptured errors, page errors and unhandled rejections must be empty. Pipelines
and queue completion determine readiness. There are no timing assertions; the
suite has the existing ten-minute process-tree deadline in check:gpu-packages.
Post effects join one ordered PostStack; TAA samples its depth. This is the
supported composition API, rather than competing standalone scene captures.

The runner writes `test-results/composition.json`, including backend, row id,
members, sample count, probes and drawCalls. Pair coverage is computed only from
selected rows after all backend/sample runs pass. J1 owns fixture shape and plugin
lifetime; this suite does not define or import its integration fixtures.

## Clean-room sources

- D. Richard Kuhn, Raghu N. Kacker and Yu Lei, *Practical Combinatorial Testing*,
  NIST SP 800-142, 2010, https://nvlpubs.nist.gov/nistpubs/legacy/sp/nistspecialpublication800-142.pdf.
  Defines t-way coverage and explains why independent coverage measurement matters.
- D. Richard Kuhn, Raghu N. Kacker and Yu Lei, *Combinatorial Testing*, 2013,
  https://tsapps.nist.gov/publication/get_pdf.cfm?pub_id=910001.
  Compares interaction coverage with exhaustive and random testing. Pairwise is a
  deliberate bound, not proof that higher-order failures cannot occur.
- GPU for the Web Working Group, edited by Kai Ninomiya, Brandon Jones and Jim
  Blandy, *WebGPU*, 2026, https://www.w3.org/TR/webgpu/.
  Error scopes and queue completion supply correctness evidence. Canvas readback
  is taken in the render task so the compatibility drawing buffer stays valid.

Compared full binary rows, exhaustive pairs and sparse greedy rows; chose sparse
rows with independent four-state repair. No external implementation was read.
