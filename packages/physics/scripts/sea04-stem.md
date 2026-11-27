# SEA-04 independently measured stem and bow

The opt-in fixture drives the built `HullSolver` and `WakeSolver` through `PhysicsWorld` using the fixed-sinkage, fixed-trim University of Tokyo Wigley towing case. The 2.5 m hull has 0.25 m beam, 0.156 m draft and the parabolic offsets. The measured waterline coordinates use the article's aft-positive `2x/L`. The physical stem is `-1.000`. The nine contiguous bow readings run from `-1.000` to `-0.600`. The original printed Table I labels the ordinate `g ζ/U²`. [Kajitani et al., 1983, §1 and Table I, p. 22](https://archive.org/details/DTIC_ADP003037)

The reported 0.001 ordinate increment corresponds to 0.178 and 0.250 mm at Froude 0.267 and 0.316. The source does not give a separate measurement uncertainty for these wave-height outputs. The model uses 2.35 m depth and holds the published 3.5 m experimental channel width as metadata. Its finite 12 m × 4 m wake grid has an absorbing perimeter. Channel reflection and moving body boundary effects remain outside that grid. The dry closure is above the modeled wetted hull. The depth-source band ends 0.0005 m below the nominal draft so floating-point mass conversion into the rigid field does not make the mass-derived waterline fall outside the source. Neither this extra source coverage nor the numerical domain changes the experimental draft or gauge positions.

Each grid uses the same 48-by-24 mesh, tow protocol and two published speeds. Surface advance and four depth bands provide independent production source comparisons. Measure the exact nominal side positions after 1.5, 2 and 2.5 hull lengths and score at 2.5 lengths. The additional source control sets the strip spacing to one fine cell, so the source changes from 24 to 100 strips without changing the hull, grid, speed, gauges or target. The forecast never opens the observation file. The freeze records both grid packet hashes, the optional source-control hash, the plan and the observation transcription. Only scoring reads the sampled heights.

Run from the repository root using built Physics. If another task is rebuilding the shared package, copy its completed `packages/physics/dist` into ignored `test-results/sea04-stem/built` and set `SEA04_STEM_SNAPSHOT=1` for the prediction and source-control commands. This run pinned all 612 built files in an ignored SHA-256 receipt. The two grid packets must use identical built entry hashes.

```powershell
node scripts/run-with-timeout.mjs --max 4 -- node packages/physics/scripts/sea04-stem.mjs predict coarse
node scripts/run-with-timeout.mjs --max 4 -- node packages/physics/scripts/sea04-stem.mjs predict fine
node scripts/run-with-timeout.mjs --max 3 -- node packages/physics/scripts/sea04-stem.mjs source-control
node packages/physics/scripts/sea04-stem.mjs freeze
node packages/physics/scripts/sea04-stem.mjs score
```

The fixture independently checks the linearized no-through-flow condition on the real Wigley waterline sides. For the parametric side `z=b(x)`, the horizontal outer normal is proportional to `(-∂b/∂x, 0, 1)` on starboard. A body moving at speed `U` requires water velocity `u·n=U n_x`. The wake returns `u` from its projected potential, so the diagnostic directly measures the physical mismatch. It excludes the singular exact stem from the normal RMS and keeps the stem in the elevation score.

The present advancing variants prescribe a section-volume transfer. Their open-water potential operator leaves the hull interior in the fluid domain and does not enforce the wetted-side normal velocity. Depth weighting changes dispersion and source spread through the water column while leaving this geometric boundary condition absent. A source-radius gain or a depth-band change cannot replace it.

A bounded follow-on can use the existing finite potential graph in the frame of a rigid steady tow. Exclude the actual wetted hull, prescribe the perturbation normal flux `∂ₙφ=U n_x`, and close the exposed free surface with the translating kinematic and Bernoulli conditions `φ_y=-Uη_x` and `gη=Uφ_x` with outgoing radiation. Keep the local potential in the sampled surface trace. First verify impermeability and source balance on a manufactured body, then verify against the same frozen nine stations and report the remaining nonlinear run-up residual. [Noblesse, Huang and Yang, 2013](https://doi.org/10.1007/s10665-012-9568-7) · [Huang et al., numerical Neumann–Michell method](https://www.sciencedirect.com/science/article/pii/S0997754613000514)

## Frozen result

| Froude | Source | Measured stem | 50 mm stem | 25 mm stem | Fine bow profile RMS | Fine waterline normal RMS |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 0.267 | Surface advance | 43.843 mm | 12.626 mm | 16.424 mm | 19.890 mm | 0.294 m/s |
| 0.316 | Surface advance | 39.942 mm | 11.440 mm | 14.527 mm | 28.249 mm | 0.399 m/s |
| 0.267 | Depth bands | 43.843 mm | 8.819 mm | 9.522 mm | 27.073 mm | 0.123 m/s |
| 0.316 | Depth bands | 39.942 mm | 8.681 mm | 9.281 mm | 35.789 mm | 0.116 m/s |

Late-travel profile changes are at most 1.434 mm RMS between 2 and 2.5 hull lengths. The 50-to-25 mm changes across those stations are 5.146 and 7.188 mm RMS for the surface source, and 1.051 and 1.266 mm RMS for the bands. At Froude 0.267, reducing the fine source strip width to 25 mm yields 7.545 mm at the stem, an 8.618 mm RMS field change over the nine stations and 0.457 m/s normal mismatch. This sensitivity is unsuited to selecting a radius or strip count by the measured crest. Neither variant qualifies for measured acceptance. The completed score SHA-256 is `a3556082c2306ce770204b44803efee771cdd7eec09a4cb39628bfc91efd9ee3`.
