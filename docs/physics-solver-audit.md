# Physics solver audit

Each landed physics solver is judged against its catalog row in [physics-solvers.md](physics-solvers.md), the floor in
[physics-work-queue.md](physics-work-queue.md#what-every-solver-must-do) ("What every solver must do") and the
eight-point standard in the same file, "The standard: the best solver we can build". A solver that falls short is
REOPENED in the work queue, with its owner unchanged, and the missing pieces named here are its work list.

Since 2026-11-26 the finish line is [physics-parity-bar.md](physics-parity-bar.md) (Scott: parity with Babylon.js and
three.js, "not exceeds but must meet"). The upgrade lists below are required only where that file's row asks for
them; the rest is a record of what a stronger solver would need.

## Method

- **What was read.** For each solver: its catalog row (the phenomenon and model column and the cited methods, not the
  builder's own state column), its source and Rust kernel, its unit and coupling tests, its README section and its
  entries in `docs/clean-room.md`, `docs/limits.md` and `docs/known-bugs.md`. The audit is a static reading of the
  code as landed on `main`; no test was re-run for it, because passing is already gated before landing.
- **Validation.** Counted only where a test asserts against a published measurement, a published table or an exact
  (analytic or exact discrete) solution, with the source cited. A test that checks a scheme against its own formula,
  "it runs", a trend, or determinism is recorded but is not validation. The table names the test, the reference and
  whether its bound is derived or arbitrary.
- **Coverage.** Every capability named in the catalog row's model column is marked built and tested, or missing. A
  method much simpler than the cited sources is a gap even where something runs.
- **Red flags.** Uncited non-physical constants, fitted constants presented as physics, arbitrary or loose bounds,
  energy or mass gain, unit or frame errors, hard caps, and docs that claim more than the code does, with file and
  line.
- **Fairness.** Line count is not the measure. A short solver whose model is genuinely small is not marked down for
  being short; the two 66-line Rust kernels (airborne particles and room sound) are each the right size for the
  integrator they hold, and their solvers are judged on what surrounds them.
- **The eight points** (column "Fails"): 1 strongest model with a validated fast and high-fidelity tier; 2 validated
  against the real world across regimes; 3 broader than any rival; 4 fully two-way coupled with a test per neighbour;
  5 robust at the extremes, with coded errors; 6 scales (Rust and Wasm SIMD, threads, cells, work counts); 7
  directable for film; 8 honest limits.
- **Verdicts.** SOUND: meets all eight points. THIN: real physics, but named pieces, validation or standard points
  are missing. STAND-IN: does not do what the row says (scripted, kinematic or fake).
- **Upgrade to best.** The stronger model and its paper, the validation cases still owed (named experiments,
  datasets or closed forms) and the capabilities a named rival has. Citations here are starting points for the
  owner's research-first pass, which verifies each against the paper before building.

## Findings that apply to most solvers

- **No solver meets the eight-point standard yet.** None is SOUND; none is a STAND-IN.
- **Validation is analytic, not measured.** Most solvers check closed forms or their own discretisation well, with
  derived bounds. Almost none compares an emergent result with a published experiment or field dataset (point 2).
- **One tier.** No solver ships a validated fast tier and high-fidelity tier behind one option (point 1).
- **Coupling tests often use stand-ins.** Many neighbours the catalog names are not wired two-way, or are exercised
  only through stand-in producers (point 4).
- **Plain errors.** Out-of-range input is refused with a message that names the fix, but mostly as a plain
  `RangeError` without a code (point 5).
- **No threads or work counts.** Rust and Wasm SIMD kernels are common; threading, floating origin and recorded work
  counts are rare (point 6).

### SEA-11 four-point pass

- Point 5 (debcbf19fd). `packages/physics/tests/coupling/seakeeping-accepted.test.js` refuses an open
  mesh, invalid density and oversized dimensions with fixes. A native table must match the hull mesh,
  sea density and station count, and its inputs are copied. The tapered deck test checks the receiving
  cell of real interior inlets and verifies the accepted deck surface across restore. The ordinary
  hull rollback regressions protect the added surface and slam histories.
- Point 6 (debcbf19fd). `packages/physics/tests/coupling/hull-slamming-workers.test.js` compares scalar
  and native 1/2/4 ordinary and sheer-hull tables and live signed-origin replay. The 57-station sheer
  case has zero breadth on the hull-wide top cut and retains its lower profiles. Packaged Chromium
  in `packages/physics/tests/hull-slamming-workers.browser.mjs` joins three real helpers, cancels a
  second group, and evaluates 25 stations, 1,200 depths, 37,500 bisections and 600,400 f64x2 midpoint
  pairs. The same flat-wedge table takes 2,093,050 native bracket comparisons versus 20,377,650
  in the preceding scalar traversal.
- Point 7 (debcbf19fd). `packages/water/test/wave-impact-film.browser.mjs` isolates slamming from a
  matched feature-off launch in a 0.72 m wave. The upward load and vertical speed differ by 69.7 kN
  and 0.929 m/s. Accepted green water advances 1.04 m, grows from 5.6 to 101.3 L and then drains.
  WebGPU and WebGL2 replay the full same-backend frames and accepted state, hash c072ae9973f4021f.
- Point 8 (debcbf19fd). `docs/limits.md` records the vertical Wagner strip assumptions, the native bake
  boundary and the shallow-water deck grid. `packages/physics/tests/seakeeping.test.js` checks the
  wedge width and slope and the Ritter deck reference. The original film cuts, local panel pressures,
  oblique flare slams, breaking spray, structural whipping and deck structure loads remain open.
- Point 2 stays open. `packages/physics/scripts/sea11-wedge-measured.mjs` compares 12 measured Tveitnes
  wedge loads without fitting. One falls within the repeatability, plot and phase envelope. For the
  early 15°, 30° and 45° samples, the model predicts 1,106, 542 and 519 N versus 648, 341 and 166 N.
  At later samples it underpredicts all three angles. Raising the rate from 240 to 960 Hz changes
  sampled loads by at most 0.040 N. The paper reports motor speed and the viscous and elastic rig
  limitations without measuring the entry speed of the impact face.

### SEA-08 four-point pass

- Point 5 (5b8388a0c0). `packages/physics/tests/coupling/seakeeping-accepted.test.js` rejects invalid
  pressure and Float32 load overflow on the second hull and checks every accepted region and port.
  Corrected input matches a clean run, including the first hull’s diffraction and motion histories.
  The signed separate-rigid-cell check preserves loads and wake words across snapshot restore. Invalid
  mesh/solver settings and the parallel bake’s extreme outputs fail with coded fixes.
- Point 6 (5b8388a0c0). `packages/physics/tests/coupling/hull-panel-workers.test.js` compares native
  1/2/4 tables and live signed snapshot replay. `packages/physics/tests/hull-panel-workers.browser.mjs`
  joins three real Chromium helpers, checks abort cleanup, and visits nine independent matrix systems
  with 73,032 paired f64x2 complex updates and 6,528 scalar tails. Raw prior and current Wasm coefficients
  matched for 10,752 bytes. Workers run in the optional bake. The live hull reads the resulting table.
- Point 7 (5b8388a0c0). `packages/water/test/seakeeping-film.browser.mjs` draws the procedural 16.8 m
  hull in an oblique sea. It samples 0.744 m heave peak-to-peak across two phases and 6.70° roll at 3 s
  against 0.022° in the calm control. Disabling the live hull wake changes 2,790 pixels. Both renderers
  replay the complete accepted world and full frames byte for byte within backend (state b60e50491a6f66c0).
- Point 8 (5b8388a0c0). `docs/limits.md#ship-seakeeping-evidence-and-limits-sea-08` distinguishes the
  default deep-water strip solution from the optional reference-geometry finite-depth panel response.
  `packages/physics/tests/coupling/hull-panels.test.js` checks the sphere and finite-depth references.
  The reference draft, Lewis edge, roll-pivot bounds and original lake film cuts remain open for broader proof.
- The corrected measured fixture in `packages/physics/tests/coupling/seakeeping.test.js` now uses
  Jung’s roll-only hinge, 0.90 m tank span, 0.30 m beam, 0.05 m draft and 0.236 kg m² whole-box dry inertia.
  The measured decay slope 0.33271 and period 0.930 s compare with 0.35051 and 0.89340 s at 60 Hz, inside
  the unchanged 12% and 5% regression bars. The independent KVLCC2 tests pass at λ/L 0.5, 1.1 and 2.
  Point 2 stays open. The 25 mm Wigley grid gives 31.49 and 33.05 mm versus 63.80 and 77.89 mm
  measured at 2x/L = −0.95. Refinement does not close that bow-wave gap. See `docs/limits.md`.

### SEA-14 four-point pass

- Point 5 (f5005a1986). `packages/physics/tests/entry.test.js` checks coded mesh, configuration and input
  refusals with their fixes. `packages/physics/tests/coupling/entry.test.js` checks an invalid pressure query
  on the second body, a finite load outside the rigid Float32 range, held forces, cavity, wakes and foam,
  and recovery. It checks the crown threshold with local density and exact replay across a signed rebase.
- Point 6 (f5005a1986). `packages/physics/tests/coupling/entry-profile-workers.test.js` compares scalar and
  native 1/2/4 snapshots, loads, events and sources on 322- and 1,066-triangle moving-body cases.
  `packages/physics/tests/entry-profile-workers.browser.mjs` joins three real nested helpers in packaged
  Chromium. Eighty cuts in the 1,066-triangle case dispatch 42,640 SIMD triangle pairs and 24,056 paired
  fan projections, with accepted hash 12039c63a4e3ce6f. The oblique odd-cut fixture also matches scalar.
- Point 7 (f5005a1986). `packages/water/test/entry-film.browser.mjs` renders the real crown and seal of a
  124 mm coated sphere at 64.583 and 214.583 ms. Accepted world state, the full 672×416 frame and replay
  match within each renderer byte for byte. Disabling just ShotSplash leaves the physics hash and remote
  water unchanged. The crown and seal contribute 1,076 and 2,109 pixels above the water in the camera.
- Point 8 (f5005a1986). `docs/limits.md` records the axisymmetric section projection, fixed-width crown
  closure, deep seal and jet calibration, and absent resolved sheets, surface seal and bubble pinch-off.
  `packages/physics/tests/entry.test.js` checks the exact cone wetted radius and Archimedes draft.
  The technical tank check leaves the original film shots open.
- Point 2 stays open. `packages/physics/scripts/sea14-entry-measured.mjs` uses published inputs only
  and keeps Speirs and Antolik outcomes outside the model. Speirs’s impulse through descending
  half-peak is 0.04520 versus 0.067 ± 0.003 observed. The 1 kHz resampling fails to close the gap.
  The pulse’s descending half-peak is 1.98 ms modelled against about 4.3 ± 1 ms read from the
  figure. Antolik’s first-radius impulse is 0.01823 versus 0.01560 observed (+16.8%). Neither
  comparison validates the later oblique, high-Weber-number or exit regimes.

### SEA-13 four-point pass

- Point 5 (96d21889b9). `packages/physics/tests/coupling/foam.test.js` verifies that a late invalid face and
  excessive current preserve the previously accepted coverage and clock. A corrected step matches a clean run.
  All three source fields receive signed cells across rebases and exact snapshot replay.
  `packages/physics/tests/coupling/foam-transport-workers.test.js` checks rollback of the native work receipt.
- Point 6 (96d21889b9). `packages/physics/tests/coupling/foam-transport-workers.test.js` compares 39×31 and
  71×37 grids byte for byte on scalar and native 1/2/4 participants and checks an independent dyadic flux case.
  `packages/physics/tests/foam-transport-workers.browser.mjs` joins three real nested helpers from packaged
  assets. Three CFL substeps on 71×37 cells dispatch 7,770 X and 7,668 Z face pairs, with accepted hash
  8d724e518f48857a.
- Point 7 (96d21889b9). `packages/water/test/sea-foam-surface.browser.mjs` draws the accepted grid from live
  wave breaking on both renderers against an identical sea with the producer detached. Coverage grows
  from 3.43 to 20.37 m² and its centroid travels 8.41 m. Both renderers replay the accepted state and full
  camera pixels exactly. The resize and detach checks also compare complete frames.
- Point 8 (96d21889b9). `docs/limits.md` records outflow, decay and saturation of the surface coverage
  field, geometric wakes, scalar field queries, the still-water plume closure and the separate optical
  histories. `packages/physics/tests/coupling/foam.test.js` checks coverage replay and
  `packages/physics/tests/bubble-plume.test.js` checks the analytic pure-plume limit. The technical cutaway
  leaves OO-1 and RITS-2 open and the adapter does not phase-lock individual patches to a separate sea.
- Point 2 stays open. `packages/physics/scripts/sea13-whitecaps-measured.mjs` compares nine independent
  North Atlantic camera measurements without fitting any outcome. All nine miss the published
  image-threshold sensitivity intervals. Mature-sea predictions were 0.90%, 1.52% and 1.71%, against
  1.36%, 2.93% and 7.06% observed, with RMSE 3.21 percentage points. The interval describes image
  threshold sensitivity. The archive supplies ECMWF covariates and grouped wave age; time-resolved
  directional spectra and coincident local wind measurements are unavailable in this comparison.

### SOUND-01 four-point pass

- Point 5 (3a2e5a1029). `packages/physics/tests/coupling/outdoor-sound.test.js` rejects a late invalid
  link and unrepresentable geometry without replacing any path. It verifies independent
  visibility on both legs of a ground reflection, the original finite atmospheric profiles and
  recovery. `packages/audio/tests/outdoor.test.js` verifies coded errors and preserves all audio
  parameters after a malformed octave or an unrepresentable gain.
- Point 6 (3a2e5a1029). `packages/physics/tests/coupling/outdoor-sound-workers.test.js` matches
  scalar and native 1/2/4 outputs byte for byte for 35 and 63 mixed paths through signed cells
  and snapshots. The two-leg summation and rollback after a rejected sample are checked separately.
  `packages/physics/tests/outdoor-sound-workers.browser.mjs` launches three real nested helpers
  from packaged assets. Sixty-three links visit 1,768 samples and 7,072 f64x2 octave pairs, with
  accepted snapshot hash a9a77933d033b037.
- Point 7 (3a2e5a1029). `packages/audio/tests/outdoor-film.browser.mjs` drives a bell and two
  equal-range links from actual TerrainBed and the native path solver. The ridge adds 570 audio
  samples at 48 kHz and reduces treble relative to bass by 12.83 dB. Both renderers repeat full
  camera pixels, accepted world snapshots and stereo Float32 PCM exactly after restore and replay.
- Point 8 (3a2e5a1029). `docs/limits.md` records one weakly refracted path or dominant edge,
  the specular plane, omitted ground impedance and shadow-zone modelling, and the playback shelves.
  `packages/physics/tests/coupling/outdoor-sound.test.js` covers analytic travel, the ISO table point,
  the local gradient and rigid-plane interference. The scoped audio filter and 3 km tests pass.
- Point 2 stays open. `packages/physics/scripts/sound01-outdoor-measured.mjs` compares 16 held-out
  measurements from four receiver heights. Five are within the figure-reading intervals. After the
  blocked reflection fix, the 250 Hz prediction at 15 m improves from −41.57 dB to −3.60 dB against
  −1.9 dB measured. Maximum remaining error is 6.97 dB. The publication does not give a complete
  uncertainty band or the lab air conditions. [Rasmussen (1994)](https://doi.org/10.1121/1.411404).

### AERO-02 four-point pass

- Point 5 (582f9bf782). `packages/physics/tests/coupling/sail-state.test.js` checks signed air scale, source coordinates, density and air medium. A late invalid sample and an unrepresentable kick preserve accepted force, circulation, native work and every cloth velocity. The rigid and soft solvers restore their accepted words together. `packages/physics/tests/sail.test.js` and `packages/physics/tests/coupling/sailing.test.js` retain real cloth-to-hull load transfer.
- Point 6 (582f9bf782). `packages/physics/tests/coupling/sail-workers.test.js` and `packages/physics/tests/sail-workers.browser.mjs` run the existing Rust lattice with 1, 2 and 4 actual participants. The 27- and 55-panel mixed cases run 676 and 900 matrix and wake interactions, with 312 and 210 SIMD pairs for each phase. Their physical bytes match the original scalar output, and each participant configuration exactly restores its own work receipt.
- Point 7 (582f9bf782). `packages/physics/tests/sail-film.browser.mjs` fills a flexible lug sail with a signed gust on a live lake dinghy. The paired take gives 132.21 N forward load, 16.69 cm of billow and 0.681 m extra hull travel against the lull. An unhindered test closes 66.468 N·s of applied impulse within 0.000456 N·s. Both renderers exactly replay accepted rigid and cloth state and all RGBA bytes.
- Point 8 (582f9bf782). `packages/physics/scripts/aero02-sail-measured.mjs` scores five independent S3 flume trims against load-cell coefficients that were withheld from the model. At 30° chord incidence it produces 0.488 lift and 0.355 drag against 1.309 and 0.601 measured. Four of five trims miss for each coefficient after measurement and model sensitivity. [Measured bounds](limits.md#aero-02-measured-cambered-sail-polar)

An unsteady shed wake, meaningful post-stall lift, measured cambered-sail agreement and porous canopies remain open. The row stays REOPENED at four points.

### AERO-03 four-point pass

- Point 5 (0fbedc538b). `packages/physics/tests/flight.test.js` covers coded wind, geometry
  and load failures, preservation of accepted wrench on a late malformed sample, and recovery
  from an unrepresentable combined force without losing the original rigid force. It checks exact
  sub-metre wing results far from the origin, huge and subnormal rotor directions, invalid radial
  callback data and envelope atmosphere failures. `packages/physics/tests/coupling/air.test.js`
  checks actual wing and rotor queries across the signed rigid and flow cells and exact replay.
- Point 6 (0fbedc538b). `packages/physics/tests/coupling/wing-lattice-workers.test.js` checks
  51- and 95-panel mixed-stall flights, exact scalar and native 1/2/4 forces and circulation and
  signed-cell rigid replay. A rejected load leaves the native work receipt intact.
  `packages/physics/tests/wing-lattice-workers.browser.mjs` runs three nested helpers from packaged
  assets. The final load counts 13 solves, 6,435 paired matrix and 6,435 paired wake interactions,
  plus 119,899 paired elimination updates. The 51-panel checkpoint hash is ac29322ae8e29565.
- Point 7 (0fbedc538b). `packages/physics/tests/aviary-flight.browser.mjs` compares a held
  glide with one prescribed downstroke on the same rigid paper crane. Vertical velocity changes
  from −0.325 to +0.631 m/s and height rises 5.05 cm relative to the glide. The accepted lift
  impulse accounts for the momentum change. WebGPU and WebGL2 repeat their own complete pixels
  and world snapshots exactly. AVIARY-2 and AVIARY-4 and the original AVIARY-3 timeline stay open.
- Point 8 (0fbedc538b). `docs/limits.md` records thin quasi-steady wings, axial annuli,
  dense matrix storage and the absence of unsteady wake or rotor crossflow. Analytic finite-wing,
  stall, rotor momentum bounds and lifting gas are checked in `packages/physics/tests/flight.test.js`.
- Point 2 stays open. `packages/physics/scripts/aero03-rotor-measured.mjs` holds out NASA integrated
  thrust. The solver overpredicts all 12 unambiguous results by 36–52%. At 1,250 rpm the predicted versus measured
  thrust coefficients are .003246/.00213 at 5°, .006429/.00459 at 8° and .011267/.00796 at 12°. The
  script reports the anomalous printed value separately and distinguishes print resolution from
  unreported instrument uncertainty. [Caradonna and Tung, NASA TM-81232](https://ntrs.nasa.gov/citations/19820004169).

### ATMO-09 four-point pass

- Point 5 (c885f8db50). `packages/physics/tests/coupling/surface-energy.test.js` checks end-of-step
  precipitation and X-fast sampling across signed world and precipitation cells. Malformed rain
  and strided forcing overflow leave every accepted patch unchanged. A late native partition rejection
  also preserves accepted state and work in `packages/weather/tests/surface-energy-workers.test.js`.
- Point 6 (c885f8db50). `packages/weather/tests/surface-energy-workers.test.js` checks exact
  TypeScript and native state across one, two and four participants, including signed shift and replay.
  Its 2,623 rows execute 1,311 SIMD patch pairs and 60,231 paired residual evaluations.
  `packages/weather/tests/surface-energy-workers.browser.mjs` runs plain and shared packaged Wasm
  with three real browser helpers and obtains identical accepted bytes across all five paths.
- Point 7 (c885f8db50). `packages/weather/tests/surface-energy-surface.browser.mjs` uses moving
  precipitation, a TerrainBed and accepted wet color and roughness. The rain footprint advances 278.3
  pixels, both banks darken, and the east bank saturates, sheds runoff and dries to 0.312 wetness.
  The dry control stays unchanged. Both renderers repeat their own accepted state and pixels exactly.
  Installation in the original RITS-10 watershed shot stays open.
- Point 8 (c885f8db50). `docs/limits.md` records independent patch budgets, fixed soil temperature
  and snow properties, omitted layered heat and lateral drainage, and worker requirements.
  `packages/physics/tests/coupling/surface-energy.test.js` covers analytic heat, water and energy
  conservation, phase, saturation and fuel drying. Existing fog, snowpack, rail and road coupling
  tests exercise direct consumers.
- Point 2 stays open. `packages/weather/scripts/atmo09-col-de-porte-measured.mjs` holds out three
  post-initialization snow skin temperatures in each of two Col de Porte episodes. Daytime RMSE is
  1.008 K. Cold-night RMSE is 4.866 K, with the final mean 6.843 K warm. Alternate hourly timing and
  emissivity leave the warm drift. The comparisons cover one site and skin temperature. Measured
  turbulent flux, melt and further sites stay open. [Morin et al. (2012)](https://doi.org/10.5194/essd-4-13-2012).

### SOUND-02 four-point pass

- Point 5 (`1956fb9218`). `packages/physics/tests/room-sound.test.js` checks finite geometric range
  and coded geometry and PCM errors, and forces an unrepresentable native source sum. Both pressure
  regions, trace, sample clock and accepted work survive the failure.
  `packages/physics/tests/coupling/room-wave-native-range.test.js` proves the native plain and shared
  variants retain a finite extreme field and reject a true overflow.
- Point 6 (`1956fb9218`). `packages/physics/tests/coupling/room-wave-workers.test.js` compares one
  plain participant with one, two and four shared participants. The 25 × 11 × 17 case crosses four
  samples and visits 12,376 f64x2 pairs per tick, with unchanged receiver and pressure bytes through
  signed-cell shift and replay. `packages/physics/tests/room-wave-workers.browser.mjs` verifies bundled
  Wasm files and starts three real helpers.
- Point 7 (`1956fb9218`). `packages/physics/tests/concert-hall.browser.mjs` uses the actual finite
  surfaces, image paths and Web Audio impulse. The direct and double-reflection arrivals are 22.875 ms
  and 40.725 ms. Both wall impacts occur on their computed frames. WebGPU and WebGL2 reproduce their
  held and replayed frames and PCM exactly. The original showcase source is available on main and
  the installed reflection cue and original soundtrack remain open.
- Point 8 (`1956fb9218`). `docs/limits.md` records the reflecting-edge and single-band grid,
  specular geometry, pressure bounds, memory and helper requirements, and the omitted room responses.
  The tests in `room-sound.test.js` and `coupling/room-sound.test.js` check the baseline path geometry,
  discrete mode, diffraction and dissipative boundary.
- Point 2 stays open. `packages/physics/scripts/sound02-bras-measured.mjs` holds out ten recorded
  excess reflection delays from the BRAS RS1 rigid-floor scene. All are inside the engineering
  allowance of roughly 0.16–0.18 ms. Predictions are consistently 0.042–0.133 ms early. The one
  scene validates early reflection timing. Independent amplitude, late decay and further rooms remain open.

### DYN-05 four-point pass

- Point 5 (`59abbb0f64`). `packages/physics/tests/coupling/rail.test.js` verifies equal projected
  outer-rail acceleration in forward and reverse for both curve hands. It checks coded rejection of
  malformed survey and contact input, signed-cell publication, and an overflow after native prediction
  that leaves the accepted car and wire regions and work receipts unchanged.
- Point 6 (`59abbb0f64`). `packages/physics/tests/coupling/rail-wire-workers.test.js` checks the
  pinned-end discrete wave mode and exact plain/shared replay with one, two and four participants,
  a moving pantograph and a signed origin shift. The 4,099-node test performs 3,415 velocity
  and 4,097 position updates, for 7,512 f64x2 visits per step.
  `packages/physics/tests/rail-wire-workers.browser.mjs` verifies both bundle-emitted native assets
  and starts three actual helpers on the 1,027-node catenary.
- Point 7 (`59abbb0f64`). `packages/physics/tests/rail.browser.mjs` records both directions at stations
  54.996 m and 55.004 m on a surveyed 100 m wet curve. Both cars sway outward by 45.518 mm and roll outward
  by 5.133°. The marker moves outward by about 15 pixels. Both renderers reproduce their held and replayed
  frames exactly. The straight running and powered pantograph cases also pass. The original Last Tram
  and City to Street shots await integration.
- Point 8 (`59abbb0f64`). `docs/limits.md` records fixed creep and Hertz coefficients, omitted spin
  creepage and wheel/rail profiles, the missing Nadal criterion and off-track collision, world-Y
  catenary geometry, and the absent messenger, droppers, wire bending and wind. The analytic
  `rail.test.js` and `rail-wire-workers.test.js` cases cover the reduced geometry and wave model.
- Point 2 stays open. `packages/physics/scripts/dyn05-vtrack-measured.mjs` holds out 19 measured lateral
  adhesion samples from Krishnan et al. (2025). Stock dry contact misses 14 uncertainty bands.
  At the largest slip it predicts 0.295–0.297 against 0.375–0.394 measured. Scaling the linear
  coefficient from the reported contact ellipse also misses 18 samples. The diagnostic covers
  scaled dry lateral contact. Measured train motion and catenary response remain open.

### EARTH-07 four-point pass

- Point 5 (`5348518fdc`). `packages/physics/tests/coupling/aeolian.test.js` checks signed wind sampling with
  a different cell size, rejection of a malformed last wind sample, overflowing shear and an unrepresentable
  CFL count. All accepted regions and diagnostics survive the failures. `aeolian-workers.test.js` verifies that
  a physically empty hill-fetch suffix is skipped and that an unrepresentable sample still intersecting the bed
  is refused before scanning it.
- Point 6 (`5348518fdc`). `packages/physics/tests/coupling/aeolian-workers.test.js` compares one plain and
  one, two and four shared-memory participants for rough sand with ripples and rough snow, including signed
  rebasing, exported ports, bed changes, budgets and exact snapshot replay. The 33 × 27 sand run uses six
  CFL intervals, 5,346 exchange rows, 444 f64x2 forcing pairs and 2,664 f64x2 exchange pairs in the four-way
  case. `packages/physics/tests/aeolian-workers.browser.mjs` starts three helpers from production bundle URLs
  and checks both emitted Wasm assets.
- Point 7 (`5348518fdc`). `packages/vfx/test/blown-sand-check.mjs` feeds the production renderer from
  accepted `TerrainBed` changes and actual transport through the travelling-gust ridge fixture. The gust
  carries 2.207 kg, erodes the crest by 0.244 mm and deposits 0.154 mm in the lee. Both renderers reproduce
  their held and replayed RGBA exactly. The original TREE-5 shot awaits integration.
- Point 8 (`5348518fdc`). `docs/limits.md` records the fixed grain speed, exposure, one-grain restart, absence
  of suspension, numeric domain and shared-worker requirements. `aeolian.test.js` checks the snow equilibrium
  against the model formula and conservative settling, ripple, repose and closed/open edge behavior.
- Point 2 stays open. `packages/physics/scripts/earth07-creyssels-measured.mjs` holds out all six independent
  collector measurements in Creyssels et al. (2009), Table 1. Predictions are 13.4–32.1% low, and four runs
  miss the published flux bands after propagating the separate 5% error on the measured wind input. No
  parameter was fitted to the fluxes. The grain momentum model, suspension and two-way wind response also
  remain open.

### ATMO-08 four-point pass

- Point 5 (e2dee8854c). `physics/tests/coupling/drainage-fog.test.js` checks finite wind at a distinct signed origin, rejection of
  extreme derived column states and a CFL interval too small to advance the clock. The old accepted columns,
  optical bytes, ledger, time and work survive failures. Grey-mode reference tests retain their fluxes and the
  liquid-water-path case checks sensible and latent heat against the effective emissivity.
- Point 6 (e2dee8854c). `physics/tests/coupling/drainage-fog-workers.test.js` compares plain/shared one-participant runs with
  two and four native participants in distinct signed cells. It checks exact optical, f64 column and world
  snapshot replay through origin shift. The 77 × 45 case crosses eight stable intervals with 27,720 columns
  evaluated in each substep stage and 13,856 executed f64x2 wave-speed pairs across the four participants.
  `physics/tests/drainage-fog-workers.browser.mjs` also starts three actual helpers and checks the packaged assets.
- Point 7 (e2dee8854c). `environment/tests/drainage-fog.browser.mjs` drives the live terrain field, phase change, native
  downslope flow and optical-grid rendering through the fixed-camera valley cutaway. Initial downslope acceleration
  is 0.0462 m/s², the liquid centroid travels 5.48 m and the basin gains 12.14 g of condensate. Both renderers
  match held and replayed RGBA and snapshot bytes with the same clear-terrain starting pass. The original PA-34 film scenes remain open.
- Point 8 (e2dee8854c). `docs/limits.md` records the single vertical layer, grey opacity, cell and worker requirements, optical
  size and the microphysics and field accuracy still owed.
- Point 2 stays open. `physics/scripts/atmo08-parisfog-measured.mjs` holds out visibility measured independently
  from droplet diameter and liquid water. In ParisFog F9 all six samples overlap their broad measurement bands.
  In F32 five of six miss. Predicted visibility is high at all twelve timestamps. The comparison covers optical
  extinction at input times. It leaves formation, stability and vertical growth unvalidated.

### AERO-01 four-point pass

- Point 5 (d4370faed2). `physics/tests/aero.test.js` compares a rotated compound's local bounding surface with the exact
  rectangular area and face centres. It exercises malformed later-panel samples and finite velocities that overflow
  the rigid force domain. Earlier bodies retain their accepted forces. `physics/tests/coupling/air.test.js` proves
  local panel coordinates across distinct signed cells, rebasing and exact replay.
- Point 6 (d4370faed2). `physics/tests/coupling/wind-traction-threads.test.js` checks Rust f64x2 panel pairs and an odd tail.
  It compares all six accepted force and torque components and full rigid-world bytes across scalar and 1, 2 and 4
  native participants in distinct signed cells. In five steps, 4,291 panels produce 65 probes, 278,915 panel evaluations
  and 139,425 SIMD pair evaluations. `physics/tests/wind-traction-threads.browser.mjs` starts three actual helpers
  from a production consumer and compares the emitted native assets byte for byte.
- Point 7 (d4370faed2). `physics/tests/aero-mobile.browser.mjs` steps the live ATMO-02 field, AirSolver, WindForce and native rope
  joints on a procedural paper mobile. It checks the force-and-torque port, a 0.02046 N thread load, 18.28 and 19.60 cm
  downstream motion, rotation and visible displacement. Both renderers match held and replayed RGBA and world
  snapshots byte for byte. Passing-flyer wake, paper flex and original AVIARY-5 integration remain open.
- Point 8 (d4370faed2). `docs/limits.md` records the shape bounds, small relative-velocity cutoff, f32 load domain, worker setup
  and known differences from measured round-body drag.
- Point 2 stays open. `physics/scripts/aero01-sphere-measured.mjs` compares rigid impulses against Achenbach's
  independent sphere measurements. All eleven plateau and recovery observations fall outside their readout bounds.
  The model predicts a coefficient of 0.775 at Reynolds number 6 million versus the reported 0.19. The four
  transition points are reported separately.

### ATMO-02 four-point pass

- Point 5 (df2e11c99e). `weather/tests/turbulence.test.js` covers the continuous transverse-mode shear, far signed-periodic
  queries and invalid or overflowing settings. `weather/tests/travelling-gust.test.js` covers the FAA envelope's
  analytic position and rise, the height taper, a signed origin cell rebase, out-of-order queries and rejection
  before writing the caller's output. Calm boundary-layer wind leaves default turbulence off and accepts a gust.
- Point 6 (df2e11c99e). `weather/tests/turbulence-native.test.js` checks raw Stockham FFT parity and the scalar, one-thread,
  two-thread and three-thread seeded output byte for byte. At 512 × 32 × 32 cells, three participants count six
  transforms of 3,145,728 complex values and 179,306,496 f64x2 twiddle products. The signed-cell gust queries
  survive rebasing. The optional native plan handles the FFT while noise and spectral factors use pinned TypeScript.
  `weather/tests/mann-fft.browser.mjs` proves two helpers and both assets in a production app, and keeps the Wasm
  external in a library build.
- Point 7 (df2e11c99e). `scatter/test/plant-gust.browser.mjs` carries the gust over a real ATMO-01 air field into BIO-01
  PlantSway and Scatter. At 4 m/s, roots spaced 2 m apart first move on world frames 46, 76 and 106, exactly
  30 frames apart. Equal-age near and far plant tips each move 12.23 cm. Both renderers show the same spatial
  delay and match full RGBA frames and accepted physics snapshot bytes after rewind. The technical TREE-1
  reproduction leaves original shot integration open.
- Point 8 (df2e11c99e). `docs/limits.md` records the CPU and worker split, periodic dimensions, finite-band and near-ground
  limitations, and which authoring assumptions apply to a one-cosine event.
- Point 2 stays open. `weather/scripts/atmo02-vindeby-measured.mjs` compares fixed-settings Mann boxes with
  the independent Putri et al. (2022) Fig. 11 measurements. The refined vertical co-coherence RMSE is 0.409,
  and all 12 vertical estimates exceed the corresponding observations. Model seed spread and the measured
  high-wavenumber scatter are reported separately. Ground blocking, stability-dependent spectra, the IEC
  extreme operating gust family, and the original rain and meadow shots remain open.

### BIO-01 four-point pass

- Point 5 (a638e82e14). `bio01-acceptance.test.js` covers distinct flow-origin translation, signed publication, and a finite input
  pair whose derived acceleration overflows. The invalid sample leaves the accepted pose intact. The native tests
  cover rejecting a nonfinite modal discriminant. `coupling/vegetation.test.js` drives the first rigid contact and
  trunk release from a frame-zero snapshot and checks exact replay.
- Point 6 (a638e82e14). `vegetation-threads.test.js` and `vegetation-threads.browser.mjs` compare plain/shared serial
  and four-partition acceptance, including signed origins, already failed plants and exact replay. The large case
  integrates 4,099 plants and counts 8,198 SIMD pairs. Isolated Chromium starts three actual helpers. The raw native
  comparison covers 56,160 rows and keeps accepted state when a later partition rejects an overflowing discriminant.
  The same browser test starts three helpers from a Vite production build and verifies the shipped Wasm bytes.
- Point 7 (a638e82e14). `scatter/test/plant-surge.browser.mjs` binds actual SEA-02 water velocities into `PlantSway` and
  renders its accepted output through the existing GrassScatter and PlantMotion route. Shallow and deep stem tips
  travel 21.74 cm and 1.52 cm. The shallow visible crest travels 13.88 pixels while its root stays planted.
  WebGPU and WebGL2 reproduce accepted state and held/replayed frame bytes. This is a fixed-camera BS-1/BB-2
  technical cutaway. The original shots, anemone contact and large bending remain open.
- Point 8 (a638e82e14). The Physics and Scatter READMEs and `docs/limits.md` document the two-mode geometry, signed origin,
  ordered native acceptance, attached rigid adapter, the measured comparisons and the limits of the cutaway.
- Point 2 remains open. `bio01-sway-measured.mjs` compares held-out tree ringdowns. The nominal stripped and
  intact estimates are 11.93 and 7.10 rad/s versus 11.4 ± 0.5 and 3.78 ± 0.09 rad/s observed. The paired intact
  stem misses even with geometry and static stiffness sensitivity choices. `bio01-blade-measured.mjs` predicts
  9.51 and 195.73 mm of peak-to-peak excursion for two blades measured at 5.0 and 175.0 mm. Both remain outside
  the ±2 mm resolution estimate across the tested input sensitivity. Shape and known loading limitations are
  documented. The observed sways and excursions are not forcing or fit inputs.
  [Spatz et al.](https://doi.org/10.3732/ajb.94.10.1603) · [Luhar and Nepf](https://doi.org/10.1016/j.jfluidstructs.2015.11.007)

### LIFE-03 four-point pass

- Point 5. `850df734e6`. `life03-acceptance.test.js` verifies the production feedback frequency against the fast-envelope
  equation at three body lengths, preserves an explicit override, and checks that invalid controls and
  unrepresentable propulsion leave accepted values intact. `swim-threads.test.js` also checks native numeric
  errors and preserves the accepted body and wake fields. Exported ports carry the live signed origin.
- Point 6. `850df734e6`. `swim-threads.test.js` and `swim-threads.browser.mjs` compare ordinary and reciprocal passive routes
  across signed origin shifts and exact snapshots. A four-partition run integrates 4,099 bodies, 8,198 SIMD
  axis pairs and 4,099 passive reaction rows. Isolated Chromium uses three actual helpers. The real seven-body
  passive transfer into shallow water closes 5.36112 N·s at less than 3.56e-15 N·s absolute residual.
- Point 7. `850df734e6`. `environment/tests/swim-sediment.browser.mjs` draws the accepted body orientation and 10 cm fin
  motion and reads the pectoral impulse before positive sand release. The live plume travels 17.1 pixels
  and leaves 674.8 µm of settled relief with zero net settled bed-volume change. Both renderers reproduce
  the starting hold, release, downstream pass and settled bed after seek. This is the BB-7 technical cutaway.
  The editable original shot and tail vortex and bubble rendering remain open.
- Point 8. `850df734e6`. Physics and Environment READMEs and `docs/limits.md` document the fit and control limits, work
  and origin requirements, the cutaway's scope and the reduced body, fin and wake models.
- Point 2 remains open. `850df734e6`. `life03-swim-measured.mjs` uses three independent Sparks et al. juvenile rainbow trout
  tail records and compares reached calculated speeds against the withheld speeds. The measured 0.22, 0.48
  and 0.74 m/s compare to 0.253, 0.421 and 0.541 m/s. Reached Strouhal values 0.324, 0.316 and 0.310 fall within
  the published 0.2–0.4 range. Body morphology is estimated from separate same-species measurements. The
  highest-speed result still misses by 12.8% with the form-drag term removed and remains outside the geometry
  sensitivity band. The papers used by the fast frequency fit are excluded from held-out scoring.
  [Sparks et al.](https://doi.org/10.1242/jeb.247873) · [Webb et al.](https://doi.org/10.1242/jeb.109.1.77) ·
  [Taylor et al.](https://doi.org/10.1038/nature02000)

### ATMO-06 four-point pass

- Point 5. `a65111cd3a`. `airborne-acceptance.test.js` reproduces a bad Wind sample after a previous parcel was sampled and
  new source mass was staged. The solver returns a coded error and preserves accepted bytes, particles, source
  counters, work and registry receipt. A resumed step agrees exactly with the uninterrupted route. The signed
  publication test covers both registry fields through a far-origin shift and rewind.
- Point 6. `a65111cd3a`. `airborne-threads.test.js` and `airborne-threads.browser.mjs` compare one and four partitions across
  emissions, evaporation, particle IDs, escape and far-origin replay. At 4,099 live parcels, the native step reports
  8,198 SIMD axis pairs and 2,732 evaporation updates. Isolated Chromium starts three actual helpers and matches
  the serial accepted snapshot and fields.
- Point 7. `a65111cd3a`. `airborne-surface.browser.mjs` draws the real WaveSolver to SEA-13 to ATMO-06 route on both renderers.
  The 219 retained tracks move 24.74 m downwind. The accepted 1,368 parcels have 0.0047717 m² of optical
  cross-section. The volume touches 1,256 HDR columns and changes 5,258 WebGPU and 5,262 WebGL2 pixels. Both
  replay the held parcel, depth, and canvas state exactly. `environment/tests/density-volume.test.js` tests
  the optical kernel and far-origin alignment. The original film and legacy Water spray path remain open.
- Point 8. `a65111cd3a`. Physics and Environment READMEs and `docs/limits.md` record the drag and humidity domains, scope of
  the native worker, deposition and optical approximation and remaining environmental cases.
- Point 2 remains open. `a65111cd3a`. `atmo06-droplet-settling.mjs` runs two 0.10–0.50 mm independent settling series and
  free-fall evaporation at 50% and 90% relative humidity. Three Gunn–Kinzer settling rows exceed 0.7% stated
  accuracy plus rounding. The separately acquired Beard–Pruppacher tunnel-derived speeds differ by 0.20–2.98%
  in absolute terms. Only the 0.40 mm evaporation row at each humidity lies inside the 4% reference uncertainty
  plus rounding. Neither settling speed nor measured mass loss initializes the predicted trajectory.
  [Smithsonian measurements](https://repository.si.edu/items/5b259e9c-a900-48e0-ad68-07bb46302156) ·
  [Wind-tunnel table](https://ntrs.nasa.gov/api/citations/19790017494/downloads/19790017494.pdf)

### ATMO-03 four-point pass

- Point 5. `9622992eda`. `atmo03-projection.test.js` independently derives all twelve MAC face velocities for a warmed cell at
  80 m and 160 m spacing. Removing an extra division by cell width brings the flux balance in every cell within
  the analytical bound. Further tests check immediate mean-wind rewind, a coded impossible atmosphere and exact
  retention of the accepted state and registry receipt after a failure in the second attempted internal step.
- Point 6. `9622992eda`. `cloud-projection-threads.test.js` and `cloud-projection-threads.browser.mjs` compare the scalar and native
  accepted fields, projection diagnostics and exact seek through signed far-origin shifts. Four partitions on the
  49 × 17 × 23 grid perform 171 products covering 3,276,189 cells, with 3,075,606 SIMD-paired visits. Isolated
  Chromium starts three actual helper workers and repeats the same snapshot hash as the scalar projection.
- Point 7. `9622992eda`. `cloud-surface.browser.mjs` reproduces the fixed-camera cloud-motion requirement of OO-4. The real
  native boundary-layer Wind moves the accepted condensate and the Environment density volume renders that
  changing field on WebGPU and WebGL2. The accepted cloud moves 807.4 m east and rises 72.7 m. Its visible
  centroid moves 203.1 pixels, with exact replay after renderer readiness. `environment/tests/density-volume.test.js`
  checks physical optical scaling
  and validates field replacements. Original film installation and other shot conditions remain open.
- Point 8. `9622992eda`. The Physics and Environment READMEs and `docs/limits.md` record the Boussinesq and warm-rain domain,
  relative pressure residual and resource bounds, scalar transport limits, constant cloud optics defaults, scope of
  SIMD work and the older snapshot layout limitation.
- Point 2 remains open. `9622992eda`. The closed MAC cube tests numerical accuracy. Bryan and Fritsch (2002) is an idealised
  simulation benchmark requiring an initial saturated sounding and reversible moist thermodynamics. BOMEX
  intercomparison cloud statistics are simulated, and RICO forcing uses the campaign radar precipitation to close
  the budget. A defensible field test can use independent RICO aircraft liquid-water profiles or ARM LASSO liquid
  water paths once the solver accepts the required observed profiles and large-scale forcing.
  [Bryan and Fritsch](https://www.atmos.albany.edu/facstaff/rfovell/ATM562/bryan-fritsch-2002.pdf) ·
  [BOMEX](https://doi.org/10.1175/1520-0469%282003%2960%3C1201%3AALESIS%3E2.0.CO%3B2) ·
  [RICO](https://doi.org/10.1029/2011MS000056) · [ARM LASSO](https://doi.org/10.1029/2021JD035208)

### ATMO-01 four-point pass

- Point 5. `9d7dd26bc5`. Weather's `boundary-layer.test.js` compares stable and unstable profiles to independent
  closed and quadrature references, checks coded options, applies local Taylor speed, and verifies
  the finite-height box or ground does not repeat an earlier vertical gust. Physics' `coupling/boundary-layer.test.js`
  verifies height-dependent rigid panel loads and exact replay through AirSolver.
- Point 6. `9d7dd26bc5`. `boundary-layer-threads.test.js` and `boundary-layer-threads.browser.mjs` compare
  accepted Weather and Rust/Wasm states through far-origin shifts and exact seek with plain
  and shared memory. Chromium starts three actual helpers. The largest Node grid samples 71,703 rows
  with 71,702 SIMD-paired rows and 55,769 Mann interpolations.
- Point 7. `9d7dd26bc5`. `boundary-layer-surface.browser.mjs` reproduces RITS-5 with a fixed camera using
  continuous accepted native wind and the production Weather precipitation field. The shaft
  drifts 30 m in six seconds and its lower section moves 105.93 m downwind of the cloud base.
  Both renderers draw the actual slant and reproduce exact replay. The precipitation fixture
  has a separate published droplet terminal-speed comparison.
- Point 8. `9d7dd26bc5`. Physics and Weather READMEs and `docs/limits.md` describe the stability law and
  supported heights, tapered synthetic gusts, registry grid, scope of the rain reproduction
  and remaining terrain and coupling work.
- Point 2 remains open. `9d7dd26bc5`. `atmo01-mosaic-measured.mjs` compares 98 higher-level MOSAiC wind
  observations at 49 times. Low-level speed and turbulence stability data and external SHEBA
  roughness initialise the model. The corrected top-sensor RMS is 0.382 m/s stable, 0.500 m/s
  unstable and 0.615 m/s near neutral. Independently measured friction velocity lowers those
  to 0.262, 0.382 and 0.405 m/s. The two top levels remain held out. The archive has no full
  per-record uncertainty on the measured friction velocity and stability.
  [MOSAiC archive](https://doi.org/10.18739/A2PV6B83F) · [SHEBA](https://doi.org/10.1029/2000JC000705)

### HYDRO-03 four-point pass

- Point 5. `0991351637`. `coupling/sediment.test.js` verifies that remote pools cannot alter a bank's exchange, channel-normal
  flow gives zero perturbation, and both raster axes follow the same directional mass balance. It checks extreme
  settling arithmetic and rejection of a candidate concentration outside float32 without changing the prior
  accepted load, bed or work. `sediment.test.js` covers coded input validation.
- Point 6. `0991351637`. `sediment-threads.test.js` and `sediment-threads.browser.mjs` verify exact native snapshots with
  plain and shared memory and one, two and four workers, including mixed wet/dry roots, transport, a signed
  far-origin shift and replay. Chromium starts three helpers and the four partitions visit all 172 faces. On a 257 × 193
  grid four native partitions visit 49,601 cells and 99,652 faces, producing the same accepted state as serial.
- Point 7. `0991351637`. `sediment-surface.browser.mjs` drives an authored live Hydro inlet through the shared TerrainBed.
  Scour and deposition in the flume reach 31.14 mm and 1.09 mm. Both renderers draw actual accepted topography
  and live sediment tint. Changing only the tint alters 22,441 and 22,443 pixels on WebGPU and WebGL2 with unchanged
  accepted motion. Bed and water readbacks, solid and water ledgers and fixed-camera replay pass.
- Point 8. `0991351637`. Physics and Water READMEs and `docs/limits.md` describe the local bank approximation, erodible reserves,
  single-class transport, clear-inflow boundary, ordered transfer and the same-grid optical source.
- Point 2 remains open. `0991351637`. `hydro03-bedload-measured.mjs` compares eleven independent measured initial bedload
  capacities at 1.37% and 2.20% slope, using source discharge, roughness from separate preliminary tests and
  measured grain properties. Default Wong–Parker gives 22.75–28.75% of measured solid capacity. The sediment-fed
  aggradation case requires a solid input port. [Eslami and Radice (2025)](https://doi.org/10.5194/esurf-13-437-2025) ·
  [Measured capacities](https://doi.org/10.5281/zenodo.14883164)

### SPACE-01 four-point pass

- Point 5. `06bda264b7`. `orbit.test.js` checks Kepler position and velocity near eccentricity one, extreme circular
  scales, finite inverse-square forces from tiny and huge separations, and coded input corrections.
  `orbit-threads.test.js` checks that a late singular stage preserves accepted bodies, clock and work.
- Point 6. `06bda264b7`. `orbit-threads.test.js` and `orbit-threads.browser.mjs` check accepted native snapshots
  across Plain and Shared Wasm and actual shared workers. The mixed layouts exercise massless rows,
  ordered J2 and atmosphere, signed origin-cell shifts, replay and exact partition work. Chromium starts
  three nested helpers. Four native lanes execute 18,432 source contributions over four force sweeps of
  513 bodies, with 18,288 shared distances in serial and 18,432 independently computed in parallel.
- Point 7. `06bda264b7`. `orbit-surface.browser.mjs` draws three live gravitating bodies from the registry on
  WebGPU and WebGL2. A fixed camera watches 221 line segments, three body meshes and labels over
  2.066 physical days. Both renderers change 4,814 pixels. The accepted field follows the independent
  triangular relative equilibrium within 6.17 m across 9.60 billion m and replays exactly.
- Point 8. `06bda264b7`. The Physics README and `docs/limits.md` record fixed encounter substeps, Newtonian gravity,
  an exponential atmosphere and the scope of the bound Kepler helper and authored disk.

- Point 2 remains open. `06bda264b7`. `space01-three-body.mjs` matches the exact unequal-mass triangular solution and
  the first three published Burrau close passes at a finer fixed step. It records the coarse energy
  failure and leaves the later encounter open. `space01-apollo-measured.mjs` compares four independent
  October 2020 Apache Point normal points. The geometric range residuals run from −9.86 to +218.18 m
  with at most 28.3 mm change on step halving. The predicted residual remains over the instrument's
  reported precision in every case. The measured values were withheld from model inputs.
  [Szebehely and Peters (1967)](https://doi.org/10.1086/110355) ·
  [APOLLO archive](https://doi.org/10.5281/zenodo.7818557) ·
  [DE440 input model](https://ssd.jpl.nasa.gov/doc/Park.2021.AJ.DE440.pdf)

### SOUND-03 four-point pass

- Point 5. `115c72d0be` and `85765e0ef8`. `underwater.test.js` verifies coded errors for malformed launches and beams, 33,554,432
  reflections in one folded tick, overflow-resistant beam phase and width, and unchanged accepted
  state when the new reflection count would exceed the largest exact integer.
- Point 6. `85765e0ef8`. `underwater-threads.test.js` and `underwater-threads.browser.mjs` compare the accepted
  JavaScript and Rust/Wasm SIMD ray, delay and pressure state across plain memory and 1, 2 and 4 native
  threads with exact snapshots, origin-cell shifts and worker receipts. Chromium uses three real helpers.
  At the endpoint of its stratified case, 11 rays execute 18 drift integrals and 7 crossings. Each axis in
  the uniform 33,554,432-crossing Node control completes one drift. Failed aggregate receipts preserve
  the previous accepted rows and counts.
- Point 7. `115c72d0be`. `underwater-surface.browser.mjs` renders an authored 200 ms pulse in a fixed cutaway.
  Three actual boundary reflections, 39 accepted ray segments and live pressure and delay produce
  4,894 changed pixels on each renderer. The analytic folded paths and beam envelope agree, and
  pre-trigger and after-stop holds, rewind and replay are exact.
- Point 8. `115c72d0be` and `85765e0ef8`. The Physics README and `docs/limits.md` describe the fixed horizontal boundaries, relative
  per-beam pressure, fixed attenuation, exact count range and omitted receiver field.
- Point 2 remains open. `115c72d0be`. `sound03-arrival-measured.mjs` compares independent reported arrival times
  with the production world. The ocean timing passes one of four measured delays at published resolution
  and three within observed arrival spread. The tank delays differ by 0.033 and 0.197 ms with nominal sound
  speed and unknown placement uncertainty. Neither comparison validates pressure or transmission loss.
  [Chitre, 2007](https://doi.org/10.1121/1.2782884) · [Viegas, Zabel and Silva, 2023](https://doi.org/10.3390/s23104931)

### SEA-06 four-point pass

- Point 5. `63770ed64b` and `tsunami-extremes.test.js` verify finite Coriolis and travel-time calculations,
  rejected over-budget CFL ticks and overflowing volumes, no energy increase over 12 seconds of wetting and drying,
  mass conservation to 2.22e−15 m³, and exact replay. `tsunami.test.js` checks malformed grids and coded corrections.
- Point 6. `a437d9db30` and `tsunami-threads.test.js` check identical accepted bytes on plain Wasm and shared Wasm
  with one, two and four threads. A live source crosses an origin-cell boundary during repeated
  wetting and drying, and a snapshot restores the same bytes and flux counts. A single CFL substep
  evaluates 50,504 faces on 129 × 97 cells and 199,304 on 257 × 193 cells, partitioned across four
  workers by whole rows and columns. `tsunami-threads.browser.mjs` checks exact replay and snapshot
  equality with three actual helpers in a Chromium worker.
- Point 7. `63770ed64b` and Water's `tsunami-surface.browser.mjs` verify the accepted dry-to-wet surface on both
  renderers. `d828209f91` adds a characteristic that can be authored or supplied from an independent gauge. `tsunami.test.js`
  checks its propagation from all four sides, signed volume closure and exact seek.
- Point 8. `63770ed64b` corrects the fault-source documentation and records the renderer and numeric limits.
  [Laboratory evidence](../packages/physics/scripts/sea06-measured.md) preserves the measured model gaps and reproduction.
- Point 2 remains open. On the 20 mm grid, the Drähne T30 case meets two of six paired camera bounds and T20 meets
  none. Both preserve the inlet and gauge records separately. The NOAA canonical beach misses persist across
  three grids, with the larger crest arriving too early and a weaker case missing the observed rundown.
  `881bca11b8` and `tsunami-laminar.test.js` verify the linear column against independent
  eigenmode sums over shallow, transitional and deep regimes. At 20 mm the closure meets four of six
  T20 camera bounds and one of six T30 bounds, so the coastal validation point remains open.

### ATMO-07 four-point pass

- Point 5. `ff539d3944` and `lightning-extremes.test.js` checks independent leader and return speed limits, a terrain chord
  that would travel faster than light, malformed spatial and electrical inputs, and transactional
  rejection of a late return-time overflow in both Wasm memory modes. `lightning-native.test.js` checks
  both SIMD lanes report an unrepresentable Poisson correction. Sky's `lightning-bolt.test.js`
  checks the coded settings, coordinates and radiance corrections in `6bcaf278f3`.
- Point 6. `6bcaf278f3` and `lightning-threads.test.js` verify identical native field, channel and replay in plain
  and shared memory on one, two and four threads, with a 700,000-cell origin shift and signed charge.
  Four threads execute 9,009 and 27,846 SIMD pairs over seven sweeps on distinct odd grids.
  Chromium's `lightning.browser.mjs` launches three nested helpers and matches shared serial byte
  for byte over 480 sweeps and 184,800 SIMD pairs.
- Point 7. `ff539d3944` and `lightning.browser.mjs` compare a placed leader, the accepted return stroke, fade and
  snapshot restore. WebGPU and WebGL2 each draw 455 bright pixels over 102 rows, with the channel
  translated from the adjoining origin cell. The accepted flash and replay hash match.
- Point 8. `ff539d3944`, `6bcaf278f3` and `docs/limits.md` record the finite-difference grid, fixed charge, one seeded channel,
  relative optical and acoustic outputs, and unresolved storm and plasma dynamics.
- Point 2 remains open. `lightning-breakdown.test.js` checks exact uniform-field initiation and a
  bounded propagation halt. The independent return-stroke comparison uses base current as input and
  reserves measured irradiance for scoring. The 62 m optical view rises in 0.70 μs and peaks 0.90 μs
  after the base-current peak. The fixed-speed optical precursor predicts 0.40 μs and 0.245 μs.
  Reproduce with `node packages/physics/scripts/atmo07-return-optical.mjs`.
  [Quick and Krider (2017), Figures 5, 6 and 8](https://doi.org/10.1002/2017JD027363)

### EARTH-10 four-point pass

- Point 5. `bd89d5b702`. `lava-extremes.test.js` checks coded corrections for malformed grids, unrepresentable input and ICE receipts,
  rejects an overflowing aggregate and an unresolved time step without publishing any candidate state, and samples
  TerrainBed in the live world cell. `lava-terminal.test.js` checks yielded and Newtonian discharge, nonnegative wet/dry
  columns, enthalpy and volume conservation and exact replay. `lava.test.js` checks radiation and convection with
  conductivity set to zero.
- Point 6. `99d66dbc47` and `lava-threads.test.js` compare plain Wasm and shared Wasm on one, two and four threads for
  both physical tiers, with real TerrainBed and SEA-06, a far origin shift and exact replay. Four threads update
  12,513 cells and 25,252 faces at 129 x 97, and 49,601 cells and 99,652 faces at 257 x 193 in one inertial
  microstep. `lava-threads.browser.mjs` exercises three nested helpers and exact replay in Chromium.
- Point 7. `bd89d5b702`. Weather's `lava-surface.browser.mjs` draws the accepted dry grid, timed vent, moving front and cooled crust at
  one camera on WebGPU and WebGL2. It verifies exact seek, no emission from cooled crust, detachment, and the same accepted
  solver bytes on both paths. The source supports an explicit render cell.
- Point 8. `bd89d5b702` and `99d66dbc47`. The package READMEs, `check:readme-run` and `docs/limits.md` record the inertial and terminal tiers, timestep bound, fixed
  substrate, lumped column enthalpy, static sea level and the remaining crust, tube, crystal and water feedback gaps.
- Point 2 remains open. The Dietterich et al. benchmark gives viscosity and source flux separately from the held-out
  front length and width. In BMA the terminal tier lowers the downslope normalised RMS error from 380.34% to 20.93%
  at 10 mm, but still misses seven of sixteen grid and contour bounds. The transverse error is 36.77%, with three
  missed bounds. At 5 mm the first two downslope samples and transverse widths pass the stated allowances. In BMD the
  first second still overpredicts downslope advance by 42.86 mm against a 20.55 mm allowance. Its 12 s prefix misses all
  ten downslope bounds and has 38.99% normalised RMS error. The full BMD run reached the hard timeout. Reproduce with
  `node packages/physics/scripts/earth10-lava-measured.mjs A terminal` and the same command with `D terminal 12`.
  The independent BMC flat-bed optical footprint case gives 7.43% and 2.02% normalised RMS radius error at 4 mm and
  2 mm. All fourteen fine-grid frames in the 35-100 s window meet the derived grid and contour bounds. This
  covers isoviscous spreading at the independently published input rate and viscosity. Reproduce with
  `node packages/physics/scripts/earth10-lava-measured.mjs C terminal`.
  Analytic and conservation cases cover the equations implemented here. [Dietterich et al. (2017), workbook and experiment](https://doi.org/10.1186/s13617-017-0061-x)

### FLUID-06 four-point pass

- Point 5. `2e9f76c364` and `e3bd12821b`. `viscoplastic-extremes.test.js` checks coded grid, point, rendering and material corrections, the explicit work cap,
  and both Wasm memory modes keeping their accepted bytes after a cumulative inlet overflows with real outlet motion.
  A stale destination over grown shared memory is also rejected before any accepted records can change.
  `viscoplastic-native.test.js` checks finite scalar and solver reductions, the acoustic speed overflow case and a strictly
  positive deformation gradient over the full step. A tangency and a nearby crossing fail without publishing. A nearby positive
  path matches its closed-form volume change.
- Point 6. `e3bd12821b`. `viscoplastic-threads.test.js` and `viscoplastic-threads.browser.mjs` check deterministic native phases
  against the serial bases, including live terrain, an inlet and escape, optional solvent, floating origin and replay.
  Point-to-grid scatter and implicit solvent PCG retain their original order. Work counts reflect actual material and
  occupied-node visits. Two one-substep grids verify 1,231 and 4,419 material returns and 1,170 and 3,420 occupied rows.
  Chromium starts three helpers and matches the serial state with and without solvent.
- Point 7. `2e9f76c364`. `viscoplastic-surface.browser.mjs` draws accepted material particles from a timed, finite flume inlet, through
  live TerrainBed contact, with the existing screen-space particle surface. The fixed camera sees 770, 2,323 and 2,985
  changed HDR pixels through the supplied pulse. Both renderers match the accepted state, exact rewind and replay, and
  detachment. `viscoplastic-extremes.test.js` checks compact packing and a live world-cell shift.
- Point 8. `2e9f76c364` and `e3bd12821b`. `docs/limits.md` and the runnable Physics README example document the weakly compressible single material,
  grid resolution, Coulomb friction, finite work cap, typed renderer handoff, and the remaining PA-60 sediment and scene gaps.
- Point 2 remains open. Huang and Garcia's independently specified release geometry, volume and rheology drive the kaolinite
  experiment. Twenty digitised measured front positions from the attributed replot remain held out. The 25, 20 and 10 mm
  grids meet the sampling bounds at 0, 8 and 5 observations. The final measured front is 0.739 m and the 10 mm grid reaches
  0.959 m. The released reference volume closes in all three grids. The recorded film depth is below the finest grid's
  resolution, and the solver uses Coulomb wall contact. Reproduce the 25/20 mm comparison with
  `node packages/physics/scripts/fluid06-viscoplastic-measured.mjs` and the 20/10 mm comparison with `0.02 0.01`.
  [Huang and Garcia (1998), experiment and rheology](https://doi.org/10.1017/S0022112098002845) and
  [Parvin et al. (2024), Figure 3 measured markers](https://doi.org/10.1016/j.apor.2024.104296)

### HYDRO-02 four-point pass

- Point 5. `b9f194f409` and `58bd4188d0`. `runoff-extremes.test.js` checks coded corrections for invalid dimensions, cell precision and
  spatial rain. A cumulative overflow in a real runoff tick preserves the accepted state and budget in
  plain and shared memory. A rebased spatial rain producer and accepted output retain their cell.
  `runoff-native-ranges.test.js` exercises formerly invalid Manning depths, early capillary infiltration
  with a subnormal conductivity-time product, cancellation of the stored depth near full routing, and cumulative native budget overflow.
- Point 6. `58bd4188d0`. `runoff-threads.test.js` checks exact worker partition counts, mass and accepted snapshot state
  in both Wasm memory kinds, with soil, rain and melt forcing and a far world-cell shift.
  `runoff-threads.browser.mjs` exercises the same coupled replay with three Chromium helpers.
  Four workers split 12,513 cells across 3,128/3,128/3,128/3,129 visits and 49,601 cells across
  12,400/12,400/12,400/12,401. The downstream routing and cumulative sums retain their original serial order.
- Point 7. `b9f194f409`. `runoff-surface.browser.mjs` drives upstream outlet flow and downstream flood depth from a
  timed storm on the world clock. It tests dry, rising, recession and snapshot replay on WebGPU and WebGL2.
  The inland surface renders the accepted near-edge depth with ocean blending disabled.
- Point 8. `b9f194f409` and `58bd4188d0`. The checked package README and `docs/limits.md` document fixed routing, a single soil layer,
  the drying approximation, runoff and flood receiver units, and the remaining backwater feedback.
- Point 2 remains open. The published-parameter Zhuk et al. 6 m flume comparison conserves applied
  water and matches 8 of 15 reported scale observations within the combined bounds. At 25 s the
  recorded and 48-cell volumes are 7.350 and 10.820 L, respectively. At 96 cells the largest
  deviation is 3.528 L. The procedure behind the reported Manning coefficient is unspecified.
  The independent analytic Woolhiser-Liggett rising limb agrees with the 96-cell simulation
  to 0.059 L over the rain interval. Reproduce both with `node packages/physics/scripts/hydro02-runoff-measured.mjs`
  and pass `48 96` for the finer grid comparison.
  [Zhuk et al. (2024), flume and scale observations](https://doi.org/10.1016/j.heliyon.2024.e24734) and
  [Woolhiser and Liggett (1967), analytic rising limb](https://doi.org/10.1029/WR003i003p00753)

### HYDRO-04 four-point pass

- Point 5. `4b7a50b18c` and `897e9aa010`. `landscape-extremes.test.js` checks coded grid and material corrections, finite aggregation of
  extreme cell rainfall and candidate rejection when a finite delta would exceed TerrainBed range.
  The accepted state and previous terrain contribution survive rejection and replay in both memory kinds.
  `landscape-native-ranges.test.js` covers overflow-dependent route, stiff implicit incision and transport guards.
- Point 6. `897e9aa010`. `landscape-threads.test.js` and `landscape-threads.browser.mjs` check physical and snapshot parity
  through an origin shift and multiple grain classes. All native workers count their prepared vertices and
  actual downhill links. The test counts 36,992 and 147,712 links on grids with 12,513 and 49,601 vertices.
  The ordered routing, budgets and diffusion stay serial. Biomes' `landscape.test.js`
  verifies the standard relief helper's threaded memory and accepted state.
- Point 7. `4b7a50b18c`. `landscape-surface.browser.mjs` drives a Biomes relief through the accepted landscape clock,
  traces the exposed sediment and uplift through the shared bed, and draws the evolved terrain through
  WebGPU and WebGL2. The proof includes the pending staggered bed delta and checks exact visual replay.
  The shared 61,000-year endpoint exports 113,136.59 m³. Actual terrain readback agrees within 0.061 mm.
- Point 8. `4b7a50b18c` and `897e9aa010`. The Physics README and `docs/limits.md` document the n=1 incision law, closed depressions,
  fluvial-only export, prescribed shear and grain assumptions, the bed's float32 path and relief quantisation.
- Point 2 remains open. The `hydro04-landscape-analytic.mjs` controls converge to the n=1 steady
  stream-power profile within 0.029 mm at the finer grid and to the closed hillslope within 0.133 mm.
  The steady open parabola misses: a 0.158 m drift and no exported material versus 0.480 m³ predicted
  by the continuum solution. Current fixed fluvial outlets omit the creep faces. The reviewed
  experiments infer erodibility from the same morphology or omit independent material coefficients.
  [Braun and Willett (2013)](https://doi.org/10.1016/j.geomorph.2012.10.008) and
  [Roering, Kirchner and Dietrich (1999)](https://doi.org/10.1029/1998WR900090)

## Film set first: the underwater and boat films

The solvers behind the Edmund Fitzgerald, First Wake, Below the Swell and Below the Blue Line films (problem rows EF,
FW, BS and BB in [physics-demo-review.md](physics-demo-review.md)) were audited first, whoever owns them. Each entry
below, and the "Upgrade to best" cell of each solver's row further down, leads with the single upgrade that would
most improve those films. All are THIN; none meets the eight-point standard. FLUID-03 and SOFT-01 are still CLAIMED
rows, audited because the films need them; the others are REOPENED. The ray's sand puff (`c1a005f94`) is part of
SEA-15's tracers.

| Solver | Owner | Verdict | Fails | Top upgrade for the films | Film rows it fixes |
| --- | --- | --- | --- | --- | --- |
| SEA-01 | Claude | THIN | 2, 3, 4, 5, 6 | Validated swell: propagation and dissipation of long swell checked against Ardhuin et al. 2009 (JPO) SAR swell decay, and the held-out 30 m/s Kahma–Calkoen gale as a test, so the Lake Superior gale and the long swell the ship rides have the right height and period. | EF-1, BS-6 |
| SEA-02 | Claude | THIN | 1, 2, 3, 5, 6 | An FFT cascade with choppy horizontal displacement and its Jacobian (Tessendorf 2001), with the spectrum varying across the scene, so the sea shows steep, sharp-crested swell that lifts the hull instead of small ripples. | BS-6, BS-3, EF-1, EF-5 |
| SEA-03 | Claude | THIN (close to STAND-IN for Benjamin–Feir focusing) | 1, 2, 3, 5, 6 | Dynamic focusing with a high-order spectral tier (West et al. 1987; Ducrozet et al. 2016) so a placed rogue group builds and breaks over the hull in time, as the Fitzgerald's last hours call for, instead of rogue waves existing only as statistics. | EF-11 (with EF-6) |
| SEA-04 | Claude | THIN | 1, 2, 3, 4, 5, 6 | Boundaries and hull sources: waves that reflect and diffract off quays and hulls (wavelets with obstacles, Jeschke et al. 2018) and the hull's displaced volume written in as a source, so the bow wave climbs the stem, the Kelvin wake widens and reflects off the quay, and the waterline moves. | FW-1, FW-5, FW-6, BS-4, EF-10 |
| SEA-05 | Claude | THIN | 1, 2, 3, 4, 5, 6 | Phase-resolved surge at the reef crest (a non-hydrostatic tier after Zijlema, Stelling and Smit 2011) published as the orbital velocity field that plants, sand and fish sample. | BB-2 |
| SEA-08 | Claude | THIN (strongest of the ship set) | 1, 2, 3, 4, 5, 6 | Forward-speed seakeeping (Salvesen–Tuck–Faltinsen speed terms) with deck motion published for loose props and cabins and radiated waves passed to SEA-04, so a laker at speed in following seas heaves, pitches and rolls as the gale demands and its interiors move with it. | EF-1, EF-2, EF-3, EF-10, FW-2, BS-4 |
| SEA-09 | Claude | THIN | 1, 2, 3, 4, 5, 6, 7 | The propeller race and rudder jet as a velocity field with cavitation and aeration sources for SEA-13 and SEA-15, plus empirical derivatives for other hulls (Kijima 1990) so a Great Lakes freighter is not modelled as KVLCC2. | FW-3, FW-4, BS-5, EF-9 |
| SEA-10 | Claude | THIN | 1, 2, 3, 4, 5, 6 | Submerged-hull form drag (Hoerner 1965) so a hull that has lost its buoyancy dives at its drag-limited speed (open bug KB-SEA-SINKDRAG1), then breach outflow wired to SEA-13 bubbles and SEA-15 cargo plumes. | EF-11 |
| SEA-11 | Claude | THIN | 1, 2, 3, 4, 5, 6 | Green water impact on deck structures and hatch covers (Zhou, De Kat and Buchner 1999) with flare slams from the generalized Wagner model (Zhao, Faltinsen and Aarsnes 1996), and slam spray passed to SEA-13. | EF-6 |
| SEA-12 | Claude | THIN | 1, 2, 3, 4, 5, 6 | Morison loads on soft-body rod segments so diver hoses and cables are pushed by the surge, then a buoyancy righting moment so divers and debris settle their attitude. | BS-1, FW-6 |
| SEA-13 | Claude | THIN | 1, 2, 3, 4, 5, 6 | Bubble entrainment and plumes (Deane and Stokes 2002): bubbles that rise, wobble, grow with falling pressure and drift in the orbital flow, and streaked foam and spray from breaking crests read from the live sea. | BS-2, FW-4, EF-5, EF-6, FW-1 |
| SEA-14 | Claude | THIN (close to SOUND) | 1, 2, 3, 4, 5, 6 | Surface seal, crown sheet and Worthington jet (Marston et al. 2016; Gekle and Gordillo 2010) so breaching dolphins and debris entering the sea throw the right splash. | BB-8, EF-11 |
| SEA-15 | Claude | THIN | 1, 2, 3, 4, 5, 6 | Sediment pick-up from bed stress (van Rijn 1984 pick-up with the Soulsby–Whitehouse 1997 Shields curve, and the cited Phares et al. 2000 wall-jet law) so the ray's sand puff scales with its fin beat and the grain size, plus the bed print through EARTH-01 and the taconite plume from a breached hold. | BB-7, EF-11 |
| FLUID-03 | Claude | THIN | 1, 2, 3, 4, 5, 6, 7 | Let the live sea drive the open sides of the liquid box (inflow from SEA-02 and SEA-04, outflow back to SEA-04, spray to SEA-13) so a FLIP band at the bow and on deck takes real waves. | EF-6, FW-1, BS-4 |
| SOFT-01 | Claude | THIN | 1, 2, 3, 4, 5, 7, 8 | Water as a medium in the soft kernel (buoyancy and added mass, a FlowField fed by SEA-02 orbital velocity) so hoses, cables and soft reef life sway with the surge, and cloth pinned to the moving cabin for the curtains. | BS-1, BB-1, EF-3 |
| ATMO-04 | Claude | THIN (strongest of the air set) | 1, 3, 4, 5, 6 | Rain carried by the gusty ATMO-02 wind drop by drop (not one median speed), with rings and splash sources on SEA-04 and snow fall speeds checked against Locatelli and Hobbs 1974 for squalls. | EF-7, EF-12 |
| LIFE-03 | Codex | THIN | 1, 2, 3, 4, 5, 6 | Shed the tail wake as vortex and bubble sources into SEA-13 and SEA-15, with the reached cruise speed checked against Bainbridge 1958 and Strouhal 0.2–0.4 (Taylor et al. 2003; the current setup reaches about 0.49), and divers carried by wave surge. | BB-8, BB-9, BB-5, BS-1 |
| LIFE-04 | Codex | THIN | 1, 2, 3, 4, 5, 6, 7 | Topological neighbours (Ballerini et al. 2008, k ≈ 6.5) with noise and seeds as the default, validated against Couzin et al. 2002 order parameters, so reef schools of hundreds hold together, scatter before the shark and re-form. | BB-6, BB-4 |
| BIO-01 | Codex | THIN | 1, 2, 3, 4, 5, 6 | Large-deflection flexible blades and tentacles (Luhar and Nepf 2011) driven by the SEA-02 and SEA-05 orbital velocity, with contact from fish bodies, so seagrass, kelp and anemones sway with every surge. | BS-1, BB-1, BB-2 |
| FLUID-07 | Codex | THIN | 1, 2, 3, 4, 5, 6, 7 | Contact-angle beading and drop detachment (precursor film with disjoining pressure, Schwartz and Eley 1998; drop particles, Wang, Mucha and Turk 2005) so spray and rain on the bridge windows bead, streak and run. | EF-4 |
| ATMO-06 | Codex | THIN | 1, 2, 3, 4, 5, 6 | Spindrift and squalls: spume torn from SEA-13 crests in high wind (Andreas 1998) and snow with Böhm 1989 fall speeds, dispersed by the gusty ATMO-02 field with Thomson's inhomogeneous model. | EF-12, EF-7 |
| BREAK-03 | Codex | THIN (near stand-in for ship collisions) | 1, 2, 3, 4, 5, 7 | Hull breakup: plating and girder failure (Pedersen and Zhang 1998 with friction; Smith's progressive-collapse method for the hull girder) that opens SEA-10 compartments and outputs the deformed mesh, so the hull can fail and break as the loss requires. | EF-11 |
| SEA-15 sand puff | Codex | THIN | 1, 2, 3, 4, 5, 6 | Validated pick-up (van Rijn 1984, Soulsby–Whitehouse 1997 Shields curve) replacing the constant 0.05 threshold and uncited jet factors, and the landing pit through EARTH-01. | BB-7 |

## Solvers built by Codex

Audited on 2026-11-26 against `main` from 069f20095 on: every row in the work queue with Owner Codex and Status LANDED,
plus EARTH-10, ATMO-07 and DYN-05, which landed during the audit. **Counts: SOUND 0, THIN 42, STAND-IN 0.** All 42 are
REOPENED in the work queue. Defects found on the way (as opposed to missing pieces) are logged in
[known-bugs.md](known-bugs.md) under "Open 2026-11-26: defects found by the physics solver audit".

The worst cases, where the gap is closest to the row not being met:

- **BIO-03 forest ecosystems:** the cited forest models (JABOWA, SORTIE) are not built; growth, mortality and
  seeding are uncited heuristics, nothing is validated, and the limits file does not say so.
- **ATMO-05 cyclones and vortices:** every vortex is a prescribed analytic field, not a solved flow; the cited
  Willoughby profile is not built and the presets are uncited.
- **BREAK-03 ductile crushing:** the initial station model lacked sustained support, friction, grounding,
  live plating and SEA-10 linkage. The current package supplies those on its reduced station path
  and provides a distributed triangular shell with bending, plane-stress yielding, reciprocal sphere contact
  and cohesive breakup along prescribed seams. SEA-10 consumes the actual live seam polygon for progressive
  flooding. A pretest staged rail design predicts the independent measured full-scale coach's
  longitudinal compression. Its rebound is low. The staged envelope transfers a force curve
  calibrated only from NCAP sedan test 8035 to the independent coupe trial 8104 at 55.65 km/h.
  A panel curve from Tabri model-ship trial 103 also predicts the compression work and stroke of
  separate trials 104 and 105 using published wet inertia. Peak load runs up to 12.7% high.
  The optional sphere manifold resolves both faces of a folded shell and preserves a
  single load on a shared flat edge or vertex. SEA-10 returns hydrostatic and gas
  pressure to the shell of a fixed hull before and after a live seam rupture.
  The SEA-08 inertia exchange changes a model panel from denting to rupture
  on the moving hull at the same contact speed.
  Arbitrary rigid shapes, moving-hull pressure feedback, automatic tearing,
  full-scale vessel response and broader vehicle coverage remain open.
  [Model-ship evidence](whitepaper/reproduce.md#break-03-held-out-model-ship-contacts) ·
  [Folded-shell evidence](whitepaper/reproduce.md#break-03-folded-shell-contact) ·
  [Pressure feedback](whitepaper/reproduce.md#break-03-hydrostatic-shell-feedback) ·
  [Wet hull deformation](whitepaper/reproduce.md#break-03-carried-water-and-hull-panel-rupture)
- **SEA-06 tsunamis:** there is no fault source anywhere in the code, although the clean-room record says the solver
  uses Okada deformation; run-up is only asserted to be positive.
- **ATMO-07 lightning:** no electrification and no breakdown threshold (with no space charge the path ignores the
  voltage), and a leader that runs out of room stalls silently.
- **ICE-01 snowpack:** every snowfall goes into one layer forever, so no storm-by-storm layering or weak layers
  form; a bucket model rather than the SNOWPACK model it cites.

Strongest of the set: FIRE-06 heat conduction (Fourier mode, Stefan fronts and thermoelastic closed forms),
EARTH-08 seismic waves (exact discrete dispersion, free-surface doubling), SPACE-02 ephemeris (published rotation
matrix and DE441 residuals) and HYDRO-06 groundwater (exact Dupuit), which would each have passed the earlier floor.

| Solver | Verdict | Fails | Validation (test, reference, bound) | Missing | Red flags | Upgrade to best |
| --- | --- | --- | --- | --- | --- | --- |
| SOFT-06 pressure bodies (`physics/soft` gas chambers) | THIN | 1, 2, 3, 4, 5, 7 | `soft-kernel/tests/volume.rs` "a pinned tetrahedron matches the implicit gas equation" checks the backward-Euler step (16 f32 ε), a numerical check. `gas-pressure.test.js` asserts pV constant, which holds by construction (`soft.ts` computes p = nRT/V), yet the public claim that the chamber "conserves pV" rests on it. No equilibrium or measured test. | Adiabatic or polytropic gas; inflow and vent orifices (so no airbags); tyres; filled sails (open surfaces); gas loss on tear (a torn shell stays pressurised, known-bugs; a shell split into separate pieces loses its gas instantly with no venting); ambient pressure from an atmosphere field; a hyperelastic rubber membrane. | The tautological pV test; doc comments at `soft.ts:2573` and `soft-split.ts:46` say cloth is "never split", but the code and `soft-cells.test.js` split it. | Polytropic gas with orifice flow (Wang and Nefske 1988, SAE 880654); corpuscular method as the strong tier (Olovsson 2007). Validate against the Laplace law ΔP = 2σt/R and the rubber-balloon pressure-radius peak (Müller and Strehlow 2004). Rivals: Houdini Vellum pressure, LS-DYNA airbags. |
| DYN-04 wheeled vehicles on roads (`physics` tyres, vehicle, drivetrain, motorcycle, tracked; `road/driving`) | THIN | 1, 2, 3, 4, 5, 6, 8 | Analytic and tight for the driver: `road/tests/coupling/road-driver.test.js` "Coulter goal curvature" (steer = atan(L/R) to 2⁻²⁹, target speed √(μgR) to 1e-9) and "favourable bank" (FHWA 2010 force balance, 1e-10); `road/test/driving.test.js` analytic Bekker sinkage (1e-4). Vehicle tests use arbitrary bands: braking 14-24 m against v²/2μg ≈ 17.5 m, cornering 4-13 m/s², launch 1.0-3.5 m/s. No measured tyre or vehicle data. | The tyre is the 1992 sine Magic Formula with a friction-ellipse rescale (`tyres.ts:4-7, 66-112`); MF 6.x combined-slip weighting, dfz and pressure terms, camber, aligning moment and pneumatic trail, relaxation length, rolling resistance and turn slip are absent. Horse-drawn carts absent; per-surface grip (asphalt, gravel, dirt, cobbles) is caller-supplied with no data behind "measured"; no test near the grip limit; Hoffmann/Stanley controller cited, not built; no suspension kinematics; no EARTH-05 or LIFE coupling. | Suspension stiffness is per kg of chassis, not N/m (`vehicle.ts:770`, default 5.88 at `:393`); `inverse = 10` fudge for steep normals (`vehicle.ts:762`); 6000 N force cap and 5 m travel default (`:396-397`); silent 0.2 floor on load sensitivity (`tyres.ts:98`); uncited default coefficients (`tyres.ts:48-50`); host `Math` transcendentals in state-feeding code (`tyres.ts:64-65`, `vehicle.ts:597-600`, `motorcycle.ts:160-180`, `tracked.ts:86`) that `check:pinned-math` did not scan (fixed 2026-11-28: pinned maths, and the four files are on the gate's list). | MF 6.2 (Pacejka 2012, ch. 4 and 7; Besselink, Schmeitz and Pacejka 2010, Vehicle System Dynamics 48) with the current models as the fast tier; TMeasy-class handling; kinematic suspension. Validate against Pacejka 2012's published MF sample coefficient set and ISO 4138, ISO 7401 and ISO 3888 manoeuvres. Rivals: MF-Tyre/Delft-Tyre, Chrono::Vehicle (TMeasy, SCM soil), Havok/Babylon and cannon raycast vehicles. |
| DYN-05 rail vehicle dynamics (`physics/rail`) | THIN | 1, 2, 3, 4, 5, 8 | None against published measurements (`coupling/rail.test.js`): "Polach force reduces to Kalker" checks the code's Polach formula against itself; wheel load mg/8 is exact but trivial statics; the wire sag parabola is written into the code, not solved; the roll test (0.007, arbitrary) checks the code's own spring and gives 7.4° at 1 m/s² unbalanced, which is not realistic. Joint, wet-braking and coupler tests check trends and signs. | Wheel and rail profiles, spin creep, separate wheelset lateral and yaw motion, track flexibility and lateral irregularity; a Nadal derailment check (derailment is a 52 mm side offset, `src/rail/car.ts:254,320`); messenger wire, droppers, wire bending and wind sway; arcing beyond a visual flag; coupler lateral forces, tractive-effort curve, brake-pipe dynamics. Limits omit the missing Nadal check and spin creep. | **Bug:** `signedSquare(speed)` makes the centrifugal term change sign when the car runs backwards (`car.ts:303,323`); flange force capped at the vertical load, so L/V can never pass 1 (`:290`); Hertz constant 1e8 N/m^1.5 against about 1e11 published (`:132`); creep stiffness fixed at 600 kN against about 5 MN from Kalker, load-independent and shared by both directions (`:161`); 0.35 m/s regularisation floor uncited (`:260`); bogie yaw uses the primary vertical stiffness (`:306`); roll has no gravity term (`:333-341`); a derailed car falls forever (`:254`); the wire assumes y-up (`wire.ts:150,170,227`). | FASTSIM (Kalker 1982, VSD) or Kik–Piotrowski contact on S1002/UIC60 profiles with spin creep. Validate against the Manchester Benchmarks (Iwnicki 1998), Polach 2005 measured adhesion, Kalker's coefficient tables, Klingel hunting wavelength and Wickens critical speed, the Nadal limit, EN 50318 pantograph–catenary statistics. Rivals: SIMPACK, VAMPIRE, GENSYS. |
| BREAK-03 ductile crushing (`physics/crush`) | THIN (near stand-in for ship collisions) | 1, 2, 3, 4, 5, 7 | `crush.test.js` "elastic barrier … quarter-period peak": stroke v√(m/k) and impulse 2mv (Huang 2002, eq. 4.26), 32 ε, derived. Plastic work and hardening are closed forms of its own bilinear curve; `coupling/crush.test.js` momentum (1e-6), rebound and work balance. No crash or collision data. | Plating and frame mechanics (Minorsky cited only as context); grounding and ramming geometry; the friction and sliding of Pedersen–Zhang, the core of that paper; sustained contact; automatic contact detection (patches are preset); FEM (catalog kernel K19); deformed-mesh output; SEA-10 flooding. Test materials are toy values (400 N/m, 10-40 N). | A latched contact is ignored until it clears, and the README tells users to make colliders sensors, so continued pushing passes through (`src/crush/index.ts:218-219, 251`); single-radius gate around one point (`:233`); "seal loss" is a linear stroke ratio (`:246`). | **Films:** Hull breakup: plating and girder failure (Pedersen and Zhang 1998 with friction; Smith's progressive-collapse method for the hull girder) that opens SEA-10 compartments and outputs the deformed mesh, so the hull can fail and break as the loss requires. (EF-11). Then: Full 3D Pedersen and Zhang 1998 with friction; Wierzbicki and Abramowicz 1983 super-folding mean crush force; Amdahl 1983; Simonsen 1997 grounding; FEM shells as the strong tier. Validate against NHTSA NCAP 56 km/h barrier pulses and Minorsky 1959 energy against damaged volume. Rivals: BeamNG soft-body vehicles, LS-DYNA-class shells. |
| LIFE-01 legged animals (`physics/legged`) | THIN | 1, 2, 3, 4, 5, 6 | None against published data. `legged.test.js` "bipeds walk and run" asserts the gait the hard-coded Froude thresholds select; velocity bounds ±0.05 and ±0.1 m/s are arbitrary. Exact checks (flight F/m, deck momentum, friction budget) are internal consistency. | Leg stiffness, peak force and contact time against Blickhan and Farley; duty factor; turn radius; Geijtenbeek's articulated controller (cited, not built). Propulsion is a velocity servo, so gait never emerges. `@margoengine/horses` does not use the solver. SEA-12, DYN-07 and LIFE-06 not coupled. | Hand-tuned gait tables, canter-to-gallop at Fr 6.5 uncited (`src/legged/index.ts:146-156`); 0.87 standing-height constant uncited (`index.ts:437`, `locomotion-kernel/src/lib.rs:298`); quadrupeds built as `kind: 'lizard'` (`index.ts:194`); point feet carry couples (`lib.rs:552-559`). | SLIP tier plus an articulated tier (Coros et al. 2011, SIGGRAPH; Geijtenbeek et al. 2013, TOG). Validate against Farley et al. 1993 leg stiffness vs mass, Heglund and Taylor 1988 stride frequency, Kram et al. 1997 walk-run at Fr ≈ 0.5, Tan and Wilson 2011 turning. |
| LIFE-02 limbless, insect and small-animal locomotion (`physics/locomotion`) | THIN | 1, 2, 3, 5, 6, 7 | Analytic only: `locomotion.test.js` "Hu equation 2" checks the anisotropic friction force by hand (about 256 ulp); passive leg spring and torso rest height r − g/k. Snake travel only asserted as "> 0.025 m". | Hu et al. 2009 measured snake speeds and their lift (weight-redistribution) term; sidewinding, concertina and rectilinear gaits; Schmitt–Holmes lateral leg spring; snake torque is yaw only (`lib.rs:659`); speed is servo-driven. | Template ratios 0.35/0.28/0.25/0.08 and damping 1.4 underived (`src/locomotion/config.ts:232-270`). | Guo and Mahadevan 2008 (PNAS); Marvi et al. 2014 (Science) sidewinding; Schmitt and Holmes 2000 (Biol Cybern). Validate against Hu et al. 2009 speeds, Full and Tu 1990 cockroach stride frequency, Farley and Ko 1997 lizard trot. |
| LIFE-03 aquatic locomotion (`physics/life`) | THIN | 1, 2, 3, 4, 5, 6 | Strong closed forms at 1e-12 in `coupling/swim.test.js`: Lighthill mean thrust, power and efficiency; convergence to the exact tanh speed; quadratic-drag coast; Blake drag stroke; ballistic breach; fin-lift curvature. Strouhal is checked at a chosen speed, not the reached one; the BB-4 setup reaches St ≈ 0.49, outside 0.2-0.4. | Measured data; the body is a rigid ellipsoid (the spine wave is visual only); Lighthill 1971 large-amplitude theory; muscle bodies; the tail wake has no consumer (known-bugs); SEA-12 two-way untested. The seabed sand puff (fin wakes lifting SEA-15 sediment, `c1a005f94`) is audited with SEA-15. | Max tail frequency 3 Hz regardless of size (`src/life/solver.ts:212`); fin lift servo-clamped with no induced drag (`swim-kernel/src/lib.rs:276-338`); form drag 0.1 × frontal area (`solver.ts:233`). | **Films:** Shed the tail wake as vortex and bubble sources into SEA-13 and SEA-15, with the reached cruise speed checked against Bainbridge 1958 and Strouhal 0.2–0.4 (Taylor et al. 2003; the current setup reaches about 0.49), and divers carried by wave surge. (BB-8, BB-9, BB-5, BS-1). Then: Lighthill 1971 (Proc R Soc B) large-amplitude elongated body; immersed-body coupling (Gazzola et al. 2011, JCP) as a high-fidelity tier. Validate against Bainbridge 1958 U ≈ 0.75 L f, Taylor et al. 2003 (Nature) Strouhal at reached cruise, Domenici and Blake 1997 fast-start radius. |
| LIFE-04 collective animal motion (`physics/schooling`) | THIN | 1, 2, 3, 4, 5, 6, 7 | None for emergent behaviour. Exact checks only: curvature against the lateral-acceleration bound, coast law (192 ulp), bank ratio a/g. "BB-6 predator" asserts a trend. | Couzin et al. 2002 phase diagram (swarm, torus, parallel order parameters); Ballerini et al. 2008 topological k ≈ 6.5 as the default (default is metric, all neighbours, `solver.ts:264`); noise and seeds; herds not wired to LIFE-01. | Member defaults with no basis: thrust 1 N, lateral 2 m/s², turn radius 0.2 m (`src/schooling/solver.ts:283-286`). | **Films:** Topological neighbours (Ballerini et al. 2008, k ≈ 6.5) with noise and seeds as the default, validated against Couzin et al. 2002 order parameters, so reef schools of hundreds hold together, scatter before the shark and re-form. (BB-6, BB-4). Then: Calovi et al. 2014 (New J Phys); Hemelrijk and Hildenbrandt 2011 (PLoS ONE); Vicsek et al. 1995 noise. Validate against Couzin 2002 polarization and milling, Ballerini 2008 anisotropy, Katz et al. 2011 measured interaction forces, Cavagna et al. 2010 correlations. Rival: GPU boids at 10⁵ agents. |
| LIFE-05 pedestrians and dense crowds (`physics/pedestrians`) | THIN | 1, 2, 3, 4, 5, 6 | The force solver has no emergent validation: `coupling/pedestrians.test.js` checks its own discretisation (paired impulses, sliding damping, Karamouzas gradient). Default k and κ are Helbing et al. 2000's values. The Weidmann check (`navmesh/test/crowd-density.test.js`, ±15% + 0.03) runs on the ORCA crowd that imposes the Weidmann curve, so it is near-circular. | Fundamental diagram and bottleneck flow from the force solver; Narain et al. 2009 incompressibility (replaced by a documented heuristic, `pedestrian-kernel/src/lib.rs:371-375`); fallen walkers and injury; LIFE-06 and BREAK-05 coupling. The "early sketch" charge is unfair: the contact law and anticipation force are real, cited physics. | Reaction offset 0.15 s not in Karamouzas (`lib.rs:230`); anticipation default 1 not tied to the paper (`solver.ts:379`); drive acceleration cap 3 (`solver.ts:215`). | Narain et al. 2009 tier; Chraibi et al. 2010 (PRE); Tordeux et al. 2016. Validate against Seyfried et al. 2005 single file, Zhang et al. 2011 corridor, Seyfried 2009 and Kretz 2006 bottleneck flow vs width, Garcimartín et al. 2014 faster-is-slower. Rivals: JuPedSim and Vadere model sets. |
| AERO-05 falling and tumbling light bodies (`physics/falling`, `weather` hail) | THIN | 1, 2, 3, 5, 7 | "reproduces APW Figure 3 flutter and period-one tumbling" classifies the regime only; samara rpm-per-descent bound 1200-1500 read from Rezgui Fig. 12 (derived from plot divisions — good); `weather/tests/precipitation.test.js` Heymsfield–Wright 2014 hail laws within 8% (band not derived); quadratic tanh fall (analytic). | 3-D plate tumbling (the plate stays in a fixed plane); samara coning and a free axis; Reynolds-dependent sphere drag; leaf, ash, snowflake and feather presets the row names. | Sphere Cd 0.47 at every Reynolds number (`src/falling/model.ts:254`). | Free samara (Varshney, Chang and Wang 2012, Nonlinearity); 3-D plate (Andersen, Pesavento and Wang 2005 extended to 3-D). Validate against Field et al. 1997 (Nature) falling-disk phase diagram, Belmonte et al. 1998, Lentink et al. 2009 descent speeds, Heymsfield and Westbrook 2010. |
| SEA-06 tsunami and impulse waves (`physics/tsunami`) | THIN | 1, 2, 3, 4, 5, 6, 7, 8 | `tsunami.test.js` "wetting fan tracks Ritter's shallow-water benchmark" (about 5% of depth, derived) and "travel follows sqrt(gh)" (about 9% of distance). The Heller–Hager test picks inputs that set F, S and M to 1 (`tests/tsunami.test.js:144-160`), so it only checks two factors. | **Okada fault deformation is not implemented anywhere**, yet `docs/clean-room.md` (SEA-06 section) says the solver uses deformation "computed from the natural source model"; inundation only asserted as run-up > 0; no dispersion; ships and bodies not forced. | The clean-room overclaim above; the Heller–Hager test inputs. | Okada 1985/1992 (BSSA) fault source; Boussinesq dispersive tier (Madsen and Sørensen 1992). Validate against Synolakis 1987 (JFM) solitary run-up, Carrier and Greenspan 1958, Briggs et al. 1995 conical island, the Monai valley laboratory case. Rivals: GeoClaw, Celeris (WebGPU Boussinesq), Tsunami-HySEA. |
| FLUID-06 viscoplastic fluids (`physics/viscoplastic`) | THIN | 1, 2, 3, 4, 5, 6, 7 | Constitutive only: `viscoplastic.test.js` Bingham and Herschel–Bulkley one-step stress return against its closed form (512 ulp, derived); free-fall kinematics. No flow is compared with published numbers; Huang and García 1998 is cited but never tested. | Any flow benchmark (plug flow, slump, dam break); a depth-averaged fast tier; bed entrainment (PA-60, known-bugs); two-way coupling (the mud never changes the bed or pushes bodies). | Solvent face weight min(mᵢ, mⱼ)/(ρh³) underived (`viscoplastic-kernel/src/lib.rs:501,533`); friction default 0.25 uncited (`src/viscoplastic/index.ts:289`). | Variational implicit viscosity (Larionov, Batty and Bridson 2017, SIGGRAPH); depth-averaged Herschel–Bulkley fast tier (Huang and García 1998). Validate against Bingham plug flow, Roussel and Coussot 2005 slump spread, Cochard and Ancey 2009 viscoplastic dam break, Ribe 2004 rope coiling. Rival: Houdini FLIP viscosity and MPM codes (coiling, buckling). |
| FLUID-07 thin films and droplets (`physics/thin-film`) | THIN | 1, 2, 3, 4, 5, 6, 7 | `thin-film.test.js` "hydrostatic plus capillary damping matches the closed-form discrete Fourier mode" (lubrication linear decay, derived bound) and "Nusselt gravity flux" ρgh³/3μ (32 ulp). Both analytic; no measured case. | Contact-angle dynamics and beading (Wang et al. 2005's core) are replaced by a scalar pinning deadband; pendant drops never detach ("drips" are edge outflow); film mass does not load its body. | Pinning threshold is a grid-scaled pressure deadband, not a contact-angle law (`thin-film-kernel/src/lib.rs:237,298`). | **Films:** Contact-angle beading and drop detachment (precursor film with disjoining pressure, Schwartz and Eley 1998; drop particles, Wang, Mucha and Turk 2005) so spray and rain on the bridge windows bead, streak and run. (EF-4). Then: Precursor film with disjoining pressure (Schwartz and Eley 1998, J Colloid Interface Sci) plus drop particles (Wang, Mucha and Turk 2005). Validate against Huppert 1982 (Nature) incline front t^(1/3), Tanner's law 1979, Furmidge 1962 retention. |
| HYDRO-02 rainfall-runoff and infiltration (`physics/runoff`) | THIN | 1, 2, 3, 4, 5, 6, 7 | `coupling/runoff.test.js` "Green-Ampt follows the two-stage integrated ponding solution" (Mein–Larson, analytic, ulp-derived) and the linear-store exp(−kt) balance. The Manning check is steady state only. | No hydrograph check (rising limb, equilibrium time, wave speed); routing is a backward-Euler cell-reservoir chain; TOPMODEL's exponential baseflow is replaced by a linear store; the HYDRO-01 link is one-way (no backwater). | Uncited wetting-front redistribution `front *= remaining_soil / stored_before_dry` (`runoff-kernel/src/lib.rs:234`). | Local-inertial routing (de Almeida et al. 2012, WRR) and a 1-D Richards tier. Validate against Woolhiser and Liggett 1967 plane hydrograph, the tilted V-catchment (Maxwell et al. 2014, WRR), Philip 1957 infiltration. Rivals: Landlab OverlandFlow, HEC-HMS, ParFlow. |
| HYDRO-03 sediment and channel morphodynamics (`physics/sediment`) | THIN | 1, 2, 3, 4, 5, 6, 7 | `coupling/sediment.test.js`: Wong–Parker bedload rating, van Rijn settling in three regimes, Rouse P = 1 integral (2e-9, quadrature-derived), Exner basin settling. Published formulas, but transcription checks, not flume data. | Meanders (no secondary flow, no transverse bed-slope term, no migration-rate check against Ikeda, Parker and Sawai); deltas never validated; one grain size; floods never write back to BIO-03. | Bank excess velocity is taken against the mean of every wet cell in the domain, not the reach (`sediment-kernel/src/lib.rs:396,438`), so it is wrong on floodplain grids. | Engelund 1974 secondary flow, Talmon et al. 1995 bed slope, Wilcock and Crowe 2003 mixed sizes. Validate against Struiksma et al. 1985 point bars, Soni et al. 1980 aggradation, Kostic and Parker 2003 delta. Rivals: Delft3D, TELEMAC-SISYPHE, BASEMENT. |
| HYDRO-04 landscape evolution (`physics/landscape`) | THIN | 1, 2, 3, 4, 5, 6, 7 | Only scheme self-consistency on 2×2 grids (`coupling/landscape.test.js` backward-Euler incision and single-face diffusion against their own formulas). No analytic steady state. | Slope exponent n ≠ 1 (Braun and Willett handle it); lakes and depression routing; no EARTH-06 crater coupling test. | Channel width = cell area / flow length, no hydraulic geometry (`landscape-kernel/src/lib.rs:408`); flow-split exponent 1.1 hard-coded (`:96`, cited to Freeman 1991). | Newton solve for n ≠ 1 (Braun and Willett 2013), erosion–deposition (Yuan et al. 2019, JGR Earth Surface), priority-flood lakes (Barnes et al. 2014), nonlinear hillslope (Roering et al. 1999). Validate against the steady profile S = (U/K)^(1/n) A^(−m/n), the parabolic hillslope, Hack's law, Hasbargen and Paola 2000. Rivals: FastScape, Landlab. |
| HYDRO-06 groundwater and springs (`physics/groundwater`) | THIN (closest to SOUND) | 1, 2 (partial), 3, 4, 5, 6, 7 | `coupling/groundwater.test.js` "fixed aquifer edges reproduce the exact steady Dupuit solution and discharge" (analytic; 2e-12 bound tight but arbitrary); recharge, harmonic contact and drain closed forms. | Every catalog piece is built and tested. Missing for the standard: a transient analytic check, multiple layers and confined aquifers, wells, backflow from surface water. | None found. | Multi-layer confined and unconfined flow with wells. Validate against Theis 1935 drawdown, Rupp and Selker 2006 recession, the MODFLOW test problems. Rivals: MODFLOW 6, ParFlow. |
| ATMO-05 tropical cyclones and large vortices (`physics/vortices`) | THIN (close to STAND-IN) | 1, 2, 3, 4, 5, 6, 7 | `coupling/vortices.test.js` "Rankine compact pressure and velocity obey cyclostrophic balance" (exact closed form, 64 ε, derived). "PA-31" only compares Holland against Margo's own Sky `hollandPressure` (self-consistency). Burgers–Rott never checked against its closed form; no measured storm profile. | Every vortex is a prescribed field, not solved. Willoughby et al. 2006 profile (cited, not built); Fiedler–Rotunno structure; track asymmetry; intensity that changes over time; updraft–inflow continuity. Dust devils, waterspouts and fire whirls are untested presets. BREAK-02 and ATMO-06 untested. | Preset deficits and updrafts (15/5/4/9 m/s) uncited (`src/vortices/model.ts:78-84`); kinematic, not mass-consistent updraft (`model.ts:243`); drag coefficient capped at 33 m/s gives about 2.96e-3, above the published saturation (`model.ts:253`). | Willoughby, Darling and Rahn 2006 (MWR) profiles, Kepert 2001 (JAS) boundary-layer inflow, Vatistas 1991 family, Fiedler and Rotunno 1986 (JAS) as a dynamic tier. Validate against Wurman and Gill 2000 Doppler-on-Wheels tornado profiles, Powell et al. 2003 (Nature) drag, Sinclair 1973 dust devils. Rival: CM1. |
| ATMO-06 airborne particle transport (`physics/airborne`, 66-line Rust kernel) | THIN | 1, 2, 3, 4, 5, 6 | `airborne.test.js` "Stokes and buoyancy give the analytic settling and relaxation trajectories" (closed-form exponential relaxation with Davies slip, 1024 ulp, derived from float precision); OU gust mean and variance (Thomson homogeneous case, 6σ sampling bound, derived); salt equilibrium against Petters and Kreidenweis 2007 κ = 1.12 (published constant). The d² evaporation test re-derives the code's own formula. No measured data. | The kernel is the right size: an exact exponential integrator for frozen drag plus the d² law. Missing from the row: ash (Costa et al. 2006), embers (Sardoy et al. 2007: burning, mass loss, landing temperature), snow, seeds and small debris (only spheres of dust, mist and spray exist); inhomogeneous turbulence (only Thomson's homogeneous case, uniform RMS and time scale, no ATMO-01 turbulence field); bounce and resuspension; spray moisture and cooling returned to the air. | Vapour diffusivity fixed at 2.5e-5 m²/s for all temperatures (`src/airborne/environment.ts:76`); drying uses saturation at air temperature, not droplet wet-bulb temperature, and no ventilation factor, so drying rates are off in both directions. | **Films:** Spindrift and squalls: spume torn from SEA-13 crests in high wind (Andreas 1998) and snow with Böhm 1989 fall speeds, dispersed by the gusty ATMO-02 field with Thomson's inhomogeneous model. (EF-12, EF-7). Then: Thomson 1987 inhomogeneous well-mixed model with drift; Haider and Levenspiel 1989 non-spherical drag; Böhm 1989 and Heymsfield and Westbrook 2010 snow fall speed; Sardoy 2007 embers; Ranz and Marshall 1952 ventilation and wet-bulb evaporation. Validate against Gunn and Kinzer 1949 terminal velocities and Project Prairie Grass dispersion (Barad 1958). Rivals: HYSPLIT, FLEXPART. |
| ATMO-07 lightning and atmospheric electricity (`physics/lightning`) | THIN | 1, 2, 3, 4, 5, 6, 7, 8 | `coupling/lightning.test.js` "solves the Laplace and uniform-charge Poisson solutions between planes" (exact parallel-plate potential, derived bound plus a tiny arbitrary 1e-8) — validates the field solve only, not the lightning. The thunder test compares against Margo's own `OutdoorSound`. | Cloud electrification (charge is a static input, though the row says atmospheric electricity); a breakdown threshold field (with no space charge the path does not depend on voltage, `src/lightning/index.ts:224`); bidirectional and upward connecting leaders; return-stroke current waveform; subsequent strokes and cloud-to-cloud flashes; field outputs (Sky and thunder receive JavaScript copies); no unit test file. | Branching exponent 2 uncited, Niemeyer used 1 (`index.ts:230`); thunder weights 1 and 0.25 uncited (`:466`); ad hoc brightness curve (`:567`); a leader that runs out of candidates stalls silently with no flash or error (`:482-484`); `returnSpeed` not bounded by c (`:229`); Jacobi with about 10,000 sweeps re-run every growth step instead of the K12 PCG or multigrid (`:234`). | Stochastic leader with threshold and neutrality (Mansell et al. 2002, JGR); fractal model (Riousset et al. 2007, JGR); Rakov and Uman 1998 return-stroke engineering models with the Heidler current; Ribner and Roy 1982 (JASA) thunder; non-inductive charging (Takahashi 1978; Saunders et al. 1991) fed from ATMO-03. Validate against Tsonis and Elsner 1987 fractal dimension, Idone and Orville 1982 return-stroke speed, Berger et al. 1975 currents, Few 1969 thunder spectrum. Rival: Kim and Lin 2007 (TVCG) fast lightning. |
| ATMO-08 fog and cold-air drainage (`physics/drainage-fog`) | THIN | 1, 2, 3, 5, 7, 8 | `coupling/drainage-fog.test.js` one-step closures against its own formulas (energy budget to 7e-11, Stokes settling, g′·slope acceleration, entrainment ledger): analytic but tautological. Nothing against Manins–Sawford speeds or the Cabauw fog case. | Vertical structure and turbulence (Duynkerke 1991 is a multi-level model); longwave cooling dependent on liquid water path and fog top; dew onto the ground. **No `docs/limits.md` entry.** | Drag 0.008, entrainment 0.02 and emissivity 0.15 defaults underived (`src/drainage-fog/index.ts:314-316`); grey emissivity independent of liquid water (`drainage-fog-kernel/src/lib.rs:390`). | Duynkerke 1991-style column with Stephens 1978 emissivity and MYNN closure (Nakanishi and Niino 2006). Validate against Prandtl 1942 slope flow, Manins and Sawford 1979, Cabauw 1977 fog, ParisFog (Haeffelin et al. 2010, BAMS). |
| ATMO-09 surface energy balance (`weather/surface-energy`) | THIN | 1, 2, 3, 4, 5, 6 | `coupling/surface-energy.test.js` backward-Euler heat budget (derived roundoff bound; checks the integrator) and exact Fosberg 1-h and 10-h response; `weather/tests/fuel-moisture.test.js` reproduces Simard's NFDRS regressions to 1e-7 (published). No FAO-56 ET₀ check, no measured flux data. | SnowModel is cited but reduced to one snow-water bucket (no cold content, albedo decay, sublimation, layering); no ground heat conduction (a fixed deep temperature); one patch per solver, no gridded field; no FIRE-01 coupling test. | Heat capacity 250,000 J/(m²K) and ground conductance 5 W/(m²K) uncited (`weather/src/surface-energy.ts:288-289`); precipitation sampled at `tick·dt` while other solvers use `(tick+1)·dt` (`:331`). | CLM5 multi-layer soil and snow (Lawrence et al. 2019) or force-restore (Deardorff 1978, JGR). Validate against FAO-56 Example 18, FLUXNET or Cabauw energy-balance closure, SnowMIP (Etchevers et al. 2004). |
| EARTH-07 aeolian transport (`physics/aeolian`) | THIN | 1, 2, 3, 4, 5, 7 | `coupling/aeolian.test.js` checks one-step formulas: "snow at its measured equilibrium flux follows Pomeroy and Gray, equation 11" reproduces the equation (128 ε) despite "measured" in the name; the Bagnold threshold check tests only which side of the threshold the flux falls; avalanche relaxation has a derived bound. | Grain speed from the drag balance (fixed at 1.5 m/s); two-way ATMO-01 wind sink (drag is exported, nobody consumes it); suspension; vegetation. | Fixed 1.5 m/s grain speed (`src/aeolian/index.ts:307`); arbitrary one-grain seed (`aeolian-kernel/src/lib.rs:324,388`); dust efficiency 0.001 m⁻¹ a mid-range pick (`index.ts:330`). | Durán and Herrmann 2006 vegetation; Kok et al. 2012 grain speed. Validate against Creyssels et al. 2009 (JFM) flux ∝ u*², Andreotti et al. 2010 saturation length, barchan speed ∝ 1/H (Hersen et al. 2002; Elbelrhiti et al. 2005, Nature), ripple wavelength. Rival: ReSCAL. |
| EARTH-08 seismic waves and ground shaking (`physics/seismic`) | THIN (SOUND on the earlier floor) | 1, 2, 3, 4, 5, 7 | `coupling/seismic.test.js` "native P and SV branches match the staggered-grid dispersion relation" (exact discrete, 128 ε); traction-free surface doubling (derived 1/48 bound); layer amplification under the impedance bound; Brune moment closed form. No Lamb or Garvin solution, Rayleigh speed or recorded motion. | SH waves and 3-D; a PML (Komatitsch and Tromp 1999 cited, a sponge used); intrinsic attenuation Q; pore-pressure build-up (liquefaction is a flag); EARTH-02 and BREAK-02 coupling; placeable fault rupture. | Sponge damping about twice the Collino–Tsogka form, heuristic (`src/seismic/index.ts:345`). | 3-D fourth-order staggered grid (Graves 1996, BSSA), C-PML (Komatitsch and Martin 2007, Geophysics), viscoelastic Q (Robertsson et al. 1994), PM4Sand (Boulanger and Ziotopoulou 2017). Validate against Garvin 1956, SCEC LOH.1 (Day et al. 2001), NGA-West2 records. Rivals: SPECFEM, SW4. |
| EARTH-10 lava flow (`physics/lava`) | THIN | 1, 2, 3, 4, 5, 6, 7, 8 | None against published data: `lava.test.js` checks implicit Newtonian drag, the Hulme / Buckingham–Reiner Bingham discharge, one basal-cooling step and the conduction stencil against the kernel's own formulas; coupling tests check volume and enthalpy ledgers (conservation). | Crust is column depth × solid fraction, one temperature per column, no growing crust layer (`lava-kernel/src/lib.rs:363`); levees are placed cold in the test, not formed (`lava.test.js:155-167`); no viscous heating although the clean-room record cites Costa and Macedonio equations that include it; no crystal-dependent viscosity; no lava tubes; water coupling one-way; no renderer reads the output. `docs/limits.md` omits the lumped crust and fixed-temperature ground. | Uncited defaults for viscosity, yield and their rise, convection 20 W/(m²K), skin depth 0.02 m, water transfer 250 W/(m²K) (`src/lava/index.ts:310-331`); basal conduction into a fixed-temperature ground that never warms (`lib.rs:366`); wet/dry uses a fixed `seaLevel`, not the live SEA-06 surface (`lib.rs:364,527`); `conductivity: 0` also turns off radiation (`lib.rs:359`); source radius 1.5 × spacing uncited (`lib.rs:555`). | Costa and Macedonio 2005 (GRL) with viscous heating; Bernabeu, Saramito and Smutek 2016 vertical cooling; Giordano, Russell and Dingwell 2008 (EPSL) melt viscosity. Validate against Huppert 1982 viscous spreading, Balmforth et al. Bingham slump, the Cordonnier et al. 2016 and Dietterich et al. 2017 lava benchmarks, Garel et al. 2012 cooling, FLOWGO Mauna Loa 1984. Rivals: MAGFLOW, VolcFlow, GPUSPH lava, MrLavaLoba. |
| ICE-01 snowpack (`physics/snowpack`) | THIN | 1, 2, 3, 4, 5, 7 | None against measured data: `coupling/snowpack.test.js` re-derives one step of the code's own Lehning viscosity, Pomeroy–Gray flux, Mohr–Coulomb ratio, conduction and enthalpy closure (256 ε). Self-consistency. | Layers are never created or split: all snowfall enters layer 0 (`snowpack-kernel/src/lib.rs:238`), so no storm-by-storm layering; no grain metamorphism or weak-layer growth; heat is prescribed rather than from a surface energy balance; no suspension or blowing-snow sublimation (in Lehning 2008); no crack-propagation stability. The outside "early sketch" charge is fair here: a bucket model inspired by SNOWPACK. | Cornice capture 0.05 and drift threshold 0.2 m/s fixed defaults (`src/snowpack/index.ts:344-345`); conductivity extrapolated linearly from Sturm's range to ice (`lib.rs:102`). | Lagrangian layers with grain metamorphism (Vionnet et al. 2012, GMD, Crocus; Lehning et al. 2002, CRST), Richards water flow (Wever et al. 2014), suspension and sublimation (Lehning et al. 2008). Validate against Col de Porte depth and SWE (Lejeune et al. 2019, ESSD) and Weissfluhjoch. Rivals: SNOWPACK, Crocus. |
| ICE-02 glacier and ice-sheet flow (`physics/glacier`) | THIN (closest to SOUND of the ice set) | 1, 2, 3, 5, 6, 7 | `glacier.test.js` "oblique linear slopes match the closed-form depth-averaged Glen velocity" (Greve and Blatter, 24 ε) and "positive surface extension produces Nye depth" (64 ε). Derived bounds, but static; no time-dependent exact solution though Bueler 2005 is cited. | Basal sliding, thermomechanics, ice shelves, longitudinal stress; calving removes a whole cell; one lagged solve with no nonlinear iteration (`glacier-kernel/src/lib.rs:145`, stated in limits). A correct but reduced model, not a sketch. | Strain rate fed to Nye comes from a model without longitudinal stress (`lib.rs:325-331`). | Hybrid SIA/SSA with sliding (Bueler and Brown 2009, JGR), Blatter–Pattyn higher-order tier, enthalpy thermodynamics (Aschwanden et al. 2012, J Glaciol). Validate against the Halfar 1981 dome, Bueler et al. 2005 tests B-E, EISMINT (Huybrechts et al. 1996), MISMIP. Rivals: PISM, Elmer/Ice, ISSM. |
| ICE-03 iceberg dynamics and calving (`physics/iceberg`) | THIN | 1, 2, 3, 5, 6, 8 | Archimedes draft (analytic, ε); heave against ω = √(g/αH) with a derived Verlet phase bound. Capsize only brackets Burton's critical aspect ratio between 1/4 and 5/4; no capsize time, energy or wave amplitude against Burton et al. 2012. | Added mass (stressed by Burton 2012 and not stated in limits); Coriolis and wave-radiation damping; non-cuboid shapes; melt from water temperature and flow (it is a prescribed rate); berg fracture. | Cd = 1 for water and air, uncited (`src/iceberg/index.ts:215,218`). | Added mass and radiation damping (Wagner et al. 2017, Ocean Modelling); melt from Bigg et al. 1997 and FitzMaurice et al. 2017. Validate against Burton et al. 2012 capsize durations and wave amplitudes. |
| ICE-04 pack ice and floes (`physics/pack-ice`) | THIN | 1, 2, 3, 4, 5, 6 | "Vella equation 12" checks the published ridging formula and its published 0.12-0.21 m range; restitution impulse closed form. Formula and conservation checks, not pack behaviour. | Floes never split; ship–ice resistance not compared with Lindqvist or model-basin data; no wave–ice interaction, Coriolis, ICE-05 thermodynamics or bonded level ice. Reduced, not a sketch. | Restitution 0.15 and friction 0.3 uncited (`src/pack-ice/index.ts:345-346`); ad hoc fracture work σ·w·h·cut in `pile()` (`pack-ice-kernel/src/lib.rs`). | Bonded-particle breakage (Herman 2016, GMD); polygonal floes (Manucharyan and Montemuro 2022, JAMES, SubZero). Validate against Lindqvist 1989 resistance and Herman 2011 cluster statistics. Rivals: SubZero, DEM ice codes. |
| ICE-05 ice thermodynamics (`physics/ice`) | THIN | 1, 2, 3, 4, 5, 6 | `ice.test.js` "UNESCO freezing-point depression" at S = 35 against −1.922 °C, ±0.0005 (table rounding, derived) — published; Stefan quasi-steady growth (analytic). The Murphy–Koop 250 K value is the formula's own output. | Brine and salinity profile, internal heat storage (Maykut–Untersteiner), surface energy balance; icicle heat transfer fixed at 10 W/(m²K) rather than Makkonen's Nusselt correlations; frost densification; TypeScript only; the coupling test uses stand-ins only. | Above-freezing surfaces melt by running the Stefan solution backwards, so thick ice melts slower — not physical, and `ice.test.js:30` locks it in (`src/ice/model.ts:191`); both h = 10 defaults (`model.ts:61-63`). | Bitz and Lipscomb 1999 (JGR) energy-conserving brine thermodynamics; Makkonen 1988 wind-derived heat transfer. Validate against Maykut–Untersteiner equilibrium thickness and SHEBA mass-balance buoys. Rival: CICE Icepack. |
| FIRE-06 heat conduction and phase change (`physics/thermal`) | THIN (strongest validation of the Codex set) | 1, 2, 3, 4, 5, 6 | `coupling/thermal.test.js` "insulated slab follows the Fourier cosine mode" (Carslaw and Jaeger, derived space-time bound); "melt and freeze fronts follow the one-phase Stefan solution" (to 1/nx); series-resistance wall; two-cell implicit eigenmode. `thermal-stress.test.js`: affine expansion, restrained bar, hydrostatic stress (analytic). | Mushy solidus–liquidus range (the Voller–Prakash subject itself); temperature-dependent k and c; melt convection; kiln and turbofan scene integrations (known-bugs). | Implicit step only tolerates dt·G ≤ 2C: substepped fixed-point iteration, not a large-step implicit solve (`src/thermal/solver.ts:68`); ports published at fixed cell [0,0,0], ignoring the world cell, so no floating origin (`solver.ts:231-233`). | Enthalpy-porosity mushy zone (Voller and Prakash 1987) with a Kirchhoff transform; multigrid or CG implicit solve. Validate against Gau and Viskanta 1986 gallium melting, the two-phase Neumann solution, NAFEMS thermal benchmarks. |
| SOUND-01 outdoor propagation (`physics/outdoor-sound`) | THIN | 1, 2, 3, 4, 5, 7 | `coupling/outdoor-sound.test.js` "air absorption agrees with ISO 9613-1 Table 1(e)": 6.83 dB/km at 0 °C, 1 kHz, 50% RH, ±0.005 (the printed rounding) — published. Delay with wind, ray bow and rigid image source are closed forms. The ridge diffraction test compares the solver to its own function. | Ground impedance (reflection factor is a real scalar, `src/outdoor-sound/index.ts:41,322`; no Delany–Bazley ground or spherical-wave correction); upwind shadow zone (refraction bends the path but never changes level without terrain); multiple-edge diffraction and ground reflection on a diffracted path (`index.ts:301`); turbulence; the N-wave is a prescribed shape never propagated (`model.ts:49-63`). FIRE-04 not wired. | Diffraction uses the radio formula ITU-R P.526 rather than an acoustic barrier model (`model.ts:40-46`); gradient sampled once at the midpoint (`index.ts:252-262`). | Attenborough 2011 ground impedance with the Chien–Soroka 1975 reflection coefficient; Hadden and Pierce 1981 wedge diffraction; GFPE refraction (Salomons 2001); sonic-boom propagation (Rallabhandi 2011). Validate against Attenborough et al. 1995 (JASA) benchmarks and the full ISO 9613-1 table. Rival: NoiseModelling (CNOSSOS-EU). |
| SOUND-02 enclosed and urban acoustics (`physics/room-sound`, 66-line Rust kernel) | THIN | 1, 2, 3, 4, 5, 6 | `room-sound.test.js` "a sealed box matches the direct and six independent Allen–Berkley first-order paths" (analytic, ulp bounds); "a rigid closed axis follows the discrete Neumann standing mode" (exact discrete dispersion of the scheme, 500 ulp); Eyring decay and Schroeder integral (analytic). `coupling/room-sound.test.js` slot diffraction equals the exact stencil path count 16 · 0.25¹⁰. Wall impedance is only checked qualitatively ("higher absorption loses energy"); no measured room. | The kernel is the right size for what it does: a correct 7-point leapfrog with Bilbao–Hamilton locally reacting walls. Missing: frequency-dependent wall impedance (the wave solver is single-band); Hamilton and Bilbao 2017's high-order schemes (only its second-order baseline is built); Raghuvanshi and Snyder 2014 parametric encoding (cited as motivation only); edge diffraction on geometric paths; a late tail beyond the Eyring formula; ISO 9613-1 air absorption; absorbing open boundaries for canyons (grid edges are walls); live EARTH-02 geometry (known-bugs). | Default reflection 0.85 uncited (`src/room-sound/wave.ts:217`); λ is halved until λ√3 ≤ 1 (`wave.ts:235`), which can land well below the stability limit and raise dispersion error. | High-order or interpolated schemes (Hamilton and Bilbao 2017, IEEE TASLP); frequency-dependent boundaries (Bilbao, Hamilton, Botts and Savioja 2016, JASA); hybrid late tail (Vorländer 1989); BTM edge diffraction (Svensson, Fred and Vanderkooy 1999). Validate against the BRAS database (Aspöck et al. 2019) and ISO 3382 measured RT and EDT. Rivals: Steam Audio and Resonance Audio (frequency-dependent materials, baked reverb), Project Acoustics (baked wave simulation). |
| SOUND-03 underwater acoustics (`physics/underwater`) | THIN | 1, 2, 3, 4, 5, 6, 7 | `underwater.test.js`: homogeneous Porter–Bucker Gaussian beam (width, curvature, phase, absorption), circular Snell arc and turning point, curvature kick at a layer kink, surface −1 sign, repeated bottom reflections. Closed forms, 200-700 op × ε, derived. | No beam summation into a pressure field or transmission loss; no eigenrays or receivers; 2-D beam without 1/√r point-source spreading; constant dB/km absorption; signed scalar reflections, not angle-dependent Rayleigh bottom loss; no range-dependent bathymetry; no sound speed from temperature and salinity; coupling test uses a stand-in reader; JavaScript only. | None beyond scope; limits states the gaps. | Gaussian-beam summation with cylindrical spreading (Porter and Bucker 1987, JASA); Francois and Garrison 1982 absorption; Mackenzie 1981 sound speed. Validate against the Munk profile, the Pekeris waveguide, the ASA wedge benchmark (Jensen and Ferla 1990). Rivals: BELLHOP and KRAKEN. |
| SOUND-04 contact and modal sound (`physics/modal-sound`) | THIN | 1, 2, 3, 4, 7 | `coupling/modal-sound.test.js` "produces FoleyAutomatic Eq. 1" (every sample of the analytic damped sine, ±8e-9, f32-derived) and the analytic roughness convolution (±5e-11). Both check the resonator against its own model; no measured modes. | Wood, metal, glass and bell are authored tables (`src/modal-sound/material.ts:35-77`); scrape and roll texture is four fixed sinusoids (`modal-sound.ts:45-46`); no modes from geometry, contact-point mode shapes, Hertz force pulse or acoustic radiation; only DYN-01 is wired (BREAK-01, SEA-14, FLUID-01, FIRE-02, ATMO-07 missing). Output is normalised PCM, not pressure. | Authored constants presented as materials; impact threshold 0.25 m/s and rolling resistance 0.025 (`world/solvers/rigid.ts:262-263`). | FEM modal analysis (O'Brien, Shen and Gatchalian 2002, SCA); acoustic transfer (James, Barbič and Pai 2006, SIGGRAPH); acceleration noise (Chadwick, Zheng and James 2012); materials fitted from recordings (Ren et al. 2013, TOG). Validate against Euler–Bernoulli bar and Leissa 1969 plate frequencies and Rossing bell partials. |
| BIO-01 plant mechanics under wind and water (`physics/vegetation`) | THIN | 1, 2, 3, 4, 5, 6 | "PlantSway resolves both analytic cantilever frequencies": β = 1.8751 and 4.6941 Euler–Bernoulli frequencies to 2e-12 (quadrature-exact, derived). Taper, wet, windthrow and rupture are unvalidated. | Branch topology (Habel et al. 2009); large-deflection reconfiguration for kelp and grass; turbulence spectrum (Stam 1997); windthrow takes a user anchor moment rather than computing it ForestGALES-style; self-weight P-Δ only in water (`src/vegetation/model.ts:249`); FIRE-04 and EARTH-02 untested. | Cd = 1 default (`model.ts:195`); small-angle modes used for kelp. | **Films:** Large-deflection flexible blades and tentacles (Luhar and Nepf 2011) driven by the SEA-02 and SEA-05 orbital velocity, with contact from fish bodies, so seagrass, kelp and anemones sway with every surge. (BS-1, BB-1, BB-2). Then: Large-deflection blades (Luhar and Nepf 2011, L&O); branch hierarchy (Habel et al. 2009). Validate against Moore and Maguire 2004 (Trees) tree frequencies and Gardiner et al. 2000 critical wind speeds. Rival: SpeedTree wind. |
| BIO-02 plant growth (`biomes/growth`) | THIN | 1, 2, 3, 6 | None against measurements: branching angle, pipe-model area and shadow decay are construction checks. | Branch shedding; one internode per bud per season with excess vigour discarded (`biomes/src/growth.ts:437`); Pirk plastic re-bending; a space-colonisation tier; the Wasm kernel does the shadow deposit only. | Apical, phototropic and leaf-shadow defaults underived (`growth.ts:227-232`). | Pałubicki et al. 2009 shedding plus Runions et al. 2007 (EGWNP) space colonisation. Validate against allometric scaling (West et al. 1999, Nature) and measured crown architectures. Rivals: SpeedTree growth, Houdini L-systems. |
| BIO-03 forest ecosystem dynamics (`biomes/forest`) | THIN (bordering STAND-IN) | 1, 2, 3, 6, 8 | None: tests check trends (self-thinning happens, shade-tolerant species win the understorey) and determinism. | The cited models are not built: no JABOWA growth or allometry, no light extinction, no SORTIE gap light or growth-dependent mortality. `docs/limits.md` does not say the ecology is reduced. | Base mortality 1/(4 · lifespan), fixed 0.25 mortality terms, "half growth in shade", seeds scaled by (r/r_max)² — all uncited heuristics (`biomes/src/ecosystem-model.ts:51, 224, 227, 243`). | SORTIE-ND (Pacala et al. 1996, Ecol Monogr); FORMIND (Köhler and Huth 1998). Validate against Reineke's −3/2 self-thinning and Pacala's measured growth curves. Rivals: SORTIE-ND, iLand, LANDIS-II. |
| BIO-04 material ageing (`physics/ageing`) | THIN | 1, 2, 3, 4, 7 | `ageing.test.js` Kubelka–Munk against the hyperbolic closed form (±4e-16) is genuine. The ISO 9223 test re-types the same formula (transcription, ±5e-20), not coupon data; ISO 9224, Faraday immersion, Viitanen activation and calcite balance are checks of the same equations. | Every patch is a 0-D column: no spatial exposure, run-off streaks or pitting; Gu et al. 2006 time-varying appearance cited, not built; exposure producers open (known-bugs); coupling test uses a stand-in producer. | Authored colours (`src/ageing.ts:156-163`); authored fouling rates 0.01/0.002/0.05 per day (`ageing.ts:223`); a single Melchers figure sets the marine current (`src/ageing/processes.ts:103-106`). | Gammaton weathering (Chen et al. 2005, SIGGRAPH); flow weathering (Dorsey, Pedersen and Hanrahan 1996); Melchers 2003 bi-modal marine corrosion. Validate against ICP Materials dose-response data (Tidblad et al. 2001) and Melchers immersion coupons. |
| SPACE-01 N-body and orbital dynamics (`physics/orbit`, `sciviz` SGP4) | THIN | 1, 2, 3, 4, 5, 6, 7 | `orbit.test.js`: exact circular binary; Yoshida-4 step-halving ratio 14-18; J2 equatorial frequency (analytic, bound 4r(ωh)⁴); exact quadratic-drag decay (16 ε). `sciviz/tests/geo-sgp4.test.js`: Vallado et al. 2006 published vectors within 0.1 m and 1e-7 km/s — published. | Wisdom–Holman and IAS15 cited, not built; fixed steps, no close-encounter handling; re-entry is drag only (no heating, lift or standard atmosphere); no thrust or manoeuvres (`importPorts` empty); no hyperbolic Kepler; no harmonics beyond J2; no radiation pressure; SGP4 is not a Solver; coupling test uses a stand-in observer. | O(n²) gravity with no work counts; the disk emitter is kinematic (`src/orbit/kepler.ts`). | WHFast (Rein and Tamayo 2015, MNRAS) and IAS15 (Rein and Spiegel 2015, MNRAS); NRLMSISE-00 (Picone et al. 2002); Sutton–Graves 1971 heating. Validate against the Pythagorean three-body problem (Szebehely and Peters 1967) and JPL Horizons DE440 over a year. Rivals: REBOUND, Orekit. |
| SPACE-02 celestial ephemeris and rotation (`physics/space`) | THIN (SOUND on the earlier floor) | 1, 2, 3, 4, 5 | `celestial.test.js`: Earth rotation against the Wallace and Capitaine published matrix (ERA ±1e-10, matrix ±0.6″, derived); 2017 and 2024 total solar and 2022 lunar eclipses (categorical); exact Newton tide. `sky/test` checks Standish elements against Horizons DE441 (measured residual ceilings, Saturn 11.9′) and Meeus 47.a — published. | VSOP87 cited but Standish mean elements used (arcminute tier only); SPK reader tested on synthetic files only; no eclipse contact times, refraction or limb darkening; SEA-07 tide not tested two-way. | None. | ELP/MPP02 Moon (Chapront and Francou 2003); IAU 2000A nutation (Mathews et al. 2002); HW95 tidal potential (Hartmann and Wenzel 1995). Validate against NASA Five Millennium Canon contact times (Espenak and Meeus 2006). Rivals: astronomy-engine, Skyfield (eclipse and rise/set search). |
| SPACE-03 accretion disks and compact objects (`physics/accretion`) | THIN | 1, 2, 3, 4, 5, 7 | `accretion.test.js`: exact zero-torque steady Σ, Ṁ and heating 3GMṀ/(8πr³)(1 − √(r_in/r)) (256 ε); Kerr circular frequencies (Bardeen, Press and Teukolsky), ISCO 6/1/9, inclined Carter orbit, radial infall, light ring (RK4 h⁴, derived). | Viscosity is user-supplied (no Shakura–Sunyaev α closure or vertical structure); no relativistic disk flux (Novikov–Thorne, Page–Thorne); Fujita–Hikida cited, RK4 used; the spreading-ring test is qualitative; the film binding is open (known-bugs); coupling test uses a stand-in feed. | None. | Shakura and Sunyaev 1973 (A&A) α closure; Page and Thorne 1974 (ApJ) relativistic flux. Validate against the Lynden-Bell and Pringle 1974 (MNRAS) spreading-ring closed form. Rival: HARM (Gammie et al. 2003). |

## Solvers built by Claude

Audited on 2026-11-26 the same way: every row in the work queue with Owner Claude and Status LANDED (21), plus FLUID-03 and
SOFT-01, whose rows are still CLAIMED. **Counts: SOUND 0, THIN 23, STAND-IN 0.** The 21 landed rows are REOPENED in the
work queue with Owner Claude. Defects found on the way are logged in [known-bugs.md](known-bugs.md) under "Open
2026-11-26: defects found by the physics solver audit, Claude solvers".

The worst cases:

- **AERO-01 aerodynamic loads:** effectively unvalidated; its one measured comparison, sphere drag, is 66% high and
  is pinned as an accepted difference; sheltering, which the row names, is missing.
- **ATMO-01 boundary-layer wind:** a neutral log law only; terrain speed-up, shelter and stability (half the row) are
  cited and not built, and the gust box repeats every 256 m vertically.
- **SEA-03 rogue waves:** Benjamin–Feir focusing exists only as statistics, not as wave dynamics.
- **SEA-15 tracers and slicks:** nothing measured; Fay spreading is cited and not built, and slicks ride a flat water
  level rather than the sea.
- **SEA-09 manoeuvring:** one hull (KVLCC2) only, and the sailing hull, heel, leeway, oars and planing the row names
  are absent.

Strongest: ATMO-04 precipitation (Gunn and Kinzer fall speeds), SEA-01 wave growth (Kahma and Calkoen, JONSWAP
fetch laws), SEA-08 seakeeping (a measured roll decay) and SEA-14 water entry (measured slam peak and ricochet).
The catalog rows for SEA-08, SEA-11 and SEA-15 still say "stand-in" and name the old water-package paths, which
understates what is built.

| Solver | Verdict | Fails | Validation (test, reference, bound) | Missing | Red flags | Upgrade to best |
| --- | --- | --- | --- | --- | --- | --- |
| SOFT-01 cloth and thin shells (`physics/soft`; row still CLAIMED) | THIN | 1, 2, 3, 4, 5, 7, 8 | `soft.test.js` cotton strip sag against Irvine's elastic cable (1%, derived); catenary (3% / 0.06 m, arbitrary); friction holding cloth over a box edge against an analytic threshold (2× margin). Stretch and shear from Luible 2008 measured KES-F data. | Shell bending (bending is springs to the particle two along at a default 10 Hz, `soft.ts:372`; measured KES-FB2 bending rigidity unused); skinned cloth (X-31); tethers (X-30); adaptive tearing (torn pieces become separate cloths only with `splitOnTear: 'all'`, along existing edges); water as a medium (buoyancy, added mass); garments in `humans` are static meshes; no `effectBothWays` coupling test; wind is a property, not a field port; FIRE-04 overpressure. | Stale docs: `soft.ts` and `soft-split.ts` say cloth is never split, but the code splits it; `docs/rapier-parity.md` X-28 says drag is linear only while face drag exists; `docs/limits.md` contradicts itself on the render bridge; air-drag loop in TypeScript (`soft.ts:4367`). | **Films:** water as a medium in the soft kernel (buoyancy and added mass, with a FlowField fed by SEA-02 orbital velocity) so hoses, cables and soft reef life sway with the surge (BS-1, BB-1; the kernel is shared with SOFT-02), and cloth pinned to the moving cabin for the EF-3 curtains. Then discrete shells (Grinspun et al. 2003) or quadratic bending (Bergou et al. 2006) from KES B, codimensional IPC (Li et al. 2021), LRA tethers (Kim, Chentanez and Müller 2012); validate against the ASTM D1388 cantilever bending length, the Cusick drape coefficient and Eloy et al. 2008 flag flutter onset. |
| AERO-01 aerodynamic loads on bodies (`physics/aero`) | THIN (bordering STAND-IN for round bodies) | 1, 2, 3, 4, 5, 6 | Effectively none: the face-on plate checks its own default 1.17; the 45° plate checks the sine law against itself; the one measured comparison, sphere Cd, comes out 0.78 against 0.47 measured (66% high); `aero.test.js` pins 0.78 as an accepted difference recorded in limits. | Sheltering (named in the row); Reynolds dependence and drag crisis; base pressure; Magnus lift; added mass; tumbling. | Doc comment still describes the old box-area model (`src/fields.ts:91-95`); world-axis bounding box used as a body-frame box, so rotated bodies get wrong panels (`src/aero.ts:83-87`); leeward panels take no load, so drag ignores body length (`fields.ts:234`); wake threshold 0.1 m uncited (`:254`). | Validate against Achenbach 1972 sphere and cylinder data, Andersen, Pesavento and Wang 2005 falling plates, Nathan 2008 Magnus lift; add Reynolds-dependent bluff-body coefficients and sheltering. |
| AERO-02 membrane aerodynamics (`physics/sail`, lattice) | THIN | 1, 2, 3, 4, 5, 6 | Helmbold lift slope for a flat AR 6 plate within 5% (closed form, not a sail); lift linear in incidence; the stalled plate checks its own input; momentum bookkeeping. | Cambered-sail data; flag flutter (no unsteady wake, flags flap only from cloth motion); parachutes and tents (bluff porous canopies); thrust reaching the hull; no coupling-harness test. Cites Wikipedia while Katz and Plotkin and Fossati were not read. | Stall judged per panel on local incidence, marking a cambered sail's attached leading edge as separated (`src/lattice.ts:130-131`); stalled panels stay in the attached system (`:116-119`); O(n³) induced loop (`:144`). | Unsteady vortex lattice (Katz and Plotkin 2001, ch. 13). Validate against Viola and Flay 2009 and Fossati 2009 sail data, Eloy et al. 2008 flutter onset, Knacke 1992 parachute drag. |
| AERO-03 flight dynamics (`physics/flight`) | THIN | 1, 2, 3, 4, 5, 6 | Helmbold within ±5% and elliptic induced drag within ±6% (analytic); helium lift 1.056 kg/m³ within ±0.2%; rotor figure of merit only bounded in 0.4-1; glide angle atan(D/L) checks the model against itself. | Airfoil section data; control surfaces; forward-flight rotors (axial inflow only, `src/flight.ts:570`); tip loss, vortex-ring state, gyroscopics; added mass and rotational lift; rocket thrust; bird-gait control. | Stalled-panel drag double count fixed in `flight.ts` and `lattice.ts`. The attached-area and fully separated regressions are in `physics/tests/flight.test.js`; hub radius 0.1R uncited (`:498`); lifting gas ignores the scene's air field (`:657`); flapping wings are massless. | Validate against Caradonna and Tung 1981 and Knight and Hefner 1937 rotor data, UIUC propeller data, the Lanchester phugoid period, Dickinson et al. 1999 flapping forces. Rivals: JSBSim, AVL, XFOIL. |
| SEA-01 wave spectrum and evolution (`physics/waves`) | THIN | 2, 3, 4, 5, 6 | Measured: `waves.test.js` Kahma and Calkoen gale growth (e* within −15%/+25% of 2.1e-3 χ*^0.79), JONSWAP fetch laws (Hasselmann et al. 1973; Hs ±25%, Tp ±15%), Alves, Banner and Young 2003 fully developed sea (±15%, wider than the data's ±8%); dispersion and group velocity exact (1e-12). Bounds are arbitrary. | Currents (Doppler shift); diffraction, reflection, triads, garden-sprinkler correction; quantitative duration-limited growth and swell decay or refraction tests; wave roughness back to ATMO-01; nothing returns from SEA-04/05 at the nearshore boundary. | ST4 sheltering calibrated at 10 and 20 m/s and validated at 20 m/s, a calibration case; the held-out 30 m/s result is only in `docs/limits.md`, not in a test (`src/waves/st4.ts:44-49`, `waves.test.js:100-132`); about 4.7 s per wave step on the default 32 × 32 grid; the swell test checks only a crude arrival window. | **Films:** Validated swell: propagation and dissipation of long swell checked against Ardhuin et al. 2009 (JPO) SAR swell decay, and the held-out 30 m/s Kahma–Calkoen gale as a test, so the Lake Superior gale and the long swell the ship rides have the right height and period. (EF-1, BS-6). Then: ST6 (Zieger, Babanin, Rogers and Young 2015, Ocean Modelling); exact nonlinear transfer (WRT/GMD, Tolman 2013). Validate against Young and Verhagen 1996 Lake George finite-depth growth, Ardhuin et al. 2009 (JPO) SAR swell decay, Kahma and Calkoen at 30 m/s as a held-out test. Rivals: SWAN, WAVEWATCH III (currents, triads, diffraction, nesting). |
| SEA-02 ocean surface synthesis and query (`physics/sea` surface) | THIN | 1, 2, 3, 5, 6 | Airy linear theory only (`sea-surface.test.js`: height, normal, orbital velocity, pressure to 1e-9/1e-12; divergence-free flow; variance equals m0). Checks against the implemented formula; nothing measured. | The row's FFT and Gerstner surface with choppy horizontal displacement; the spectrum is read at one point and applied to the whole sea (`src/sea/surface.ts:30,253`), so the sea cannot vary across a coast; currents do not Doppler-shift waves (`:336-339`); one wave per bin centre; only JONSWAP with cos² spreading (Horvath et al. 2015 spectra not built). A query, not a `Solver`. | About 816 waves summed per query point, O(bins) cost. | **Films:** An FFT cascade with choppy horizontal displacement and its Jacobian (Tessendorf 2001), with the spectrum varying across the scene, so the sea shows steep, sharp-crested swell that lifts the hull instead of small ripples. (BS-6, BS-3, EF-1, EF-5). Then: FFT cascade with choppy displacement and Jacobian (Tessendorf 2001) and a spatially interpolated spectrum. Validate against Longuet-Higgins 1952 Rayleigh crest and height distributions on the synthesised sea. Rivals: Tessendorf FFT oceans in three.js and Babylon, WaveWorks cascades. |
| SEA-03 nonlinear and rogue waves (`physics/rogue`) | THIN (close to STAND-IN for Benjamin–Feir focusing) | 1, 2, 3, 5, 6 | Analytic (`rogue.test.js`): Stokes second harmonic (1e-7), Longuet-Higgins sum and difference terms (1e-12), Longuet-Higgins and Stewart bound long wave (0.1%), Rayleigh limits and expected largest wave (0.5%). Skewness is checked against the code's own sum; the Draupner crest is placed by the code and its rise bound is arbitrary. | High-order spectral method (Dommermuth and Yue 1987) and Dysthe or NLS evolution: Benjamin–Feir focusing exists only as statistics, not dynamics; steep Stokes waves beyond second order; breaking; deep-water statistics used in shallow water. A query, not a `Solver`; no coupling test. | Rogue rate "one wave per zero-crossing wavelength² per period" uncited (`src/rogue/index.ts:587-588`); 8·Tz event window a free choice (`:293-294`); O(N²) pairs per point. | **Films:** Dynamic focusing with a high-order spectral tier (West et al. 1987; Ducrozet et al. 2016) so a placed rogue group builds and breaks over the hull in time, as the Fitzgerald's last hours call for, instead of rogue waves existing only as statistics. (EF-11 (with EF-6)). Then: HOS tier (West et al. 1987, JFM; Ducrozet et al. 2016, HOS-Ocean) with the second-order model as the fast tier; Fenton 1985 fifth-order waves. Validate against Onorato et al. 2004/2009 tank kurtosis vs BFI, Forristall 2000 crests, Mori, Onorato and Janssen 2011, Christou and Ewans 2014 field rogue rates. |
| SEA-04 local dispersive free surface (`physics/sea` wake) | THIN | 1, 2, 3, 4, 5, 6 | `sea-wake.test.js`: Kelvin transverse wavelength 2πU²/g within 5% (analytic); crest angle in a loose 12°-22° band around 19.47°; energy kept to round-off. | Reflection and clapotis off quays, hulls and breakwaters (a periodic FFT grid has no boundaries); capillary waves and viscous decay; varying depth; currents; wave-making resistance back to the hull; the Rabaud and Moisy angle claimed in `docs/limits.md` has no test. `wakeHeight` missing from the README. | The limits claim above. | **Films:** Boundaries and hull sources: waves that reflect and diffract off quays and hulls (wavelets with obstacles, Jeschke et al. 2018) and the hull's displaced volume written in as a source, so the bow wave climbs the stem, the Kelvin wake widens and reflects off the quay, and the waterline moves. (FW-1, FW-5, FW-6, BS-4, EF-10). Then: Water-surface wavelets with obstacles (Jeschke et al. 2018, SIGGRAPH) or a Madsen and Sørensen 1992 Boussinesq tier. Validate against Havelock 1908 wake amplitude, Cauchy–Poisson ring waves, Rabaud and Moisy 2013 angle vs Froude number. Rivals: FUNWAVE, Celeris. |
| SEA-05 nearshore waves and surf zone (`physics/surf`) | THIN | 1, 2, 3, 4, 5, 6 | Analytic: energy-flux shoaling, Snell, Longuet-Higgins and Stewart set-down (10%), Bowen set-up slope, wave action against a current (2%). Measured: Stockdon et al. 2006 R2% within 25%, but the run-up is built from Stockdon's own terms (`src/surf/index.ts:956,973`), so the check is partly circular. Undertow and longshore balances are the model's own. | Lab or field dataset validation; a phase-resolved (non-hydrostatic) tier; adaptive breaker γ; HYDRO-03 morphology; overtopping; a both-ways HYDRO-01 test; return to SEA-01. | Shore set-up about twice Stockdon's (stated in limits); hard cap Hrms ≤ 2h (`index.ts:719-723`). | **Films:** Phase-resolved surge at the reef crest (a non-hydrostatic tier after Zijlema, Stelling and Smit 2011) published as the orbital velocity field that plants, sand and fish sample. (BB-2). Then: Non-hydrostatic tier (Zijlema, Stelling and Smit 2011, SWASH). Validate against Boers 1996 barred beach, Haller et al. 2002 rip channels, Visser 1991 longshore current, Longuet-Higgins 1970 planar beach, DUCK94. Rivals: XBeach-NH, SWASH, FUNWAVE-TVD. |
| SEA-08 ship seakeeping (`physics/seakeeping`) | THIN (strongest of the ship set) | 1, 2, 3, 4, 5, 6 | Closed forms in `seakeeping.test.js`: Archimedes (1e-12), wall-sided righting arm (1e-9), box Froude–Krylov load (0.2%), Journée–Massie Lewis table (1e-4), Ritter dam break on deck (2%). Measured: `coupling/seakeeping.test.js` "a box let go heeled rolls down as Jung, Chang and Jo's measured box did" (decay within 12% against 7.7% measured error, period within 5%). The 3% time-versus-frequency checks are internal. | Forward speed (Salvesen–Tuck–Faltinsen cited, speed terms absent); surge added mass; 3-D and end effects; finite depth; bilge keels; added resistance in head seas; radiated waves never reach SEA-04 (`describe()` writes no wake sources, `src/seakeeping/solver.ts:209-213`); nothing feeds SEA-14, ICE-04 or BREAK-03. | Roll axis clamped at 0.95 of draft (`viscous.ts:26`) and Lewis form clamped (`strips.ts:125`), both documented. | **Films:** Forward-speed seakeeping (Salvesen–Tuck–Faltinsen speed terms) with deck motion published for loose props and cabins and radiated waves passed to SEA-04, so a laker at speed in following seas heaves, pitches and rolls as the gale demands and its interiors move with it. (EF-1, EF-2, EF-3, EF-10, FW-2, BS-4). Then: 3-D panel impulse-response functions (Newman 1985; Babarit and Delhommeau 2015, NEMOH) plus STF forward-speed terms. Validate against Journée 1992 Wigley hull experiments, the ITTC S175 benchmark, Ikeda 1978 bilge-keel roll data. Rival: WAMIT. |
| SEA-09 manoeuvring, propulsion, resistance, sailing hull (`physics/ship`) | THIN | 1, 2, 3, 4, 5, 6, 7 | `ship.test.js` reproduces the Holtrop–Mennen worked example (0.1%, a code check) and the published squat case. KVLCC2 turning (7.5%) and zig-zag overshoots (10%) are compared with Yasukawa and Yoshimura's simulated tables, not free-running model tests; the squat check through `HullSolver` uses an arbitrary 15%. | From the row itself: heel, leeway, keel lift, the sailing hull, oars, planing. One hull only (KVLCC2, `src/ship/mmg.ts:66`), no empirical derivatives for other hulls (Kijima 1990); `holtropMennen` not wired into the solver; no autopilot or track targets; no AERO-02 sail or ICE-04 coupling. | Thruster speed-loss curve and `THRUSTER_MERIT = 0.55` are calibrations (`solver.ts:42,302`); silent speed cap 0.69 √(gh) for squat (`:362`); shaft depth d − 0.6D uncited (`:372`); quay pull 0.98, 0.5 and 0.6L uncalibrated (`:437-440`); paired with `HullSolver` only added mass can be switched off, so sway and yaw damping are counted twice, untested (`:57`). | **Films:** The propeller race and rudder jet as a velocity field with cavitation and aeration sources for SEA-13 and SEA-15, plus empirical derivatives for other hulls (Kijima 1990) so a Great Lakes freighter is not modelled as KVLCC2. (FW-3, FW-4, BS-5, EF-9). Then: 4-DOF MMG (Yasukawa et al. 2019); shallow-water derivatives (Kijima and Nakiri 2003); manoeuvring in waves (Skejic and Faltinsen 2008); Savitsky 1964 planing; a sailing VPP (Kerwin 1978); Wageningen B-series (Bernitsas et al. 1981). Validate against SIMMAN 2008 KVLCC2 free-running data and Lataire bank-effect data. Rival: Fossen's MSS toolbox. |
| SEA-10 damage, flooding, capsize, sinking (`physics/seakeeping` flooding) | THIN | 1, 2, 3, 4, 5, 6 | Analytic (`flooding.test.js`): Torricelli filling (under 1e-3 m, step-halving ratio 2 ± 0.1, derived); 2/3 weir law (1e-12); Boyle air pocket (1e-9 m); water conserved (1e-6). `coupling/seakeeping.test.js` "barge holed in a wing tank": added-weight solution within 1e-3° of the lost-buoyancy statics (Biran) — a good independent check. The cargo outflow test re-checks the code's own Beverloo formula. No measured data. | Floodwater sloshing and transient flow (water is a point mass); righting-arm curves and IMO/SOLAS criteria; drag on a sinking hull (KB-SEA-SINKDRAG1: 17.7 m/s at 50 s); wave pressure and green water at openings; settling on the bed; the `hullBreaches` port has no consumer, so SEA-13 bubble plumes and SEA-15 tracers are not wired. | 200-sweep loop ends silently if unconverged (`src/seakeeping/flooding.ts:665,718`); iron-ore default grain 1e-4 m while the comment says taconite pellets are about 0.012 m (`:59,172`); 48-level volume table rebuilt at every pose (`:140`). | **Films:** submerged-hull form drag (Hoerner 1965) so a hull that has lost its buoyancy dives at its drag-limited speed (EF-11). Then shallow water inside each compartment (Santos and Guedes Soares 2008, J Ship Res; Ruponen et al. 2013, Ocean Eng); validate against Ruponen 2007 box-barge flooding and the ITTC damaged-ship benchmark (Papanikolaou et al. 2000). Rivals: NAPA, MAXSURF (GZ, criteria), PROTEUS3. |
| SEA-11 slamming and green water (`physics/seakeeping` slamming) | THIN | 1, 2, 3, 4, 5, 6 | `coupling/seakeeping.test.js` "a wedge … slams as Wagner says" and the slamming table (0.1%) check the code against the theory it implements; green water against Ritter's dam break (2%) and edge flux. No measured drop test. | Pressure distribution, von Kármán, Korobkin's generalized Wagner (a modified Logvinovich model already exists in `entry/slam.ts`); flare and lateral slams; green-water impact on deck structures; bulwarks; whipping; output to SEA-13 spray. The catalog row still names the old `ShipSplash` stand-in. | (dm/dh)V² applied to every immersed section moving down below its chine, not only at impact, on top of linear radiation, which may add quadratic damping; untested on a V-hull motion response; force along body y only (`seakeeping/solver.ts:961-962`). | **Films:** Green water impact on deck structures and hatch covers (Zhou, De Kat and Buchner 1999) with flare slams from the generalized Wagner model (Zhao, Faltinsen and Aarsnes 1996), and slam spray passed to SEA-13. (EF-6). Then: Generalized Wagner (Zhao, Faltinsen and Aarsnes 1996); 3-D Wagner (Scolan and Korobkin 2001). Validate against Zhao et al. 1996 wedge drops, Tveitnes et al. 2008, Zhou, De Kat and Buchner 1999 deck loads. |
| SEA-12 hydrodynamic loads on arbitrary bodies (`physics/loads`) | THIN | 1, 2, 3, 4, 5, 6 | `loads.test.js` Lamb added-mass integrals against DNV-RP-C205 Table D-2 (within 0.001) — published. The rest re-checks the code's own formulas (pile loads, Sainflou and Goda pressures, PIANC wash, sphere drag fit); analytic solutions of its own equations for the carried light sphere and terminal speed (2%). No Keulegan–Carpenter or Sarpkaya data. | "Exact submerged-volume buoyancy" (catalog) is an equivalent ellipsoid, and a box prism exact only when upright (`src/loads/solver.ts:324`); buoyancy acts at the shape's centre, so no righting moment (`:343`); radiation damping and rotational added inertia; debris impact (Haehnel and Daly cited); anchors; one-way flood coupling; coupling test with the rigid solver only (none with HYDRO-01, SEA-08, LIFE-03). | Wind sampled 1 m above the surface (`:384`); ad hoc emerged area (`:389`); default Cd 1.0 (`:357`); spin drag reuses translational Cd (`:375`). | **Films:** Morison loads on soft-body rod segments so diver hoses and cables are pushed by the surge (BS-1), then a buoyancy righting moment so divers and debris settle their attitude. Then mesh pressure integration (reuse SEA-08's wetted loads), Cummins 1962 radiation, Haehnel and Daly 2004 debris impact; validate against Sarpkaya 1976 and Keulegan and Carpenter 1958. Rival: OrcaFlex (line dynamics, radiation). |
| SEA-13 whitewater, foam, bubbles, spray (`physics/foam`) | THIN | 1, 2, 3, 4, 5, 6 | `foam.test.js` whitecap coverage against Monahan and Woolf within a factor 1.5, not independent (Leckler's κ was tuned on the same data), and the 16 m/s point outside the band is left out of the test (recorded in limits); Stokes drift closed form (1e-9). Decay and Gong spray tests check the code's own constants. | Subsurface bubbles and entrainment (Deane and Stokes 2002); Andreas 1998 cited, unused; spume and hull venting; diffuse particles only in `water/liquid-whitewater.ts`, uncoupled; Langmuir windrows imposed as a sinusoid; ship wakes painted; inputs arrive as callbacks, no SEA-04 breaking read, spray not passed to ATMO-06. | Uncited race spread 0.212 and 4.71, bow-foam Froude ramp 0.15-0.4, wake decay −0.8 and 0.07, bow foam 0.6 (`src/foam/index.ts:517-571`); `wakePersistence` 150 s fitted from an acoustic measure (`:268`). | **Films:** Bubble entrainment and plumes (Deane and Stokes 2002): bubbles that rise, wobble, grow with falling pressure and drift in the orbital flow, and streaked foam and spray from breaking crests read from the live sea. (BS-2, FW-4, EF-5, EF-6, FW-1). Then: Bubble entrainment and plumes (Deane and Stokes 2002); spume (Andreas 1998). Validate against Callaghan et al. 2008 whitecap coverage held out from calibration. Rival: Houdini whitewater. |
| SEA-14 water entry and exit (`physics/entry`) | THIN (close to SOUND) | 1, 2, 3, 4, 5, 6 | Measured: `entry.test.js` sphere slam peak C 0.9-1.1 (Shiffman and Spencer; Antolik 2023, derived band); ricochet within ±15% of Johnson and Reid (12.4° vs 12.7°, 5.8° vs 6.4°); cone Wagner radius (0.2%, analytic); cavity pinch against Aristoff (10%). Speirs' measured slam impulse (0.050 vs 0.067, about 25% low) is only in limits, not a test. | Surface seal; crown-sheet dynamics; Worthington jet scaling; bubble pinch-off; truly asymmetric entry (an equivalent axisymmetric body is used); exit-force validation; the SEA-08 link. | Cavity gate `sine > 0.5` uncited (`src/entry/solver.ts:560`); self-invented √sine grazing factor (`:564`); hard-coded 1025 kg/m³ instead of the water's density (`:566`); jet speed ratio 9.85 calibrated on one case (`:129`). | **Films:** Surface seal, crown sheet and Worthington jet (Marston et al. 2016; Gekle and Gordillo 2010) so breaching dolphins and debris entering the sea throw the right splash. (BB-8, EF-11). Then: Surface seal (Marston et al. 2016); Gekle and Gordillo 2010 jet law. Validate exits against Truscott et al. measurements and add the Speirs impulse as a test. Rivals: FLIP or VOF splash sheets. |
| SEA-15 tracers and slicks, with the seabed sand puff (`physics/tracers`) | THIN | 1, 2, 3, 4, 5, 6 | None against measurements: the 2Kt variance test (6%) checks the random walk against its own definition; settling checks Ferguson–Church against itself and the Stokes limit (1%). The sand-puff tests in `coupling/swim.test.js` (fin wakes lift seabed sand, `c1a005f94`) are qualitative: sand lifts, drifts and settles; still fins lift none. | Fay spreading (cited, not built) and oil weathering; wave Stokes drift; depth-varying and scale-dependent diffusivity; resuspension, flocculation and the Shields curve (constant 0.05); bed lifting by propellers and thrusters; breach cargo through a callback, not a field port; slicks ride a flat `waterLevel`, not the sea (`src/tracers.ts:375,421`). | Jet spreading 0.1 and a 5% momentum-flux factor, while Phares et al. 2000 is cited and its wall-stress law unused (`tracers.ts:460-462`); erodibility 0.02 uncited (`:284`); parcel release height uncited (`:478`). | **Films:** Sediment pick-up from bed stress (van Rijn 1984 pick-up with the Soulsby–Whitehouse 1997 Shields curve, and the cited Phares et al. 2000 wall-jet law) so the ray's sand puff scales with its fin beat and the grain size, plus the bed print through EARTH-01 and the taconite plume from a breached hold. (BB-7, EF-11). Then: Fay 1971 spreading, Mackay 1980 evaporation, Delvigne and Sweeney 1988 dispersion, van Rijn 1984 pick-up, Soulsby and Whitehouse 1997 Shields curve, Breivik et al. 2014 Stokes drift. Validate against the Okubo 1971 diffusion diagram. Rival: OpenDrift. |
| FLUID-03 grid-particle liquids (`physics/flip`; row still CLAIMED) | THIN | 1, 2, 3, 4, 5, 6, 7 | `flip.test.js` "a column of water twice as high as wide collapses": dam-break front against Martin and Moyce 1952 table 2 (4% + 0.07, arbitrary; run in 2-D only; start time fitted at Z = 1.44). `deck-water.test.js`: sloshing period against linear theory √(gk tanh kd) within 5% (arbitrary); free-surface tilt ρg tanθ within a grid-derived bound; still-water pressure ρgh within one cell. | Coupling to the sea (the box takes no water from SEA-02/SEA-04, gives none back, makes no spray for SEA-13), so no crashing crests; waterfall emitters; a FLIP/PIC blend (pure APIC); a 3-D check; sub-cell solid boundaries (Batty 2007); viscosity, surface tension, sparse grid, surface mesh, spray output. `describe()` lists no fields and `seaSources()` is a method, not a port. Hot loops in TypeScript. | Particles described as "jittered" but seeded at exact octant centres (`src/flip/transfer.ts:9`, `solver.ts:205-208`); a particle that would enter a solid stays put (`solver.ts:332-339`); `INFLOW_LAYERS = 4` uncited (`deck-water.ts:49`). | **Films:** let the live sea drive the box's open sides (inflow from SEA-02/SEA-04, outflow back to SEA-04, spray to SEA-13) so a FLIP band at the bow and deck takes real waves (EF-6, FW-1, BS-4). Then narrow-band FLIP (Ferstl et al. 2016, TVCG), variational boundaries (Batty, Bertails and Bridson 2007), diffuse spray (Ihmsen et al. 2012); validate against the MARIN 3-D dam break (Kleefsman et al. 2005, JCP) and green-water PIV (Ryu, Chang and Mercier 2007). |
| HYDRO-01 conservative shallow water (`physics/hydro`) | THIN (strongest of the ocean set) | 1, 2, 3, 4, 5, 6 | `hydro.test.js` analytic: Ritter dam break (3%), Stoker (2%), Manning normal depth (1%), Thacker bowl from SWASHES (phase 0.06 rad, L1 6%), lake at rest and volume ledger (1e-12). Bounds tight but arbitrary. | Forces on bodies (PA-19, SEA-12); the Bates et al. 2010 inertial fast tier the row cites; eddy viscosity; building porosity; lab or field benchmarks; `rivers.ts` still a stand-in (PA-18); coupling harness covers frame rate and seek only. | Wind stress uses absolute wind, not wind relative to the water; per-call allocation (`src/hydro/shallow.ts:553`). | Quadtree adaptive refinement (Popinet 2011) and the Bates 2010 inertial fast tier. Validate against the UK Environment Agency 2D benchmarks (Néelz and Pender 2013), Soares-Frazão 2008 urban dam break, Malpasset, Toce. Rivals: HEC-RAS 2D, TUFLOW, LISFLOOD-FP, Basilisk. |
| ATMO-01 boundary-layer wind (`weather/boundary-layer`) | THIN | 1, 2, 3, 4, 5, 6, 7 | None against measurements: `boundary-layer.test.js` "the mean wind follows the log law" checks the formula against itself; the 1,010 m check validates the standard-atmosphere helper, not the wind. | Terrain speed-up and shelter, and stability: two of the four model pieces the row names (Jackson–Hunt, Sherman and WindNinja are cited, none built). A pure field, not a `Solver`, so no feedback; the weather machine (`weather/src/machine.ts:163`) still uses the old value-noise `WindField`. | Direction 0 means +x while `weather/src/wind.ts` uses +Z (`boundary-layer.ts:32`); gusts carried at the reference speed at every height (`:128`); σ = 2.5u* and L = 33.6 m at every height (`:109`); the box repeats vertically every 256 m, so gusts at 260 m match those at 4 m and w does not vanish at the ground (`:130`). | Monin–Obukhov stability (Businger et al. 1971; Dyer 1974) validated on Kansas 1968; mass-consistent terrain (Sherman 1978; Forthofer et al. 2014) validated on Askervein (Taylor and Teunissen 1987) and Bolund (Berg et al. 2011). Rivals: WindNinja, WRF-LES, PALM. |
| ATMO-02 turbulence and gusts (`weather/turbulence`) | THIN | 2, 3, 4, 5, 6, 7 | `turbulence.test.js` "unsheared turbulence is isotropic; IEC shear": IEC 61400-1 component ratios in bands σv/σu 0.6-0.8 and σw/σu 0.42-0.6 (not derived); u′w′ sign only; zero divergence (numerics). | Travelling gusts as placed events (IEC extreme and 1 − cos gusts); length scale and σ varying with height; stability-dependent Mann (Chougule et al. 2015); any one-point spectrum or coherence check. | Underived bands (`turbulence.test.js:31-32`); a 512 × 32 × 32 FFT in JavaScript (`turbulence.ts:115`). | Check F11(k1) and F13 against Mann 1994's closed forms and Kaimal et al. 1972; coherence against Davenport or Mann 1994 Fig. 2. Rivals: TurbSim, HAWC2 Mann generator (coherent gusts, stability). |
| ATMO-03 moist convection and clouds (`physics/clouds`) | THIN | 1, 2, 3, 4, 5, 6, 7 | None against a published benchmark: bubble rise bounded only by free acceleration (`clouds.test.js:85`); cloud base from the model's own saturation formula; the Marshall–Palmer integral checks the formula; drift within an arbitrary ±30%. | Ice phase and hail; anelastic or compressible flow (Klemp–Wilhelmson); terrain lift; any consumer of `cloudWater` (the sky never reads it); ATMO-09 and ATMO-07 links; water is not conserved (documented). | Pressure solve stops at 400 iterations with no residual reported (`src/clouds/convection.ts:758`); white-noise thermal patchiness per 200 m column (`:610`); vorticity 0.2, patchiness 0.6 and period 600 s uncited (`:207`); no air-density correction on rain fall speed (`:917`); 0.3 s per step on CPU. | Ice microphysics (Morrison et al. 2005); anelastic tier. Validate against the Bryan and Fritsch 2002 moist bubble, BOMEX (Siebesma et al. 2003), Weisman and Klemp 1982 supercell. Rival: CM1. |
| ATMO-04 precipitation microphysics (`weather/precipitation`) | THIN (strongest of the air set) | 1, 3, 4, 5, 6 | Measured: Gunn and Kinzer 1949 fall speeds for 1-5 mm drops (one-sided 7%, documented bias); Heymsfield and Wright 2014 hail and graupel laws (±8%, arbitrary); Marshall–Palmer intercept (±15%); Stokes limit (analytic). | Below-cloud evaporation and melting (phase switches instantly; hail never melts); gamma or normalised size distributions; breakup and aggregation; K23 particle ballistics; snow not checked against Locatelli and Hobbs 1974 (band 0.5-1.6 m/s). | One median speed carries every hydrometeor sideways (`weather/src/precipitation.ts:531`). | **Films:** Rain carried by the gusty ATMO-02 wind drop by drop (not one median speed), with rings and splash sources on SEA-04 and snow fall speeds checked against Locatelli and Hobbs 1974 for squalls. (EF-7, EF-12). Then: Seifert and Beheng 2006 two-moment scheme; Testud et al. 2001 normalised distribution. Validate against 2DVD disdrometer data and Locatelli and Hobbs 1974. |

**SEA-08 forward speed: notes from Claude's unlanded work (2026-11-27), for its builder.** Built in a branch and
measured, not landed (the upgrade moved to Codex). What it did, in body axes (x forward, pitch bow up):
- Ordinary strip theory with its end terms (Salvesen, Tuck and Faltinsen 1970; Journee and Massie, Offshore
  Hydromechanics, eqs. 8.15-8.31) in the time domain. The radiation memory already convolves the body-frame heave
  velocity v_y, which holds the -U theta of a trimmed hull on a level course. Missing were: heave +U A33inf q (the fold
  takes the added mass on the world heave acceleration); pitch -U (A33inf v_y + K33 * z), z the relative heave
  displacement (written as the kernel convolved with z measured back from now, which truncates better than the running
  integral of the kernel); and taking the course's share of v_y back out of the pitch-heave coupling memory (store it in
  the history and subtract the same convolution), where the end terms cancel it. Shown term by term to reproduce eq.
  8.30 in the frequency domain.
- Pitfalls found: (1) a steady trim makes v_y constant, and the 2-D heave added mass grows without bound at low
  frequency, so the pitch term tipped a towed box to 13 degrees; the terms must act on the motion about the steady
  course (running means of v_y and of U with a 60 s time constant worked). (2) U must be the steady speed, not the
  instantaneous body-frame surge: a heaving, pitching hull has a second-order surge (heave velocity on the pitched axis)
  that spoiled the zero-speed heave-pitch test by 7 percent. (3) Adding the pitch-rate convective term and the coupling
  correction separately (each through the running integral of a coupling kernel) went unstable; cancel them exactly
  instead. (4) A body whose velocity is set after the world publishes its first ports starts the means at 0.
- Result: the uneven heave-pitch hull of `coupling/seakeeping.test.js`, towed at Froude number 0.29 (2 m/s on 4.83 m)
  and driven in heave at 3 rad/s, came within 3.0 percent in heave and 4.1 in pitch of the frequency-domain answer with
  eq. 8.30's coefficients (default 20 s memory; 3.5 and 4.1 with 60 s); the speed terms moved the pitch by 110 percent,
  and turning their signs put it far off. Sway, yaw and roll speed terms were not done (the lateral relative velocity
  needs the drift angle). Radiated waves to SEA-04 were not started: `WakeSolver` reads layout-1 `seaSource` rows (x, z,
  radius, pressure, volume pushed over the step), so the hull would write one row a station.

### DYN-01 handoff to its owner (2026-11-28)

For the session that owns DYN-01 ("Claude (laptop)"). Scott ruled on 2026-11-27 that KB-PHYS-HUNGCRADLE1 be fixed while
that session was offline; the row's owner is unchanged. What changed on `main`, all in the rigid kernel's strike:

- `kernel/src/joints.rs`: `held_response` and `apply_held`, the response a strike gets from the joints holding its
  bodies (two exact path solves, with and without a probe impulse). Up to 32 bodies and 16 joint paths; past that, and
  for a body with no locking joint, the free mass as before.
- `kernel/src/solver.rs`, `collide_pairwise`: a held body is struck and rubbed through `held_response`; a strike
  across a gap is moved back by its time of impact after `integrate_poses` (`shift_poses`); a point's load is rest only
  if held for the step it would take out the strike (was: any load); a line strike that does not close this substep sets
  PAIR_STRIKE_LATER (`kernel/src/layout.rs`, 64), which `normal_rows` leaves open in both passes and `end_strikes`
  clears after `solve_impacts`. `solve_impacts` bounces a held body through `held_response` too.
- Tests: three hung cradle tests beside "Newton's cradle" in `packages/physics/tests/rigid-validation.test.js`.
  Docs: `docs/limits.md` "Touching Newton's cradle", `docs/known-bugs.md` KB-PHYS-HUNGCRADLE1, clean-room PK61, the
  playbook's "Held strikes" paragraph.

Left for the owner: at friction 0 the standard tier loses about g h^2 / l a strike (2.3 percent of the swing in 60 s,
0.15 at `high`), second order in the substep; a fix would be a collision step that keeps the discrete energy (Fetecau
et al. 2003). The demo `demos/newtons-cradle` (branch `web-demos`) uses friction 0.1, under which rigid Coulomb
friction clumps the cradle in 15 s; it wants friction 0.

### SOFT-01 handoff (2026-11-27)

SOFT-01 passes to the session that owns cloth (the work queue's P6 owner). Landed on `main`, each with its tests and docs:

- Tethers, long range attachments (X-30): PR #842.
- Skinned cloth with max distance and backstop, `skinVertices` (X-31), with the fix that a hand-torn edge is announced and
  splits: PR #847.
- Lift, stall and skin friction on every cloth face, validated against Torres and Mueller's (2004) measured plates
  (X-28): PR #856.
- Whole soft-world snapshots across spawn, despawn and split, and the clock in rigid snapshots (PA-05, soft part): PR #862.
- Adaptive tearing of sheets through their faces (Pfaff et al. 2014): PR #872.
- Vertex block descent for cloth, Irvine's cable sag within 0.1 percent at any pass count (X-27): PR #880.

Not landed: soft work counts (`SoftBodies.work`), commit `38d50f0e7` on branch `item4`, unpushed. With it, the
`soft.test.js` test "a contact is stable at a mass ratio of a thousand either way, and a cloth holds a body or tears,
never lets it through" failed: the body ended 82 m below the cloth. The cause is not found; `7cf7419e0` (coded refusals,
face contacts dropped only against fixed colliders) landed on `main` since and may bear on it, so rerun the test on the
rebased commit first.

Still open against the eight points:

- Coded errors: done on `main` by `7cf7419e0` for the soft entry; `sail.ts` still throws five bare errors.
- Bending from measured data: quadratic bending (Bergou et al. 2006) in the soft kernel, KES-FB2 bending rigidity in the
  `FABRICS` presets, and checks against the ASTM D1388 cantilever bending length and the Cusick drape coefficient.
- Film controls for cloth.
- Sail thrust reacting on the hull (PA-29), with a coupling test.
- GPU cloth (`@margoengine/physics/gpu-cloth`): two-way ties to rigid bodies and the full per-face air (lift, stall,
  skin friction) on the GPU path.
- Speed against the rival's demo: waits for the quiet speed phase.

### Notes on the open Claude rows (2026-11-26)

Progress and research for the reopened rows above, for whoever builds the upgrade next.

**SEA-09 manoeuvring.** Done in 3c2f57931:

- `empiricalModel(hull)` builds a full MMG model for any hull from its dimensions: Kijima 1990 linear and |v|v terms
  for full hulls, Yoshimura and Masumoto 2011 cubics for fine hulls, their surge and rudder sets, Clarke and Brix added
  masses, and Holtrop's thrust deduction and form factor. It reports when a hull is outside the regression's range.
  It reproduces Yasukawa and Yoshimura's KVLCC2 values, and its turning circle is within 30 percent of MARIN's
  free-running data.
- The race field: each propeller's race is resolved with its swirl from the shaft torque, its contraction, the tip
  vortices with Lamb-Oseen cores (holding to 0.8 D, gone by 1.5 D) and the jet the rudder turns. Pennings' measured
  circulation is matched within 6 percent.
- Cavitation in the tip vortex has inception and desinence hysteresis and a Rayleigh collapse time. It reaches the
  bubbles (SEA-15) and the foam (SEA-13) through `aeration(t)`, and appears as `status.cavity`.

Still open on this row:

- the 4-DOF MMG with heel (Yasukawa et al. 2019), plus the sailing hull, leeway, keel lift and oars;
- shallow-water derivatives (Kijima and Nakiri 2003) and bank effect against Lataire's data;
- manoeuvring in waves (Skejic and Faltinsen 2008);
- Savitsky 1964 planing;
- a sailing VPP and coupling to the AERO-02 sail;
- the Wageningen B-series open-water curves (Bernitsas et al. 1981);
- `holtropMennen` wired into the solver;
- autopilot and track targets;
- ICE-04 coupling;
- validation against SIMMAN 2008 free-running data;
- a Rust and Wasm kernel;
- the red flags in the row: the thruster calibrations, the silent squat speed cap, the shaft depth and the quay pull
  constants. (The sway and yaw damping counted twice with `HullSolver` is fixed: the ship claims its surge, sway and
  yaw through `manoeuvringClaims`, KB-SHIP-DAMP1.)

**SEA-12 hydrodynamic loads.** Research for the buoyancy righting moment, a design not yet built:

- Box or mesh: integrate the still water's pressure ρ g (η − y) over the wetted surface with seakeeping's
  `wettedLoads`. Pass a pressure built from the host's gravity, because `wettedLoads` otherwise falls back to its own
  9.81. That gives the force and its moment about the centre of mass, exact at any attitude.
- Ellipsoid: the submerged part's centroid is a unit sphere's cap mapped through the axes.
  - Let s be the centre's depth over the half-height along the vertical. The cap has height h = 1 + s.
  - Its centroid lies 3 (2 − h)² / (4 (3 − h)) from the centre, toward the cap.
  - Map it back by x = Σ aᵢ xᵢ eᵢ. The moment is (centroid − G) × ρ g V_sub.
- Then take the buoyancy out of the force applied at the shape's centre (`loads/solver.ts`), and size `bodyForces`
  with `bodyRowsOf`, as the other body-pushing solvers do.
- Sources:
  - DNV-RP-C205 (2010) section 6.13, for small bodies;
  - the spherical cap's centroid, a textbook result.

**SEA-03 rogue waves.** Research for the high-order spectral (HOS) focusing tier.

Model:

- Dommermuth and Yue (1987) and West et al. (1987), carrying the surface potential and elevation to order M 3 to 4.
- Dealiasing: enlarge the grid by (M + 1) / 2.
- Time step: the linear part exactly, then adaptive Cash-Karp RK4(5) on the rest.
- Finite-depth operators carry tanh(kh), as in Wang and Pan, Dommermuth 2014 and Toffoli et al. 2010. Dommermuth
  2014's eq. 17 ramp is misprinted: as printed, it switches the nonlinear terms off after T_a.

Breaking:

- Onset at Bx = u / c > 0.855 (Barthelemy et al. 2018; Derakhti et al. 2020 for shallow water).
- A slope check at |η_x| = 0.5774 (McAllister 2023), which also guards against blow-up.
- Dissipation by Tian's eddy viscosity, or by Derakhti's breaking strength b = 0.034 (Γ − 0.30)^2.5.

Tests:

- Chabchoub et al.'s (2012) Peregrine tank case (f0 1.7 Hz, a0 0.01 m, ε 0.116), which amplifies by about 3.
- Benjamin-Feir growth: fastest at K = 2 ε k0, at rate ε² ω0 / 2, and unstable below 2.83 ε k0.
- Onorato et al. (2005, Marintek): second order underestimates crests after 17 wavelengths.

Cost and use:

- A Fitzgerald patch of 2.5 by 1.25 km on a 256 by 128 grid (512 by 256 padded) costs 80 to 120 FFTs a step. That
  is 2 to 4 Gflop per simulated second, so it needs a Rust and Wasm kernel.
- Blend the patch into the second-order sea over a ring two wavelengths wide.
- To place a rogue, run the NewWave group backward linearly and iterate on the focus point, or seed a Peregrine
  breather.

**SEA-05 nearshore waves.** Research for the reef orbital flow:

- Near-bed orbital velocity:
  - Soulsby (2006), with skewness and asymmetry from Ruessink, Ramaekers and van Rijn (2012) and the waveform of
    Abreu et al. (2010);
  - van der Lugt et al. (2024) refit it for sheltered, fetch-limited sites.
- Flow inside canopies: Lowe, Koseff and Monismith's (2005) two-layer equation, in Neshamar et al.'s (2023) closed
  form (their eq. 23).
- Flexible blades: Luhar and Nepf (2016) and Lei and Nepf (2019), with le/l = 0.94 (Ca L)^−0.25.
- Reef friction: fe of about 0.1 on the reef flat and 0.4 on the forereef (Davis et al. 2021).
- Reef-flat currents: a wave-enhanced bed stress with C_D 0.01 (Lentz).
- Test numbers:
  - Soulsby's worked case gives 0.568 m/s (H 1 m, T 6 s, h 5 m).
  - Ruessink et al. at Ur 1 give B 0.711 and Ψ −29.5°.
  - Neshamar's limits are 1 / I as D → 0, and 0.009 at D 100 (λ 0.05).
  - A reef flat with a 0.05 m setup over 500 m, h 1 m and C_D 0.01 flows at 0.31 m/s.

Phase-resolved tier: non-hydrostatic shallow water (Zijlema, Stelling and Smit 2011; Smit's 2008 MSc and 2014 PhD
theses).

- Dispersion:
  - one layer, ω² = g k² h / (1 + (kh)² / 4), within 1 percent up to kh 0.5;
  - two layers, ω² = g k² h (1 + (kh)² / 16) / (1 + 3 (kh)² / 8 + (kh)⁴ / 256), within 1 percent up to kh of
    about 7.8.
- Breaking by the hydrostatic front approximation (Smit et al. 2013): hydrostatic where the surface rises faster
  than 0.6 c, held at 0.3 c beside a breaking point.
- Bed friction by Manning: c_f = n² g / h^(1/3).
- Validation:
  - Demirbilek et al.'s (2007) reef flume: 15 conditions, with wave heights scattered by 2.4 to 9.8 percent and the
    reef-flat setup by 0.17 and 0.19;
  - Buckley et al.'s reef flume (16 runs);
  - Beji and Battjes's (1993) bar.

**SEA-01 wave spectrum.** Research for the young lake sea and swell decay.

The Fitzgerald's sea was limited by duration, not fetch:

- At 25 m/s over 200 to 300 km a sea needs 12 to 16 h to develop; with 9 to 12 h, the growth laws give 5 to 7 m.
- Hultquist, Dutter and Schwab (2006, BAMS) hindcast Hs 7.8 m, at the top of that band. This is consistent with
  unstable cold air over warm water.

Test numbers:

- JONSWAP's laws at 25 m/s over 200 km give Hs 5.71 m and Tp 10.38 s.
- The USACE Coastal Engineering Manual (CEM) gives 6.55 m and 8.60 s. Its 9 h duration limit gives an equivalent
  fetch of 101 km and Hs 4.65 m.
- From the CEM hindcast tables, a lake sea's steepness is about 0.036, against the Pacific's 0.017.

Spreading and depth:

- The current `jonswap` seeding spreads cos² (32.5° rms). A young wind sea is about 22.8° at the peak and 41.5° in
  the tail, following Donelan, Hamilton and Hui's (1985) sech².
- TMA's depth factor is tanh²(kh) / (1 + 2kh / sinh 2kh).

Swell decay: Ardhuin, Chapron and Collard 2009 (GRL 36, L06607; not JPO, as the row says).

- Observed energy e-folding lengths run from over 20,000 km down to 2,800 km for the steepest swells, with decay
  rates of −0.6e-7 to 3.7e-7 per m.
- Laminar decay is 2.2e-8 per m at 13 s and 5.8e-9 per m at 19 s.
- Ardhuin et al. 2010 (JPO 40) give s1 0.8, s2 −0.018, s3 0.015, a laminar coefficient of 1.2 and a critical
  Reynolds number of 2e5 m / Hs. The prefactor of the 2009 paper's eq. 6 is unreadable in both copies.

Held-out gale: 30 m/s over 100 km by the combined Kahma-Calkoen law (Karimpour and Chen 2016) gives Hs 6.16 m and
Tp 9.3 s. Stable air gives 5.23 m and unstable air 7.22 m; the split is in Kahma and Calkoen's 1994 chapter.

**ATMO-04 precipitation.** Research for rain carried by the gusts, splashes and snow:

- Each drop relaxes to the wind over v_t / g. Big drops hit the sea at 0.85 U10, and small drops lag:
  u = 0.85 U10 (1 − e^(−5000 r)). Source: Veron and Mieussens 2016, with Marshall-Palmer and Best's fall speed in
  radius form.
- Splash regimes follow the Weber and Froude numbers (Murphy et al. 2015 and later papers). Secondary droplets
  follow r^(−5/2).
- A drop's ring leaves a calm disk that grows at 0.178 m/s (Laxague and Zappa 2020).
- Rain damps waves at k R ρ_drop / ρ_water with no wind (Kuo and Hao 2026). A 5 m wave keeps 0.94 of its amplitude
  after 1 h at 50 mm/h.
- Snow: Locatelli and Hobbs (1974, JGR) give fall-speed and mass laws for aggregates of unrimed dendrites, for
  densely rimed dendrites and for the graupel types, but not for single dendrites. Their table belongs in the test.

**FLUID-03 built (2026-11-26), not LANDED: what is done and what its upgrades start from.** Checked against the
eight points before setting a status, it falls short on points 2 (no MARIN validation), 4 (no two-way wave passage)
and 6 (hot loops in TypeScript, no Wasm or threads), and crest overturning (KB-FLIP-CREST1) is open, so it stands
REOPENED and its upgrades go to Codex under the split of the work queue. Done, one line each:

- Crashing crests: the liquid box sits in the sea where waves steepen (290aba7e2); `flip.test.js`.
- A box held to the sea keeps a calm sea calm, keeps its water and passes waves in phase (2232ca7c4, KB-FLIP-SEABAND1).
- Water slips along a solid as along the box's sides and comes back out of one (4e2e6f26d, KB-FLIP-SOLIDSLIP1).
- Waves come in at the sides from the wake, and the box gives the wake its water; the sea's velocity at depth below a
  patch (4ec0717e8); `sea-wake.test.js`.
- Trapped air by particle deficit, foam over it and spray handed to SEA-13 (0dddec890).
- The 3-D dam break against Lobovsky et al. 2014 (efd218e88, `check-dambreak3d.mjs`).
- The plunging-breaker study measured as Erinin et al. measure, and the gauge control (dbe79b009, e998f2989).

Findings the upgrades start from:

- **Pressure-coupled open sides were tried and not shipped (815e0fc77, `docs/limits.md`).** Making the box's sides a
  pressure boundary driven by the sea, in place of the band that holds the particles to the sea, let the incoming
  wave in too strongly: a 3 cm wave read 43 to 73 percent too high inside the box, so the code was reverted. Two-way
  wave passage needs a coupling that keeps the water and does not pump it, for example an overlapping box and wake.
- **Gauge control (e998f2989, KB-FLIP-CREST1).** The liquid's wave group matches the sea's at every grid resolution
  up to the focus; the grids part only at the crest, where the jet speed does not converge. Crest overturning is the
  open part.
- **MARIN 3-D dam break data (SPHERIC Test 2).** The measured series are on the SPHERIC benchmark page,
  https://www.spheric-sph.org/tests/test-02, as one zip: `test_case_2_exp_data.xls` (water heights H1 to H4 and
  pressures P1 to P8), the case PDF `test_case_2_v1p1.pdf` and a Fortran file (code: not to be read under the clean
  room). The ComFLOW copies at math.rug.nl return 404.

Open, for Codex: the Rust/Wasm port with SIMD and threads; two-way wave passage through an overlapping box and wake
that keeps the water; KB-FLIP-CREST1 (crest overturning); the MARIN validation against SPHERIC Test 2.

**SEA-02 and SEA-04: the water's velocity below a patch, done (4ec0717e8, FLUID-03).** Codex builds on it:

- `WakeSolver` made with `waterBelow` keeps the potential's gradient at depth layers each step, each mode decaying as
  cosh(k (D - d)) / cosh(k D). The layers are extra state, so a snapshot restores them. `velocityAt(x, y, z)` reads them.
- `SeaPatch` gains an optional `velocityAt`, and `SpectralSea.water.sample` adds it.
- Tests in `sea-wake.test.js`: a single mode against the linear potential's decay, deep and 3 m deep, within the
  bilinear reading's (k dx)^2 / 8; and the sea's water equal to the wake's below its surface.

**SEA-04 boundaries and hull sources.** Research handed to Codex, which builds the upgrade:

- Walls are a Neumann condition (∂φ/∂n = 0, the wave's slope across the wall zero). Masking the height to zero
  (h ← O h, as iWave does) is a Dirichlet wall: it flips the reflected wave's phase, puts a node at the wall and
  diffracts weakly. Schreck, Hafner and Wojtan (2019, "Fundamental solutions for water wave animation", SIGGRAPH,
  doi 10.1145/3306346.3323002) show the difference.
  - Their method places Helmholtz sources −(i/4) H₀⁽²⁾(k|x − y|) inside each obstacle per wavenumber. A least-squares
    fit cancels the incoming wave at boundary samples λ/6 apart (sources λ/3 apart). Moving obstacles are
    time-delayed.
- Water Surface Wavelets (Jeschke et al. 2018, doi 10.1145/3197517.3201336) reflect an amplitude A(x, k, t) at a wall
  by k_r = k − 2 (n · k) n. That is geometric optics with no true diffraction, in deep water only. Water Wave Packets
  (Jeschke and Wojtan 2017) add ghost packets for diffraction at grazing incidence.
- A grid alternative is Neumann volume penalisation (Kolomenskiy and Schneider 2009, JCP 228, 5687; Kadoch et al.
  2012, arXiv 1403.5948): −∇·[(1 − χ) + η χ] ∇v = f, error O(η), condition number O(1/η).
- Partial reflection in the mild-slope equation (Berkhoff 1972; Tsay and Liu 1983, as CGWAVE uses it):
  ∂η/∂n = α η with α = i k (1 − K_r)/(1 + K_r). A sponge layer (Kirby 1998, FUNWAVE) damps over 2 to 3 wavelengths.
- Exact checks for the tests:
  - A standing wave at a wall: η = 2A cos kx cos ωt, an antinode at the wall, the height doubled.
  - The semi-infinite breakwater (Sommerfeld; Penney and Price 1952):
    - F = [½ + f(σᵢ)] e^(−ikr cos(θ − θ₀)) + R [½ + f(σᵣ)] e^(−ikr cos(θ + θ₀));
    - f(s) = ((1 + i)/2) ∫₀ˢ e^(−iπu²/2) du, with σᵢ = 2 √(kr/π) sin((θ − θ₀)/2) and
      σᵣ = −2 √(kr/π) sin((θ + θ₀)/2);
    - |½ + f| is 0.045, 0.111, 0.203 and 0.5 at σ = −5, −2, −1 and 0, with a peak of 1.1707 at σ = 1.217.
  - MacCamy and Fuchs: run-up η/A on a vertical cylinder, front and rear.

    | ka | Front | Rear |
    | --- | --- | --- |
    | 0.1 | 1.004 | 0.998 |
    | 0.5 | 1.432 | 0.995 |
    | 1.0 | 1.707 | 0.888 |
    | 2.0 | 1.859 | 0.732 |
    | 4.0 | 1.947 | 0.543 |

    The force is F = 4 ρ g A tanh(kd)/k² · A(ka), with A(ka) = 1/|H₁′(ka)| = 0.0159, 0.394, 1.077 and 1.762 at ka =
    0.1, 0.5, 1 and 2.
- The hull as a source: Wave Particles (Yuksel, Keyser and House 2007) emit V = A_face (U · N) dt per face at the
  waterline. A pressure patch (Darmon, Benzaquen and Raphaël 2014, JFM 738, R3) gives the Kelvin wake.

**SEA-13 bubbles and plumes.** Research handed to Codex, from the FW-4 build (`@margoengine/physics/bubbles` already
carries a ship race's air as parcels):

- Where air enters (Moraga et al. 2005, Mecánica Computacional XXIV; the journal version is Comput. Fluids 37(3),
  2008): the breaking bow wave, the hull's contact line and the transom.
  - Their source is E = S₀ f_E(D) dD Σ δ(x − x_s), where the water is less than φ_ent deep and moving down faster than
    v_ent = 0.22 m/s.
  - Measured void fractions are 10 to 20 percent at the bow wave, the contact line and the transom (DTMB 5415,
    Fr 0.35).
- Castro's thesis (2011, University of Iowa, R/V Athena) gives an entrainment rate and the propeller's effect:
  - S = S₀ D_ent E Λ(α), with E = (∂Uₙ/∂n) k/(g φ_ent v̄_ent), only where ∂Uₙ/∂n > 0 and the depth is under φ_ent
    (10 cm);
  - Λ = max(0, (α_c − 0.7)/0.3);
  - a spectrum of r^−2.35 up to 2.5 mm, in 15 groups from 10 µm to 4 mm;
  - rectified diffusion grows bubbles from about 23.5 to 400 µm and from 130 to 700 µm as they pass the propeller
    (Raju et al. 2009, DTMB P5168).
- In breaking crests, Ma, Shi and Kirby (2011, via Kirby et al., ICCE 2012) give
  B = (c_b/4π)(σ/ρ)⁻¹ α_l ε f(a) da / Σ a² f da.
- Deane and Stokes (2002): the size spectrum goes as r^−3/2 below 1 mm radius and r^−10/3 above.
- Wake measurements:
  - Trevorrow, Vagle and Farmer (1994, JASA 95(4), abstract): the top 5 to 6 m, up to 66 m wide at 10 kn, 7 to 12 m
    deep, strong for about 7.5 min.
  - Stanic et al. (2009, IEEE JOE 34(1), abstract): spectral slope −3.6, void 4e-7 in a young wake.
  - Trevorrow (2006, Canadian Acoustics 34(3)): the wake about two drafts deep.
- Background ocean void (Castro's fit to Melville 1995): α(z) = 1e-4 for z < 0.5 m, then
  1.8e-5/((0.1 + z)³ (1 − 0.098 z)) to 7.5 m.
- Dirty-bubble rise speed (Thorpe 1982; Keeling 1993; as Deike and Melville 2018, GRL 45, 10482 give it), with
  ν = 1.05e-6:
  - w = (2r²g/9ν)[√(η² + 2η) − η], with η = 10.82/χ and χ = g r³/ν²;
  - 0.50, 1.58, 3.49, 6.75 and 9.99 cm/s at 50, 100, 200 and 500 µm and 1 mm;
  - turbulence slows it 30 to 70 percent.
- Dissolution (Castro):
  - ṁ = 2π Sh κ R (C∞ − C₀), with C₀ = H (p + 2σ/R), κ = 2e-9 m²/s and Sc = 500;
  - about 2 min for 100 µm and 2.5 s for 10 µm at the Athena's stern;
  - Weber et al. (2005) needed gas transfer about 15 times slower than for clean bubbles to explain wakes that last
    about 30 min.
- Bubbles last 0.3 to 30 s on the surface in salt water (Anguelova and Huq 2017).
- Propeller cavitation:
  - σₙ = (p − p_v)/(½ ρ (nD)²);
  - inception at σᵢ ≈ −C_p,min = k C_l² Re^0.4 (Billet and Holl, via Brandao 2024);
  - an upper bound on the tip-vortex cavity, r_c = Γ/(2π W √σ) (Pennings 2016 thesis).

### SEA-15 film upgrade progress

BB-7 now uses the Soulsby–Whitehouse grain-specific Shields curve and van Rijn's three-halves-power
pick-up rate by default. A manufactured bed-stress test runs through the real swimmer and checks both
grain classes, below and above onset, against the published equations. The ray uses radial Phares wall
shear and annular pickup where clearance reaches its nozzle diameter. Four independent electrochemical
points check the downstream wall-stress law. At two to four nozzle diameters, the optional developing wall layer
adds the secondary shear rise. The 14 independent stress points give RMS log error 0.097, down from 0.127.
The native ray lifts extra sand and the paired fixed-camera scene advects and settles it. Independent lifted mass,
the short-gap jet and the original shot's plume and bed binding remain open.

EF-11 can now release coarse taconite pellets and suspended ore fines through the same live hull opening.
The two grain classes account for the hull's cargo flux separately, including fractional parcels, and the
pellets settle farther than the fines. The traced cargo keeps its mass, physical position and replay when the hull
and tracer step in separate origin cells. The measured sediment plume and original EF-11 playback remain open.

The tracer entry can now query a live `SeaSurface`: the slick follows wave height and surface velocity,
and submerged dye follows the sea's depth flow in a different origin cell. The test checks live SEA-02
coupling and exact replay. Independent dispersion measurements remain open.

BB-7's live terrain exchange now debits the parcels' packed volume from a finite mobile layer and deposits
it under the settled grains. The CPU and render fixtures check cut, deposit, final volume and replay.
Erosion at each triangle vertex now stops independently at its own mobile mass. A depleted corner leaves
the two other vertices available. The two-cell wash regression lifts 5.30 kg where the old shared cap lifted
2.65 kg, with zero rejected bed volume and exact replay.
An offset swimming origin now produces identical parcels and packed-bed debit when translated along all three
cell axes. The same test restores the snapshot and repeats the following ticks exactly.
Rotating the fin and planar bed together preserves the released mass and rotates the pickup footprint.
The local terrain correction uses the source triangle and leaves irregular-terrain flow and oblique shear open.
The original shot binding, independent lifted mass and multi-writer bedrock acceptance remain open.
Fin-jet parcels now enter at the van Rijn Part II Eq. 37 reference level using measured bedform height or
roughness when supplied and a minimum of 1% of the local depth. The fixture checks explicit and default levels
through the live ray. The rough-bed render moves 17.1 px downstream and leaves 674.8 µm of bed relief on both backends.
The pickup closure now accepts measured grain properties and the optional high-stress damping of van Rijn et al.
(2019). Four held-out BOKA sand retreat rates give a lower pooled RMS log error, 1.734 to 0.734, when forced by
the independently measured bed stress. The strongest underprediction is a factor of 2.81. The ray's directly
measured lifted mass and short-clearance wake remain open.

The SEA-15 consumer is rebased on Lane D's `4ec0717e8a`. A calm-spectrum test with a real `WakeSolver`
confirms submerged dye follows the analytical potential gradient through `SpectralSea.water`.

Finite instantaneous oil releases now use Fay's three radial laws, with mass conservation, current transport and
snapshot replay checked separately. Stiver–Mackay evaporation uses the integrated Fay area and preserves a separate
vapour ledger. The integrated exposure matches an independent quadrature of the radius laws at two simulation rates.
With a prescribed fixed exposure area, the model also agrees with seven independent 0 °C Norman Wells measurements
within 0.45 percentage points at worst. The atmospheric distillation curve supplies the oil parameters.
Surface emulsification tracks entrained water separately, increases the displayed film thickness and reports
mixture density and viscosity. In the independent Troll Charlie samples from 7.3 to 33.5 hours, the uptake curve
has 2.13 percentage points RMS error against 2.38 points of sample scatter. At one hour it is 36.74 points low.
Early uptake and changing spreading rheology remain open.
A finite water pool now exchanges soluble constituents with the slick and tracks optional first-order
biodegradation. The 24 h Kuwait crude naphthalene result is 67.60 µg against 75.70 µg measured,
using separate solubility, assay and transfer coefficients. The next checks cover transient
component loss, measured biodegradation and dissolved transport in open water.
A fixed-volume waxy film now reports its thickness and follows the Brönner Bingham yield force. Nine independent
tank terminal radii lower the RMS log radius error from 1.056 to 0.480 compared with Fay's unyielded radius at the
reported 180 s measurement time. The simulated 30% blend under-spreads by a factor of 3.59 against the run that
fractured. The constant-rate gravity-driven patch now covers the unyielded MGO tank release through shutoff. Its
six independent radii give 0.134 m RMS error, compared with 1.081 m for the same oil released instantly. Waxy
continuous flow, fracture, field extent and evaporation measurements for an expanding slick remain open.

Vertical tracers now accept a depth profile and include the diffusivity-gradient drift and midpoint variance from
Visser (1997). For Coastal Mixing and Optics Experiment 4, the independent EPSONDE microstructure samples drive
the profile. The local simulated broadening falls in the range inferred from separate Rhodamine fluorescence surveys.
Migration under solar heating and shelf-scale dispersion remain open.

Tracers can use wave-averaged Stokes transport from a fixed directional spectrum and a separate mean current.
The crossed-wave test checks the directional sum and depth decay in finite and deep water. The normal live-velocity
mode still follows the SEA-04 wake potential. In Melito et al.'s 120 mm shallow platform experiment, a wave spectrum
driven by measured water elevation falls inside the three independent subsurface tracking profiles' envelope at
five sampled depths. The RMS discrepancy across the 15 reported points is 0.82 mm/s. Field and breaking-wave
transport measurements remain open.

Horizontal dispersion can now increase with release scale. The benchmark uses Poje et al.'s separate drifter data
for calibration and Okubo's nine Cape Kennedy dye extents for comparison. Each independent dye extent is closer
with the scale law than with the constant reference diffusivity. The largest discrepancy is a factor of 2.34 in extent.

Breaker energy and turnover can now entrain a finite slick into buoyant droplets using Delvigne–Sweeney. The
model integrates the diameter classes, returns resurfacing oil to the slick, and keeps the vapour ledger separate.
Independent measurements of absolute entrainment and intrusion depth remain open. The modern untreated-oil slope
and its upper-size transition differ from the original law, as recorded in the clean-room notes.

A resolved wash field now drives sediment pickup from the actual bed normal and roughness. A native ship's
propeller lifts sand and debits its volume from TerrainBed, while a stopped screw lifts none. The wash API also
accepts a supplied thruster field. `ShipSolver.water` now supplies a configured bow tunnel's live discharge. A
reversing command switches outlets, and the SEA-15 bed deforms as the resulting jet carries the same dry mass.
The fixed-camera sediment test renders 835 WebGPU and 840 WebGL2 sand pixels at lift. Both paths move the plume
8.6 px downstream and clear it as the bed settles.
The established free-jet centreline is 12.7% high against Xia and Lam's independent fit at 20 diameters. Confined
tunnel flow and independent lifted-mass validation remain open.

Cohesive sediment can now grow and break up under supplied local concentration and turbulence. Its evolving
diameter and porous density drive settling while the dry-mass ledger stays conserved. The settling trajectory
converges against the Winterwerp equation and the breakup case replays exactly. Given measured aggregate size,
settling improves over primary-grain settling at all four Wax Lake Delta profiles. Its largest remaining error
is a 5.01-fold underprediction in the fall profile. An optional shear-limited breakup law predicts aggregate
sizes during three held-out dilution trials. Across 15 sampled phases its RMS error is 6.58 µm against pooled
measurement scatter of 6.84 µm, with a 12.22 µm peak. The field fall transport remains open.

## Verification passes

A reviewer checks each row Codex sets LANDED (after a reopen, or on its first landing) against the eight-point
standard and the row's entry here: it reads the diff and tests, runs the row's CPU tests and its GPU tests where it
has them (under `scripts/run-with-timeout.mjs`), confirms each validation test asserts against the cited measurement
or exact solution with a derived bound, and confirms each listed item is done. The row is then VERIFIED, or REOPENED
with the reasons below, which become its work list.

## Pass 1, 2026-11-26 (`main` at 004304517)

No reopened row had been set LANDED again. Five rows had their first landing; **VERIFIED 0, REOPENED 5.** All five
are real work with sound exact-solution checks; none yet validates against independent measurements, and one left a
failing test on `main` (KB-SOFT-SPLITDENSITY1).

### SOFT-03 hair, fur, mane, tail, feathers (landed c53e60dc12): REOPENED

- **Checked:** 12 commits from 1f99e19bf to c53e60dc1. CPU tests (`coupling/strands.test.js`, `horses/test/strand-horse.test.js`, `rigging/tests/strand-springs.test.js`, `rigging/tests/springs.test.js`): 45 pass, 0 fail. `test:browser:strands` passes on WebGPU and the WebGL2 compatibility layer (720 points, 3,022 wind-driven pixels, the same replay hash on both).
- **Validation:** exact and classical solutions with derived bounds, nothing fitted to its own check: hanging-rod extension ρgL²/2E (128 ε), discrete cantilever under its own weight (1 − 1/n)² wL⁴/8EI with Fujita and Tohmyoh 2020's 3.45 GPa as input, rachis bending with Bachmann 2012 section moments as input, finite-amplitude pendulum period (DLMF 22.19, 1/60 s), leaf beam in cross-flow, capsule impulse momentum (3e-6). Solid work; none of it is a measured motion.
- **Fails points:** 1, 2, 3, 4, 6, 7, 8. Point 5 passes (coded `MargoError`).
- **To do before it can be VERIFIED:**
  1. Validate against measured motion: Bertails et al. 2006's comparison of predicted and filmed strand shape and motion; calibrate the horse bundle stiffness (`young: 32e6` and `60e6`, `horses/src/strands.ts:98-99`, uncalibrated per limits).
  2. Add a super-helix element (Bertails et al. 2006) with a curly-hair rest-shape test; today the model is Kugelstadt–Schömer Cosserat segments only.
  3. Test the extremes with derived bounds: hurricane wind, large time steps, high-speed root whip.
  4. Build fur strand dynamics (the fur shells have none), feather and wing bindings beyond a rachis beam, and a strand binding for `humans` head hair (only the VRM ponytail has one).
  5. Interpolate guides into render hairs; the horse uses cards weighted to guides.
  6. Two-way coupling: wind drag reaction, cloth (SOFT-01), water and wetness, two-way bed contact.
  7. Scale: explicit SIMD (today compiler auto-vectorisation only), threads, and work counts at thousands of guides (largest fixture is 720 points).
  8. Film control: pull toward the animated or groomed pose, placed events; replace the arbitrary motion thresholds in `strand-horse.browser.mjs:24` and `strand-springs.test.js:62`.
  9. Fix the stale number in `docs/limits.md` (2,907 changed pixels; the run measures 3,022).
  10. Close the named film rows LH-5, OPENING-NIGHT-9 and HORSE-1, still OPEN in the demo review.

#### SOFT-03 four-point pass

- Point 5 (2d3a281145). `packages/physics/tests/coupling/strands.test.js` checks the owned-memory and signed-cell contract through a live rigid coupling with nonzero swept impulse. A malformed layout, unaligned port or invalid duration retains exact accepted bytes and the native receipt. Valid borrowed rows replay exactly in both memories.
- Point 6 (2d3a281145). `packages/physics/tests/coupling/strand-workers.test.js` and `packages/physics/tests/strand-workers.browser.mjs` check independent SIMD point prediction with 1, 2 and 4 participants in plain and shared worlds. One case has 1,025 guides and 3,075 points, and another has 1,193 guides and 5,965 points. The larger case visits 3,578 paired moving points. Centreline, frames and reciprocal rigid reactions repeat exactly across thread counts and restore.
- Point 7 (2d3a281145). `packages/physics/tests/strand-film.browser.mjs` drives the weighted bay horse with a registered signed ATMO-02 gust. All 58 guide rows agree with skin joint transforms. Tail, mane and forelock tips move 7.2, 5.7 and 12.9 cm against the still-air take. A separate signed crossflow probe gives its analytic 0.948 mm. Both renderers replay complete accepted state and RGBA. The original 720-point renderer check recorded 2,907 changed pixels on both backends in the workstation rerun.
- Point 8 (2d3a281145). `packages/physics/scripts/soft03-strand-measured.mjs` scores independent Akanda et al. single-fibre bending without fitting to the four measured values. The default modulus underpredicts all four by 1.86–5.74 µm. The model gives quasistatic results and film-clump motion remains open. [Measured bounds](limits.md#soft-03-measured-single-hair-bending)

Superhelices, calibrated moving clumps and horse bundles, guide interpolation, production shot wiring and additional reciprocal media remain open. The row stays REOPENED at four points.

### SOFT-04 volumetric solids (landed a0de32ed1b): REOPENED

- **Checked:** a0de32ed1b, 07a8b6b82 and the history behind them from b3a3d3a6e to 84a2a1985. CPU (four `volumetric-*.test.js` files, `soft-cells.test.js`, `world-soft-solver.test.js`): 96 pass, **1 fail** on `main`: `soft-cells.test.js` "a cloth torn in two becomes two cloths" throws "A trimesh with a mass or a density must be a closed surface" (KB-SOFT-SPLITDENSITY1). `test:browser:volumetric-solids` passes on WebGPU (0 WGSL errors); the script has no compatibility-layer run.
- **Validation:** orthotropic compliance and fibre response are genuine exact solutions. The regime tests are circular: gelatin and flesh feed the measured μ (Gravelle et al. 2021; Geerligs et al. 2008) in and check one tet at 0.08% strain against μV/L² built from the same μ (`volumetric-solids.test.js:122`); ice passes the Frederking and Timco 1983 strain to `setTensileNucleation` and moves particles kinematically to 0.9 and 1.1 of it, never exercising the ice's elastic response (`:168`); beech uses the published strengths as the thresholds (`volumetric-strength.test.js:80`). The LH-4 sag bound is arbitrary (`:72`).
- **Fails points:** 1, 2, 3, 4, 5, 6; 7 and 8 in part (`docs/limits.md` calls the regime checks validation).
- **To do before it can be VERIFIED:**
  1. Fix the regression: `packages/physics/src/soft-split.ts:49` copies `density: collider.density()` into the rebuilt surface collider (from ef1a72d01), so an open cloth fails the closed-trimesh check. The failing test is the regression test.
  2. Validate behaviour against measured curves the code does not take as inputs: Treloar 1944 rubber uniaxial and biaxial; gelatin large-strain curves (Gravelle et al. 2021); Frederking and Timco 1983 load-deflection and failure load from a simulated cantilever. Large strain, rubber and inversion have no measured check today.
  3. Make the LH-4 timber timber: `volumetric-ladder.js` uses E = 2 MPa and the browser test 12 MPa, against about 12.5 GPa for beech (Seeber et al. 2024), so the 23.8 mm sag and 0.015 crack strain are not physical.
  4. Coded errors: `soft.ts` has 121 `RangeError` throws against 18 `MargoError`.
  5. Scale the vertex-block solve: `soft-kernel/src/vertex_block.rs:110` is serial Gauss–Seidel with no graph colouring, threads or GPU (Chen et al. 2024's parallel colouring), and its Hessian drops the (λ(J − 1) − μ)∂²J term with no PSD projection.
  6. Couple to fluid buoyancy, thermal (for ice), cloth and SOUND-04 modal contact; only rigid and hull couplings are tested.
  7. Finish the items the docs list as open: GPU handoff, kinked and orthotropic mixed-mode propagation, the production binding.

### FLUID-02 position-based liquids (landed 14a5956173): REOPENED

- **Checked:** 339e4c1cc, 14a595617, 313a4c51e, 818aeab2c, 26ddb53dc, and ea4320111 (FLUID-01, which shares the Rust crate). CPU (`pbf.test.js`, `coupling/pbf.test.js`): 16 pass, 0 fail. `pbf.browser.mjs` passes on WebGPU and with `--compat` (15,319 changed pixels, 5 shaders, 0 errors); both are smoke tests (front moves more than 0.32 m, mass constant, pixels change).
- **Validation:** Martin and Moyce 1952 table 2 surge-front intervals (`coupling/pbf.test.js:211`) with a ±0.149 margin derived from step size, table rounding and film frame rate; nothing fitted to it, but the bands are wide enough that both presets pass. The rest are exact single-step checks (Poly6 kernel, Jacobi update, XSPH, free flight, scale invariance). No hydrostatic or rest-density case. A resting 10 × 30 × 10 particle column 60 cm tall, run by the reviewer, settles to 72% of its height after 4 s with the fast preset (peak density error 0.96) and 83% with the precise preset (0.31), still sinking at 0.4-0.6 m/s.
- **Fails points:** 1 to 8.
- **To do before it can be VERIFIED:**
  1. Incompressibility: test hydrostatic pressure ρgh and a column at rest with a derived density-error bound, and the Martin and Moyce residual column height.
  2. Remove the global clamps and fix their cause with substeps (Macklin and Müller 2013 §5): `pbf-kernel/src/lib.rs:401` rescales every particle's velocity to an energy budget, and `lib.rs:356-362` and `680-689` shrink every correction when any one is large. They couple unrelated regions, and `coupling/pbf.test.js:45` passes because of them (KB-PBF-CLAMP1).
  3. A second validation case not used for tuning: Koshizuka and Oka 1996 or Lobovsky et al. 2014 dam-break pressure probes.
  4. Put the fast and accurate tiers behind one API (today `PbfSolver` and `DfsphSolver`; "precise" is the same PBF solve with 12 iterations).
  5. Coded errors in `src/pbf/index.ts` and `boundary.ts` (`TypeError` and `RangeError` today).
  6. Rival capabilities: physical surface tension (Akinci et al. 2013), multiple densities, mesh boundaries, whitewater and spray (Ihmsen et al. 2012), unified solids and cloth (Macklin et al. 2014); Salva and FleX have them.
  7. Coupling beyond DYN-01: the particle-to-shallow-water handoff (PA-22, open in known-bugs).
  8. Threads and large-scene work counts.
  9. Film output and control: spray, foam and whitewater (the browser run shows none), targets and guides.
  10. State the measured compression in `docs/limits.md` and stop presenting the clamps as conservation.

### ATMO-10 synoptic weather and moisture transport (landed d19267aa1e): REOPENED

- **Checked:** 736727ab7, 3ef586295, df469b302, 033798119, d19267aa1, c3af6eca2, 17cfd3df9. CPU `coupling/synoptic.test.js`: 13 pass, 0 fail. `test:browser:synoptic` passes (58,381 changed pixels, 9 shader modules, 0 errors; the script has no compatibility-layer run).
- **Validation:** exact solutions with roundoff-derived bounds: discrete geostrophic balance, Crank–Nicolson Rossby phase, solid-rotation curved-flow balance, cloud and fallout time solution, Phillips two-layer growth rate. The Smith–Barstad test covers only zero stratification. The Garratt and Donelan "measured" values are the Garratt formula evaluated at 10, 40 and 80 m/s, so the code is checked against itself. Nothing is compared with observations.
- **Fails points:** 2, 3, 4, 7, and 6 in part (no threads). Points 1, 5 and 8 pass.
- **To do before it can be VERIFIED:**
  1. Validate against observations: an atmospheric-river IVT case (Ralph et al. 2004; Neiman et al. 2008) and an orographic rain case (Barstad and Smith 2005, Olympic Mountains).
  2. Test the Smith–Barstad wave branch with normal stratification (N ≈ 0.01 s⁻¹) against its eq. 19 (`src/synoptic/index.ts:568-571`).
  3. Replace the untested straight-line drag blend between 21 and 33 m/s (`index.ts:222-226`) with Donelan et al. 2004 or Powell et al. 2003 data, and test that range.
  4. Condense only saturated rising air (`synoptic-kernel/src/lib.rs:503` condenses on any ascent), and take the lift sensitivity from the moving temperature field instead of a fixed 288.15 K.
  5. With two layers on, compute IVT from both layers (`index.ts:632-633` uses the lower layer only).
  6. Two-way coupling: evaporation from sea temperature and wind instead of a user value; momentum back from the water drag; a runoff mass-handover test (today it asserts only rain > 0); the SEA-07 adapter (open in known-bugs).
  7. Add surface friction and dissipation to both layers (`layers.rs:170-200`) and test the nonlinear life cycle for energy and enstrophy (pyqg has bottom drag).
  8. Film control: placed events, targets and seeds; close RITS-6 to 9, CF-1 and WIND-1/2, still OPEN in the demo review.
  9. Threads where the work splits.
  10. Correct `docs/whitepaper/claims.md`, which calls the high-wind drag plateau "measured" while the test only replays the formula.

#### ATMO-10 four-point pass

- Point 5 (34145ff6d6). `packages/physics/tests/coupling/synoptic.test.js` checks signed terrain and shallow-water fields, alignment and owning memory through a layered world. Invalid input late in a trial leaves the complete accepted snapshot, water force, layer state and native receipt unchanged. `packages/weather/tests/synoptic-drive.test.js` checks coded adapter errors with fixes.
- Point 6 (34145ff6d6). `packages/physics/tests/coupling/synoptic-workers.test.js` and `packages/physics/tests/synoptic-workers.browser.mjs` exercise optional f64 SIMD diagnostic cells and joined workers at 1, 2 and 4 participants. The layered 256-cell case dispatches 256 paired calculations in four 64-cell ranges. Fast, high and layered cases retain exact atmospheric and water outputs.
- Point 7 (34145ff6d6). `packages/physics/tests/synoptic-film.browser.mjs` runs the same fixed regional ridge with and without atmospheric uplift on each renderer. The rain band moves 54.0 km and peak precipitation reaches 4.848 mm/h. Terrain feedback yields 28.794 million m³ liquid rain against 0.983 million m³ in the control. The isolated runoff layer changes 13,431 pixels on each backend. The atmosphere and HYDRO-02 close accepted liquid rain and runoff volume each tick. Full snapshots, fields and raw RGBA match through replay on WebGPU and WebGL2.
- Point 8 (34145ff6d6). `packages/physics/scripts/atmo10-synoptic-measured.mjs` compares independent OLYMPEX rain gauges withheld from initialization and model settings. The 4 km model produces 13.56 and 23.84 mm against 32.60 and 35.56 mm. Terrain altitude, mesh refinement and lapse sensitivity are reported. Upstream IVT derived from the sounding supplies input evidence. [Measured limits](limits.md#atmo-10-observed-olympex-warm-sector-rainfall)

Downstream measured IVT, high-wind drag, combined-layer moisture, two-way sea feedback, energy and enstrophy through decay, and original production bindings remain open. The row stays REOPENED at four points.

### EARTH-05 terramechanics (landed 5032e1a3b4): REOPENED

- **Checked:** 5032e1a3b4, 40413c537, dc1ebb90e, 237815862 and the feature and fix commits on `packages/physics/src/terramechanics` from 237a751aa to 78f45688c. CPU (`terramechanics.test.js`, `coupling/terramechanics.test.js`): 38 pass, 0 fail. `test:browser:terramechanics` passes on WebGPU (3,904 changed pixels, plain and shared builds identical); it checks kernel parity, not a reference, and has no compatibility-layer run.
- **Validation:** sound exact closed forms (Bekker and Janosi pressure-sinkage and shear, two-region axle moment, sidewall integral, hardpan transition, 8-64 ε). A real held-out check: Apfelbeck square plates from circular-plate coefficients, bounded by the measured bar ±1 plot pixel. Ding Wh2 drawbar and torque within the marker edges, and the Pavlov crest-to-trough ratio for one condition: acceptable.
- **Fails points:** 1, 2, 3, 4, 6, 8; 7 in part (no seeds or targets for prints and dust). Point 5 passes.
- **To do before it can be VERIFIED:**
  1. Replace "held-out" checks that use parameters fitted to the same data with independent datasets: Salman's 200 mm plate against its own Fig. 6 regressions (`coupling/terramechanics.test.js:313-336`); Ishigami's kx(β), ky(β) fitted to the same FJS-1 tests (`:1003-1004`); Wh32's 0.72 slip exponent identified on the same wheel, with its 20% bound widened by an arbitrary 2× scatter (`:440, 459`).
  2. Use one cohesion for one sand (251 Pa at `:1071`, 250 Pa at `:450`), or justify the difference.
  3. Validate feet, hooves and tracks against measurements: Li, Zhang and Goldman 2013 resistive force theory, Setterbo et al. 2009 and Crevier-Denoix et al. 2010 hoof data, Wong's tracked-vehicle data. The hoof test only asserts that trot moves more soil than walk (`:1238-1243`).
  4. Model unloading, rebound and repeated passes (Wong; Holm); the bed keeps only the peak indentation. Chrono SCM has this.
  5. Return soil force to belts (`world/solvers/rigid.ts:144-176` applies reactions to wheels only) and couple feet beyond the bed shape.
  6. Add a high-fidelity tier (MPM, continuum SPH or resistive force theory); both tiers are Bekker semi-empirical.
  7. Real SIMD and threads: `f64x2` is used for single square roots only (`terramechanics-kernel/src/lib.rs:86-89, 258`).
  8. Correct the catalog row and the test names that call the checks in item 1 held out.
  9. Close HORSE-5, COURIER-3 and MAKING-3, still OPEN in the demo review.

## Pass 2, 2026-11-26 (`main` at e998f2989)

VERIFIED 0, REOPENED 1. SEA-07 was the only row set LANDED since pass 1; no Codex row was set LANDED.

### SEA-07 tides, storm surge and currents (`physics/surge`, e5462e9cc), owner Claude: REOPENED

**Checked.** The diff of `src/surge/index.ts`, `src/hydro/index.ts` (forcing potential, Coriolis, `timeScale` substepping, work counts) and `src/world/world.ts` (`checkTimeScales`); `tests/surge.test.js` (11 pass, 7.1 s), `tests/coupling/surge.test.js` (2 pass) and `tests/hydro.test.js` (16 pass), each under `scripts/run-with-timeout.mjs`. It has no GPU tests.

**Validation.** Exact or closed-form solutions with derived bounds:
- the inverse barometer, well balanced to 1e-12;
- the wind set-up slope, 1%;
- Merian's seiche, 1%;
- the inertial circle, 1e-9;
- a Kelvin wave, one cell and 8%;
- Proudman's forced wave, 3% at Fr 0.3, and the linear resonant growth, 1% at Fr 1 (Williams et al. 2020);
- the quarter-wave co-oscillating M2 tide, 3% with the ghost-cell offset stated;
- the 600-to-1 time-scale run, within the derived RK2 phase error.

None is checked against a measurement. The Lake Superior test bounds the tilt only to 0.6–1.4 of the flat-box closed form and checks the period against Merian's formula for a flat box, not the 1975 gauge record. The equilibrium-tide test checks the water against the surge's own potential (5%) and only that the tilt exceeds 5 mm; the tide's size is never checked against a published equilibrium amplitude.

**Fails points** 1, 2, 3, 4, 5, 6, 7.

**To do before it can be VERIFIED:**
1. **The cross-scale refusal misses the tide.** `CelestialSolver` takes a `timeScale` parameter (`space/solver.ts:83`, used at line 264) but does not declare `timeScale()` in its description, so the world cannot see its scale. A sped-up water reading the world's tide through the surge is not refused when the celestial solver runs at another scale. `tests/coupling/surge.test.js` builds that very world without an error: the celestial solver at 3600, the water and the surge at 1. Declare the celestial scale, refuse the mismatch with a test, and fix the coupling test's world. **Fixed** (KB-SURGE-SCALE1): the celestial solver declares its scale (a frozen or reversed sky counts as the world's), and a surge at another scale is refused its tide.
2. **The surge's pressure and wind run on two clocks.** The surge's `pressure` function gets the water's time, but the water's `wind` is read at the world's time. One storm's pressure and wind therefore drift apart by the time scale unless the caller converts the wind by hand, as `windOf` does in `surge.test.js`. A wind field with no `timeScale` property is accepted silently by a sped-up water. Put both on one clock, or refuse a scaled water given an undeclared wind or rain, with a test. **Fixed** (KB-SURGE-SCALE1): the water refuses a wind or rain whose `timeScale` (1 when it gives none) is not its own, so one storm's pressure and wind share a clock.
3. **Validation against measurements.** Test against published gauge records with a derived bound:
   - a measured surge, such as the Lake Superior levels of 10 November 1975, or the Hurricane Ike (2008) or Katrina (2005) gauges used by ADCIRC and SLOSH (Jelesnianski et al. 1992; Luettich et al. 1992);
   - a measured tide, such as M2 amplitude and phase at a published station;
   - the equilibrium M2 amplitude (0.2442 m times gamma_2) against the celestial potential.
4. **Model breadth against ADCIRC and Delft3D.** Missing:
   - wave set-up from radiation stress (SEA-02, Longuet-Higgins and Stewart 1964);
   - self-attraction and loading (Ray 1998);
   - nodal corrections f and u for `tidalLevel` (Pugh and Woodworth 2014);
   - wave-age-dependent wind drag;
   - spherical coordinates past the beta plane;
   - a high-fidelity tier, such as an unstructured or nested grid.
5. **Coupling.** Pressure and wind come from user functions, not from the ATMO-05 or ATMO-10 registry fields that the catalog coupling row names. Nothing couples the surge with SEA-02 waves in either direction.
6. **Coded errors.** Every `TypeError` and `RangeError` in `surge/index.ts`, and the new ones in `hydro/index.ts`, need a coded `MargoError`.
7. **Scale and film.** Missing:
   - Wasm and SIMD or threads for the grid loops;
   - no per-step allocation (`new Uint8Array(count)` in `SurgeSolver.step`);
   - no `water.sample` call per cell;
   - a directable target, for example a surge height at a place and time.

#### SEA-07 four-point pass

- Point 5 (7e2a01c13d). `packages/physics/tests/coupling/surge.test.js` checks coded pressure and celestial input errors that name a fix, byte preservation of the last accepted forcing and water after a late invalid value, and exact coupled replay after correcting it. `packages/physics/tests/coupling/surge-potential-workers.test.js` additionally checks rollback after a finite-input wet pressure sum overflows. The hydro error audit remains open.
- Point 6 and the grid-loop item 7 (7e2a01c13d). `packages/physics/tests/coupling/surge-potential-workers.test.js` compares scalar, 1-, 2- and 4-participant native results for pressure-only, dry and live celestial cases, with signed origins and exact restores. `packages/physics/tests/surge-potential-workers.browser.mjs` uses three live Chromium helpers. It records 153 cells in each native phase and 152 SIMD lanes per phase. The wet mask and staging arrays are reused. Directable surge targets remain open.
- Point 7 (7e2a01c13d). `packages/water/test/tide-film.browser.mjs` renders accepted astronomical forcing from the Earth-fixed Sun and Moon. The west sill wets at 7 h and the east sill at 14 h. Both remain dry in the tide-off control. The rendered level follows accepted water within 1 mm. Both renderers independently repeat full RGBA frames and accepted snapshots through hold, restore, re-advance and rewind.
- Point 8 and the first measurement comparison in item 3 (7e2a01c13d). `packages/physics/scripts/sea07-superior-measured.mjs` compares with 209 independent 1975 Lake Superior gauge readings. ERA5 supplies wind and pressure, and the datum is taken only from a pre-event record at a separate station. The fine-grid peak at Point Iroquois is 0.671 m against 0.971 m observed. It arrives one hour early and the 0.300 m miss exceeds the 0.047 m numerical spread. The historic instrument uncertainty is unavailable. [Evidence and limits](limits.md#native-tide-and-pressure-forcing-sea-07)

Measured accuracy, marine gauges and the independent equilibrium M2 amplitude, full model breadth and two-way sea coupling, direct atmospheric field wiring, the remaining HYDRO error audit, surge targeting and original production shots remain open. The row stays REOPENED at four points.

## Pass 3, 2026-11-26 (`main` from 71e757b1f)

Codex reported its solvers upgraded while the queue still showed them REOPENED or BUILDING, so this pass judges the code on `main`, not the status. Each film row's audit list (its film-table line, its detail row and its known-bugs bullets) was numbered and each item checked against the code and an opened test; the row's CPU tests were run under `scripts/run-with-timeout.mjs`. A row still marked BUILDING keeps that status, with its findings here.

### SEA-08 Ship seakeeping (`@margoengine/physics/seakeeping`, 22 commits since the audit, c002e262b to 7406d8ff5, on top of the earlier landed set), owner Codex: not VERIFIED, status left BUILDING

**Checked.** Read packages/physics/src/seakeeping (solver, course, excitation, bilge-keel, bilge-pressure, panel-surge, wave-reflection, memory, radiation, strips, viscous), the coupling tests and docs/limits.md line 1699. Ran under `scripts/run-with-timeout.mjs --max=15`: `node --test` on tests/seakeeping.test.js, tests/coupling/seakeeping.test.js, tests/coupling/kvlcc2-long-wave.test.js and tests/next-hull.test.js: 64 tests, 64 pass, 0 fail (235 s). No GPU or browser test exists for the hull solver (none in package.json, no hull browser fixture), so none run. The first attempt hit a dist chunk missing while another process rebuilt dist; the rerun was clean.

**Validation.**
- coupling/seakeeping.test.js "short-wave reflection agrees with held-out KVLCC2 short head-wave resistance": measured (Park, Lee and Kim 2014, Table 12, 16 tank runs, lambda/L 0.5), bound = the published expanded 95 percent uncertainty (2.932 ± 0.4643). Not fitted.
- kvlcc2-long-wave.test.js, both tests: measured tank runs (Park et al. 2014; lambda/L 2 and 1.1), resistance, heave, pitch each within the published expanded uncertainty (for example heave 0.73 ± 0.0371, got 0.7555; pitch 0.5521 ± 0.0416, got 0.5876). Measured, held out. Close to the edge of the bounds.
- "reproduces held-out Irkal BK10 roll damping at two step sizes": measured (Irkal et al. 2016 Table 6), damping 0.077 ± 0.00203 (one standard deviation over four runs). Measured. The period is about 6 percent short (1.124 s against 1.196 s) and is not asserted.
- Jung, Chang and Jo box roll decay: measured, decay within 12 percent; 7.7 percent low (documented).
- Heave, sway, roll and pitch against frequency-domain strip theory (1 to 4 percent): self-consistent, not independent measurement. Wigley waterline (Kajitani 1983) is recorded as a residual: the wake gives about 31 mm against 64 to 78 mm measured. It is not a passing test, so the bow wave is unvalidated.

**Fails points** 1, 3, 4, 5, 6, 7 (point 2 is partly met; 8 fails, see 14).

**Audit list.**
1. Forward-speed strip terms (Salvesen, Tuck and Faltinsen) — PARTIAL. Heave, pitch and roll-lift terms are built (test "forward speed follows both heave-pitch cross terms"); sway and yaw speed terms are absent.
2. Deck motion for loose props and cabins — PARTIAL. "forward-course deck contact agrees with a rotating-plane Coulomb calculation" proves the engine path. Production cabin binding is still open (demo-review EF-3).
3. Radiated waves to SEA-04 — DONE ("wake source" tests, "wake pressure returns its own wave-making resistance"). The bow-wave elevation is 2 to 3 times too small against Wigley.
4. Surge added mass — PARTIAL. `panel-surge.ts`; the test checks convergence on a hemisphere only.
5. Three-dimensional panel impulse responses (Newman; NEMOH) — NOT DONE. The radiation is still two-dimensional strips.
6. Validate against Journée Wigley experiments — NOT DONE as a passing test (residual only).
7. ITTC S175 benchmark — NOT DONE. KVLCC2 tank runs stand in; there is no S175 case.
8. Ikeda bilge-keel roll data — PARTIAL. Irkal BK10 passes; Ikeda 1978 is not used and the period is off.
9. Added resistance in head seas — DONE for short and long waves (KVLCC2 tests).
10. Finite depth — NOT DONE for radiation (deep-water strips, limits.md).
11. Feeds SEA-14 / ICE-04 / BREAK-03 — DONE (`effectsOnly` launch; pack-ice, crush and shell-flood coupling tests exist).
12. Roll axis clamp 0.95 d and Lewis-form clamp — NOT DONE (viscous.ts:22-27 and the Lewis border clamp remain).
13. Rival match (WAMIT) — NOT DONE.

**To do before it can be VERIFIED:**
1. Build 3-D panel radiation and diffraction (Newman 1985; Babarit and Delhommeau 2015) in place of 2-D strips, with finite depth, and add sway and yaw speed terms.
2. Add passing tests against the Journée Wigley and ITTC S175 measurements; bring the Wigley bow wave within its measured band (Kajitani 1983, Table I) and the bilge-keel period within Irkal's 1.196 s.
3. Remove the clamps (viscous.ts:22-27, the Lewis border) or replace them with a method valid across the range (Ikeda 1978 roll prediction).
4. Fix docs/limits.md line 1699: it still says bilge keels do not damp roll, surge added mass and forward-speed corrections are open, and the "Floating bodies..." column says "Bilge keels do not damp a hull's roll yet". These contradict the code.
5. Add the hull solver to a browser/GPU render fixture, and show a measured scaling record (no Wasm, threads or work counts exist for this solver, so point 6 is unmet).
6. Bind the production cabin shots (EF-3, EF-10) and re-render.

### SEA-09 Ships under way, manoeuvring (`@margoengine/physics/ship`, commits ebfc65dbb, 3c2f57931, 7fc896c99, 663671e17, f4c07368e; rebuilt 2026-11-27 by Claude), owner Claude: LANDED (KB-SHIP-HEEL1 and KB-SHIP-SHALLOW1 fixed 2026-11-27)

**Checked.** Read packages/physics/src/ship (solver, mmg, empirical, race, propeller, resistance, squat; 2,361 lines), packages/physics/tests/ship.test.js and packages/physics/tests/coupling/ship.test.js, the catalog row, the audit row and notes, and KB-SHIP-DAMP1. Ran `node --test packages/physics/tests/ship.test.js` under run-with-timeout: 18 tests, 18 pass, on packages built from current main (a first run during a rebuild failed the SEA-15 jet test; it passes on the fresh build). `tests/coupling/ship.test.js`: 2 pass. There is no browser or GPU test for this entry.

**Validation.**
- Holtrop and Mennen worked example (ship.test.js:42): published printed figures (1,793.26 kN, 0.1 percent); an exact reproduction of a published example. Valid check of the code.
- KVLCC2 turning and zig-zag (:129): Yasukawa and Yoshimura's simulation tables, not measurements. Bounds are 7 and 10 percent, set by hand rather than derived. The parameters are the paper's own, so this is self-consistent with the source.
- Squat (:209): published canal case, exact to ICORELS and Huuska formulas (formula against formula).
- Empirical hull (:582): Kijima's KVLCC2 terms to 1e-4 (hand-checked formulas). The turn is within 30 percent of MARIN free-running KVLCC2 (3.25 L, 3.34 L). This is the only independent measurement, and the bound is arbitrary and loose. No SIMMAN data beyond KVLCC2, no second hull.
- Race circulation (:485): Pennings propeller within 6 percent; cavitation (:555) Pennings wing 2.97 and Amini hysteresis. These are measurements, but they check the vortex model, not the ship.
- The squat-through-HullSolver check keeps an arbitrary 15 percent bound (:381). The quay pull (solver.ts:549) is uncalibrated.

**Fails points** 1, 2, 3, 4, 5, 6, 7 (point 8 is mostly honest in docs/limits.md).

**Audit list.**
1. Race and rudder jet as a velocity field with cavitation and aeration sources for SEA-13 and SEA-15 — DONE (race.ts; tests :485, :524, :555, :651). Hand-fit constants remain (Lamb-Oseen fade 0.8 to 1.5 D, 0.02 D core).
2. Empirical derivatives for other hulls, Kijima 1990 — DONE for the formulas (:582). The Great Lakes freighter is flagged as out of range and has no validation.
3. 4-DOF MMG with heel (Yasukawa 2019) — NOT DONE (3 DOF only).
4. Shallow-water derivatives, Kijima and Nakiri 2003 — NOT DONE.
5. Manoeuvring in waves, Skejic and Faltinsen — NOT DONE.
6. Savitsky 1964 planing — NOT DONE.
7. Sailing hull, heel, leeway, keel lift, VPP (Kerwin 1978), AERO-02 sail coupling — NOT DONE.
8. Oars (Caplan and Gardner) — NOT DONE.
9. Wageningen B-series (Bernitsas 1981) — NOT DONE (quadratic curves, constant-based four quadrants).
10. `holtropMennen` wired into the solver — NOT DONE (grep finds no use in solver.ts).
11. Autopilot and track targets — NOT DONE.
12. ICE-04 coupling — NOT DONE.
13. Validation against SIMMAN 2008 free-running data and Lataire bank-effect data — PARTIAL (one MARIN turn, 30 percent; no bank data).
14. Red flags: thruster merit 0.55 (solver.ts:54, calibration), squat speed cap 0.69 (:440, now documented as a cap), shaft depth d − 0.6D (:450), quay pull 0.98, 0.6 L (:549-552) — NOT DONE as validated (only documented as calibrations).
15. Sway and yaw damping counted twice with HullSolver — DONE (KB-SHIP-DAMP1, "a HullSolver on a ship leaves the surge, sway and yaw the ship claims", :415).
16. Rust/Wasm kernel — NOT DONE.
17. Coded errors (MargoError) — NOT DONE: the solver throws plain TypeError and RangeError (solver.ts:198-209).

**To do before it can be VERIFIED:**
1. Build the 4-DOF MMG with heel, the sailing hull (VPP, leeway, keel lift, AERO-02 sail), oars and planing named in the catalog row.
2. Add shallow-water derivatives (Kijima and Nakiri 2003) and bank effect validated against Lataire's data.
3. Validate against SIMMAN 2008 free-running KVLCC2, KCS and a second hull, with bounds derived from the data's spread, not 30 percent or 15 percent.
4. Replace the quadratic open-water curves with Wageningen B-series and real four-quadrant data.
5. Wire `holtropMennen` into the solver, and add autopilot and track targets.
6. Throw MargoError with a help link and fix instead of TypeError and RangeError.
7. Add a Rust/Wasm path or recorded work counts, and ICE-04 and AERO-02 coupling tests.
8. Replace the thruster, shaft depth and quay constants with cited values.

**Rebuilt 2026-11-27 (Claude), each audit item with its commit on `main` and its test** (tests in `packages/physics/tests/ship.test.js` unless named):
1. Race and rudder jet — done before (3c2f57931).
2. Empirical derivatives — done before (3c2f57931); the KCS model now adds a second measured hull.
3. 4-DOF MMG with heel — 3b2e7f40d (Fukui et al. 2016, KCS): "KCS heels outward in its turn", "a rigid body held by the ship solver heels in its turn"; its heel angles fixed in b9558cee3 (KB-SHIP-HEEL1: the rudder's roll lever and the roll decay fitted to MARIN's final and largest roll, checked on KRISO's three model scales, the port turn and the zigzags).
4. Shallow-water derivatives — 9bc70c24f (Ankudinov et al. 1990; Kijima's factors tried and refused, they turn KVLCC2 tighter), then KVLCC2's measured table, `KVLCC2_SHALLOW` (KB-SHIP-SHALLOW1 fixed, 2026-11-27: captive tests on KVLCC2 and Esso Osaka and Furukawa et al.'s hull of KVLCC2's form, N'r at h/T 1.2 fitted to KRISO's 20/5): "in shallow water a hull's derivatives and added masses are Ankudinov's or its own table's"; "banks and shallows against measurement" (KRISO's and FHR's free-running KVLCC2 at h/T 1.2, 1.5 and 2.0, data not fitted within 20 percent at h/T 1.2; the 20/5 at h/T 1.5 45 percent under, an accepted difference in docs/limits.md).
5. Manoeuvring in waves — 2cb031463 (SNNM added resistance, short-wave drift, Yasukawa 2006): "waves' mean drift", "KVLCC2 turns in an irregular head sea" (Hasnan et al. 2019), coupling "ShipSolver in waves".
6. Savitsky planing — 0a8cb3001 (Savitsky steady; Zarnick strips with Garme's transom dynamic): "a planing hull's steady run" (Shoemaker), "a planing boat on a rigid body" (Fridsma 1969), `coupling/planing.test.js`.
7. Sailing hull, heel, leeway, keel lift, VPP, AERO-02 — 3757ece30 (DSYHS, ORC 2023): "a sailing yacht", `coupling/sailing.test.js` (with AERO-02's `SailForce` cloth); measured: d4fda7e34, "measured checks" (Sysser 1 in the tank, FAIR V at sea).
8. Oars — 1e1f51c75 (Caplan and Gardner's Macon blade): "oars" (Holt et al. single scull, Coppel et al. eight), `coupling/rowing.test.js`.
9. Wageningen B-series — 19c4a1968 and c80430a84 (Oosterveld and van Oossanen 1975): "a Wageningen B-series propeller's open water"; four quadrants from measurement d4fda7e34 (B4-70, Roddy et al.): "measured checks".
10. `holtropMennen` wired — c6f276858: "a hull given to the ship runs on Holtrop and Mennen's resistance".
11. Autopilot and track targets — c6f276858: "the autopilot places the closed loop's poles", "the autopilot follows a track of waypoints"; the speed order a7a422029: "the ships' work counts ... and the telegraph holds a speed order through ice".
12. ICE-04 coupling — d44a80c70 (Riska et al. 1997 level ice; ICE-04 floes): "level ice resists a ship", `coupling/ship.test.js` "ShipSolver with PackIceSolver".
13. SIMMAN validation — 3b2e7f40d: KCS against MARIN and KRISO, KVLCC2 against SIMMAN 2008 and 2014, bounds from the data's spread; bank effect by Lataire's model fitted to Vantorre et al.'s two hulls (2026-11-27, replacing the regression's hull part, which turned to repulsion at h/T 1.2 where the force measured near nothing): "a bank alongside draws a ship in ... Lataire's model" and "banks and shallows against measurement", R^2 0.78 to 0.97 on the fitted points against the regression's 0.55 to 0.87, each depth held out, and two hulls not fitted (A01, Delefortrie et al. 2024; KVLCC2, Van Hoydonck et al. 2019), with what it still misses in docs/limits.md.
14. Red flags — the thruster's merit from Beveridge's measurements (7b1f858e9, "a tunnel thruster keeps its momentum bound"); the quay pull replaced by Vantorre's regression (bb82cd307); the squat cap now Huuska's cited limit (Fn_h 0.7) and the shaft depth KCS's published propeller centre (1e0083389).
15. Damping counted twice with HullSolver — done before (KB-SHIP-DAMP1).
16. Rust/Wasm — recorded work counts instead, a7a422029: "the ships' work counts are deterministic and grow with the fleet", and each coupling test's count check.
17. Coded errors — 7b1f858e9: "the ship solver refuses what it cannot be made from", and a coded refusal test in each new test above.
Film controls: heading, track and speed orders (c6f276858, a7a422029), thrust (planing), stroke rate and turn (rowing), heading, FLAT and reef (sailing).

### SEA-10 Damage, flooding, capsize, sinking (`@margoengine/physics/seakeeping`, `Flooding` in `packages/physics/src/seakeeping/flooding.ts`, commits 533cc7249, 785aea704, 8fb5ed774, a0325f916, 24e67d6ff, f82be85af), owner Codex: REOPENED

**Checked.** Read flooding.ts (946 lines), flooding.test.js, coupling/breaches.test.js, coupling/crush-shell-flood.test.js and the flooding tests in coupling/seakeeping.test.js. Ran everything under run-with-timeout. flooding.test.js passed 9 of 9. breaches.test.js passed 5 of 5. crush-shell-flood.test.js passed 3 of 3. The three files together passed 17 of 17 on a second run. The first combined run failed once, with a `code: 'state'` error at breaches.test.js:190 and a failed crush-shell-flood.test.js. I did not find the cause, so treat it as an intermittent failure to chase. In seakeeping.test.js the 7 flood, hole, sink and heel tests passed 7 of 7. No GPU or browser test exists for this row.

**Validation.**
- Torricelli filling: exact solution, with a derived first-order step bound (under 1e-3 m).
- 2/3 weir law: exact, to 1e-12.
- Boyle air pocket: exact, to 1e-9.
- Two-compartment water conservation: exact, to 1e-6.
- `volumeBelow` cube cut: exact, to 1e-14.
- "Barge holed in a wing tank" (seakeeping.test.js:2407): equals the lost-buoyancy statics (Biran) within 1e-3 degrees. It is a good independent check, but it is a hydrostatic identity and not a measurement.
- "A box going down" (seakeeping.test.js:2485): checks terminal speed against the code's own formula, v = sqrt(2(m - rho V)g/(rho C A)) with C = 1.05, to 0.1 percent. The reference comes from the same formula the code uses.
- Beverloo and Wilson outflow: re-checks the code's own formula.
- Still missing: a published measured flooding or capsize test. No test mentions Ruponen 2007 or the ITTC damaged-ship benchmark (Papanikolaou 2000). The only measured reference near this row is Jung, Chang and Jo's box roll (a SEA-08 test).

**Fails points** 2, 3, 6, 7 (and 5, because errors are not coded).

**Audit list.**
1. Drag on a sinking hull (KB-SEA-SINKDRAG1, Hoerner 1965) — PARTIAL. Built in the hull solver, and the test above passes. Its reference is self-consistent. The drag coefficient is fixed at 1.05, and there is no measured sinking-speed comparison.
2. Wire `hullBreaches` to SEA-13 bubbles and SEA-15 tracers — DONE. breaches.test.js "a holed hull lets its air bubble up…" passes, with losses accounted.
3. Silent unconverged 200-sweep loop — DONE. `FloodResult.sweeps` is reported (flooding.ts:137,749,806), and the test "a vented box filling through a hole" covers it. The result is reported but not raised as an error.
4. Iron-ore grain default versus taconite 0.012 m — PARTIAL. Only the comment changed. The default stays 1e-4 m.
5. 48-level volume table rebuilt at every pose — NOT DONE as far as I can see. Nothing in the code or the queue changes it.
6. Shallow-water flow inside each compartment (Santos and Guedes Soares 2008; Ruponen 2013) — NOT DONE. Water is still a point mass with a level, so there is no sloshing.
7. Validate against Ruponen 2007 and the ITTC damaged-ship benchmark — NOT DONE.
8. Righting-arm (GZ) curves and IMO/SOLAS criteria — NOT DONE. No GZ code exists. Only the SOLAS permeability constants appear.
9. Wave pressure and green water at openings — NOT DONE for openings.
10. Settling on the bed — NOT DONE.
11. Free-surface effect — DONE at the level of heel-following water, shown by the heeling-barge test.
12. Rust/Wasm for the hot loop and floating-origin cells — NOT DONE.
13. Coded `MargoError` — NOT DONE. flooding.ts throws bare `RangeError` and `TypeError` (about 20 sites, lines 372-458). There are zero `MargoError` uses in the file.
14. Hull breakup and crush linkage — DONE. The crush-shell-flood tests pass.

Totals: 4 DONE, 3 PARTIAL, 7 NOT DONE.

**To do before it can be VERIFIED:**
1. Add a validation test against a published measured flooding or capsize result: Ruponen 2007 box-barge progressive flooding, or the ITTC damaged-ship benchmark (Papanikolaou et al. 2000). Use a bound derived from the reported uncertainty.
2. Add compartment shallow-water flow, or at least an inertial sloshing model (Santos and Guedes Soares 2008; Ruponen et al. 2013), with a transient flooding validation.
3. Add GZ curves and the IMO/SOLAS stability criteria, checked against a worked textbook case (Biran and Lopez Pulido, 2014).
4. Replace every bare `RangeError` and `TypeError` in flooding.ts:372-458 with a `MargoError` that names the fix. Raise a coded warning when the sweeps hit 200.
5. Compare the sinking speed with a measured sinking or drop-test dataset. Take the coefficient C from the data, not a fixed 1.05.
6. Cache the 48-level volume table, add a work count, and decide on a Rust/Wasm hot loop and floating-origin cells.
7. Add the missing capsize and sinking cases: cargo shift, bed settling, and hatch or opening wave loading (green water).
8. Find the cause of the intermittent first-run failure in breaches.test.js:190 and crush-shell-flood.test.js.

#### SEA-10 four-point pass

- Point 5 and audit item 4 (42ea5bda33). `packages/physics/tests/flooding.test.js` rejects a bad second sea query without changing inventories, outputs or the level table. The dry stair test proves zero liquid flow from an empty room beneath its geometric floor. `packages/physics/scripts/sea10-ruponen-measured.mjs --check-warnings` asserts repeatable coded warnings on the stiff air graph and the signed water ledger. The pressure cap is visible and remains an accuracy gap.
- Point 6 and audit item 6 (42ea5bda33). `packages/physics/tests/coupling/flood-volume-workers.test.js` compares scalar and native level data through 1, 2 and 4 participants, rejects bad work atomically, and verifies world, accepted inventory and signed-origin port replay. `packages/physics/tests/flood-volume-workers.browser.mjs` verifies three packaged helpers. The two-room run evaluates 1,128 planes, visits 13,536 triangles and executes 6,624 f64x2 triangle pairs. Same attitude reuses its table.
- Point 7 (42ea5bda33). `packages/water/test/flooding-film.browser.mjs` verifies early versus late isolation on a code-built 9 m barge on both renderers with exact snapshot/RGBA replay. Late isolation admitted 2.695 m³ versus 0.247 m³, with 6.34° list, 1.61° trim and 7.79 cm additional sinkage. Shell closure conserves the inventory while 0.274 m³ transfers internally. The vent drives accepted foam field state. The original EF-11 shot is open.
- Point 8 and audit item 1 measurement diagnostic (42ea5bda33). `packages/physics/scripts/sea10-ruponen-measured.mjs --through=20` compares eight independent early Case A Test 06 measurements. None both agrees and resolves at the observed scale. The 120 s single-rate diagnostic also shows the upper room R22 dry against 81.3 mm measured. Neither physical measurement is credited as a pass. [Evidence and limits](limits.md#progressive-flooding-evidence-and-limits-sea-10)
- Existing reciprocal shell coupling regression (42ea5bda33). `packages/physics/tests/coupling/crush-shell-flood.test.js` and `packages/physics/tests/coupling/breaches.test.js` passed together with the focused solver tests. The intermittent first audit failure did not recur. Its original cause is unresolved.

Full measured validation, slosh, righting curves, measured sinking drag, cargo shift, bed settling, wave loading at openings and the production cut remain open. The row remains REOPENED at four points.

### SEA-11 Wave impact: slamming, green water (`seakeeping` slamming, with green water in `seakeeping/deck.ts` and `flip/deck-water.ts`, commits d90933a42, 16a69851a; green water from d865c4c8f, fd2db65d5, 01f11c4d7), owner Codex: REOPENED

**Checked.** Read `seakeeping/slamming.ts`, `slamLoad` in `seakeeping/solver.ts:1493-1540`, the commit's two tests, the clean-room entry and the limits row. No commit touches slamming after d90933a42. Ran `node --test packages/physics/tests/seakeeping.test.js packages/physics/tests/coupling/seakeeping.test.js` under run-with-timeout: 52 tests, 52 pass, 0 fail (a first run failed only because the built output was being rebuilt by someone else and a chunk was missing; the rerun was clean). No browser or GPU test exists for this row.

**Validation.** (a) "a section's slamming table: Wagner's wetted width..." (`tests/seakeeping.test.js:419`): the table is checked against Wagner's closed-form wedge width and slope, within 0.1 and 0.2 percent. This is an exact solution of the theory the code implements, not a measurement. (b) "a wedge coming down into still water ... slams as Wagner says" (`tests/coupling/seakeeping.test.js`, end of file): the force equals rho pi^3 V^2 h L / (4 tan^2 beta) within 0.1 percent, and none past the chine. Again a self-consistency check against the same formula. The bound is a measured agreement (0.02 percent) rounded up, not a derived error bound. Green water: Ritter's dam break within 1.1 percent at 400 cells (exact solution, from the earlier work). Missing: any measured drop-test force or pressure (Zhao et al. 1996 wedge drops, Tveitnes et al. 2008, Zhou, De Kat and Buchner 1999 deck loads), any case not used to build the model, any regime check. The docs themselves admit Wagner is high at larger deadrise and that measured forces were not read.

**Fails points** 1, 2, 3, 4, 5, 6, 7 (8 partly met: limits are honest about vertical sections only).

**Audit list.**
1. Pressure distribution on the hull (plating peaks) — NOT DONE (the limits row says "no water-pressure peaks").
2. Von Karman and Wagner as two models, and Korobkin's generalised Wagner — NOT DONE in seakeeping (only Wagner's momentum form; a modified Logvinovich model exists only in `entry/slam.ts`, not wired into hulls).
3. Flare and lateral slams — NOT DONE (force along body y only, `solver.ts:1529-1531`).
4. Green-water impact on deck structures and hatch covers (Zhou, De Kat and Buchner 1999) — NOT DONE (no hatch or deck-structure load in `deck.ts` or `deck-water.ts`; green water loads only the deck by weight rho g h).
5. Bulwarks — PARTIAL (a bulwark wall and overtopping inflow exist, `deck.ts:15`, `deck-water.ts:51`; no impact load on a bulwark).
6. Whipping (hull girder response to slams) — NOT DONE.
7. Slam spray output to SEA-13 — NOT DONE (no spray output in `slamLoad`).
8. Quadratic damping applied to every section moving down, not only at impact; untested on a V-hull motion response — PARTIAL (the damping term is applied only while a section enters; no V-hull motion test).
9. Validation against Zhao et al. 1996, Tveitnes et al. 2008, Zhou et al. 1999 — NOT DONE.
10. Catalog row still names `ShipSplash` stand-in — NOT DONE (`docs/physics-solvers.md:112`).

**To do before it can be VERIFIED:**
1. Add generalised Wagner (Zhao, Faltinsen and Aarsnes 1996) or Korobkin's modified Logvinovich model to hulls, with a fast and a high-fidelity tier behind one option, and the pressure distribution.
2. Validate on measured wedge drop forces (Zhao et al. 1996, Tveitnes et al. 2008) at several deadrise angles, including angles not used to set any value, with a bound derived from the measurement scatter.
3. Add flare and lateral slams (force direction from the section's normal, not body y only), 3-D end effects (Scolan and Korobkin 2001).
4. Build green-water loads on hatch covers and deck structures, validated on Zhou, De Kat and Buchner 1999; bulwark impact loads.
5. Send slam spray to SEA-13 and add a coupling test; couple the slam to the hull's motion with a V-hull response test.
6. Refuse bad inputs (non-closed mesh, bad density) with a coded error naming the fix; add scaling counts, film controls and the whipping response; fix the catalog row.

### SEA-13 Whitewater, foam, bubbles, spray (`@margoengine/physics/foam`, commits e9007d3bb, 8fb5ed774, 0dddec890), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/foam/{index,breaking,spray,plume}.ts`, the foam, plume, breaches and FLIP tests, the catalog row, the audit rows and `docs/limits.md`. Commits since the audit: 8fb5ed774 (hull venting), 0dddec890 (FLIP air, foam and spray). Nothing else touched the foam source since e9007d3bb. Tests run under run-with-timeout, all green: `foam.test.js` 12/12, `coupling/foam.test.js` 2/2, `bubble-plume.test.js` 3/3, `coupling/breaches.test.js` 5/5, `flip.test.js` 12/12, `coupling/flip.test.js` 7/7. No GPU or browser test exists for this entry. I did not run `bubbles.test.js` or `coupling/airborne.test.js`; I only read the airborne test names.

**Validation.**
- "whitecap coverage ... within a factor of 1.5" (`foam.test.js:68`): the reference is Monahan and Woolf's measured law, W = 1.95e-5 U10^2.55, at 7, 10 and 13 m/s. The bound is an arbitrary 1.5. The model's kappa (Leckler 2013) was tuned on that same law, so the test is not independent. The 16 m/s point is left out; limits records 0.56 of the law there.
- Stokes drift sigma k a^2 (`:85`): an exact solution, 1e-9.
- Events against Leckler's law (`:103`) and the 0.16 active share: self-consistent, because the constants were set to give exactly this. The 10 percent bound is arbitrary.
- Decay of 3.8 s and 2.5 s (`:128`) and Gong spray (`:311`): both re-derive the code's own constants and formulas. No measurement is used.
- Plume tests: Morton, Taylor and Turner's pure plume far field is an exact solution at 1e-10. The surface current is checked only against its own conservation laws. Limits says Milgram and Burgess's measured speeds were not compared.
- Missing: any measured foam or bubble data held out from calibration (Callaghan et al. 2008 whitecap coverage; Anguelova and Huq 2017 persistence; Trevorrow et al. 1994 wake data).

**Fails points** 2, 3, 5, 6, 7 (7 partly), 8 partly.

**Audit list.**
1. Deane and Stokes 2002 bubble entrainment and plumes: PARTIAL. `bubbles/solver.ts:13,139` has their spectrum, but its sources are a ship's race, hull breaches and FLIP air. No breaking-wave source feeds bubbles. `foam/plume.ts` and the `bubble-plume.test.js` "pure plume" test cover hull venting only.
2. Bubbles that rise, wobble, grow and drift in orbital flow: PARTIAL. This lives in `BubbleSolver`, which I did not run. Foam does not call it for sea breakers.
3. Streaked foam and spray read from the live sea's breakers: DONE. `breaking.ts` reads the ST4 spectrum, and `foam.test.js:181` (shear stretches a patch into a streak, foam conserved) and `:311` (spray) pass.
4. Andreas 1998 and spume: NOT DONE. Limits says the spume source waits for a source that settles it. Only film drops and bag breakup exist.
5. Hull venting: DONE. `coupling/breaches.test.js` "a holed hull lets its air bubble up into a boil".
6. Diffuse particles (Ihmsen 2012): PARTIAL. FLIP gives `aeration`, `foam` and `spray` (`flip.test.js:397`), but there are no whitewater particles with their own advection.
7. Langmuir windrows imposed as a sinusoid: NOT DONE (`foam/index.ts:724`, still a sinusoid on the grid-centre wind).
8. Ship wakes painted: NOT DONE. They are painted from length and beam only (limits: no hull shape or prop wash).
9. A SEA-04 breaking read: NOT DONE. Wake breaking does not feed foam.
10. Spray passed to ATMO-06: DONE. `coupling/airborne.test.js:74` "PA-21 and RITS-4".
11. Uncited constants (`index.ts:608,633-650`): PARTIAL. Reed and Milgram and jet theory are now cited; the bow ramp 0.15 to 0.4 is not.
12. `wakePersistence` of 150 s fitted from an acoustic measure: NOT DONE.
13. Callaghan 2008 held-out validation: NOT DONE. The only measured comparison is the one the model was tuned on.
14. Houdini-class whitewater rival: PARTIAL.

Count: 3 DONE, 4 PARTIAL, 7 NOT DONE.

**To do before it can be VERIFIED:**
1. Add a breaking-wave bubble source (Deane and Stokes 2002; Ma, Shi and Kirby 2011) feeding `BubbleSolver`, with a coupling test.
2. Validate coverage against held-out measurements (Callaghan et al. 2008; Anguelova and Huq 2017) with bounds derived from their scatter. Fix the 16 m/s shortfall.
3. Add the spume source (Andreas 1998; Fairall, Kepert and Holland 1994 from the original). Add a test against a measured spray flux, not the code's own formula.
4. Replace the sinusoidal windrows with a Langmuir-cell model (Craik and Leibovich 1976), or document the sinusoid as an accepted difference.
5. Read SEA-04 wake breaking and hull shape for ship foam. Cite or calibrate the remaining constants.
6. Add whitewater particles for the FLIP tier (Ihmsen et al. 2012) and a Rust or Wasm kernel for large grids (about 5 ms a step for a 128 by 128 grid, in TypeScript).
7. Replace the arbitrary 1.5 and 10 percent bounds with derived ones.

### SEA-04 Local dispersive free surface (`physics/sea`, commits 33ab69766, 10d649b5c, 4ec0717e8), owner Codex: REOPENED

**Checked.** Commits for the row: 33ab69766 (WakeSolver), 10d649b5c (Water draws the wake), 4ec0717e8 (liquid box takes the wake's waves). No SEA-04 commit since the audit touches `packages/physics/src/sea/wake.ts` or `tests/sea-wake.test.js` (the last change to either is 4ec0717e8, before the audit). Read `src/sea/wake.ts` (563 lines) and `tests/sea-wake.test.js` (277 lines). Ran under run-with-timeout: `node --test packages/physics/tests/sea-wake.test.js packages/physics/tests/coupling/wake.test.js`, 14 tests, 14 pass, 0 fail. Ran `packages/water/test/wake-agreement.browser.mjs` (WebGPU on Metal): passed, drawn wake within 0.042% of the solver; the `--compat` run was not done. `wake.ts` contains no wall, quay, obstacle, reflection, current or capillary code.

**Validation.**
- "a plane wave ... moves at sqrt(g k tanh(k D)) / k, exactly" (deep and 3 m): exact solution, the linear dispersion relation, bound 1e-9 of height. Sound.
- "with no source and no sponge, the wave energy stays to round-off": conservation identity, 1e-10. Sound.
- "a pressure patch moving at 4 m/s ... transverse waves 2 pi U^2 / g": exact Kelvin analytic wavelength, 5% bound (arbitrary, not derived from the grid). The 12 to 22 degree crest-angle band around 19.47 degrees is loose and arbitrary.
- The `wake.test.js` coupling test and the water browser test are self-consistent (solver against its own drawing), not measurements.
- Missing: no published measurement anywhere (Havelock 1908 wake amplitude, Cauchy-Poisson ring waves, Rabaud and Moisy 2013 angle against Froude number), and no test of a reflected wave or a standing wave at a wall. The limits.md Rabaud and Moisy claim still has no test.

**Fails points** 1, 2, 3, 4, 5, 6, 7 (8 only partly met).

**Audit list.**
1. Reflection and clapotis off quays, hulls, breakwaters; wavelets with obstacles (Jeschke et al. 2018) — NOT DONE. No code in `wake.ts`; the grid is periodic with a sponge only (`limits.md:1720`).
2. Hull displaced volume as a source — PARTIAL. `volume` is a source field in `wake.ts` (about line 387) and `HullSolver` publishes waterplane volume (`seakeeping/solver.ts:114`), but there is no test that the bow wave climbs the stem or the waterline moves.
3. Wave-making resistance back to the hull — DONE in the seakeeping tests (`coupling/seakeeping.test.js:1424`, title read, not run by me).
4. Capillary waves, viscous decay — NOT DONE (limits.md names none).
5. Varying depth — NOT DONE (one flat-bottom depth).
6. Currents — NOT DONE (limits.md: "no current").
7. Rabaud and Moisy claim in limits.md has no test — NOT DONE.
8. Havelock 1908 amplitude, Cauchy-Poisson ring waves — NOT DONE.
9. `wakeHeight` README gap — PARTIAL. Documented in the water README (line 1475), still missing from the physics README.
10. Breaking read for SEA-13 and spray, sources for rain rings — NOT DONE (no breaking output).
11. Scale: Rust/Wasm SIMD, work counts — NOT DONE. About 20 ms a step on the CPU, "not timed in a gate".

**To do before it can be VERIFIED:**
1. Add true wall boundaries (Neumann, per Schreck, Hafner and Wojtan 2019, or Neumann penalisation per Kolomenskiy and Schneider 2009) with a standing-wave test (eta = 2A cos kx cos wt, doubled at the wall), the Penney and Price 1952 semi-infinite breakwater diffraction values, and MacCamy and Fuchs cylinder run-up.
2. Make hulls obstacles that reflect and diffract; test the Kelvin wake reflecting off a quay.
3. Test the displaced-volume source: bow wave height at the stem against Wigley or KVLCC2 data.
4. Add a measured test with a derived bound: Havelock 1908, Cauchy-Poisson, Rabaud and Moisy 2013 against Froude number; test or remove the limits.md claim.
5. Add currents, varying depth, capillary and viscous decay with a coded MargoError for out-of-range input (the wake throws plain RangeError and TypeError).
6. Output a breaking read for SEA-13 and a rain-ring source; document `wakeHeight` in the physics README.
7. Move FFTs to Wasm SIMD and record work counts.

**Upgrade in progress.**
- Item 2 in part. `6a73b7c01e` and `coupling/sea04-hull-boundary.test.js` check impermeable mean hull faces,
  a prescribed oscillating hull with reciprocal pressure and signed work, heave, late registration and exact
  replay. The work residual is 1.44e−13 J. Large advancing geometry and its Kelvin reflection remain open.
- Item 2 in part. `03657797a3` and `coupling/sea04-hull-mask.test.js` check the same indexed-mesh bake for
  imported and procedural hulls. The mask survives reindexing and exact seam copies, bounds box and cylinder
  volume at three resolutions, and reproduces live pressure exchange after restore. A fixed mesh still uses
  its mean wetted geometry.
- Item 3 measured comparison. `6a73b7c01e` and [sea04-stem](../packages/physics/scripts/sea04-stem.md) record
  two published Wigley conditions. Fine surface sources give 16.42 and 14.53 mm at the stem against
  43.84 and 39.94 mm measured. Depth bands give 9.52 and 9.28 mm. Wetted-side through-flow remains open.
- Item 3 rejected follow-up. The [steady tow reproduction](../packages/physics/scripts/sea04-stem-tow.md)
  verifies the signed wall flux and outgoing modes. Using the identical signed hull source in an uncut
  tank gives bounded waves at both speeds. The cut wetted surface produces unphysical waterline peaks
  even with conservative face flux and affine trace restriction. The diagnostic remains outside the runtime.
- Item 4 in part. `9d36eb9d75` and `sea04-cauchy-poisson.test.js` verify the finite-depth release ring against
  a Hankel integral, with 1.20e−8 maximum normalized error and exact replay.
  `3cf936a831` and `sea04-havelock.test.js` check moving pressure amplitude at five
  absolute gauges. Worst open-water error is 98.44 µm within a 149.40 µm spatial and
  integration bound. The direct periodic reference and replay also pass.
- Item 6. `9d36eb9d75` and `sea-wake-breaking.test.js` check the fixed onset ratio against independently
  observed crest cases. `coupling/sea04-foam.test.js` checks the live wake-to-foam and spray read, held
  multi-rate deposition and exact replay. The read is diagnostic and does not simulate overturning.
- Item 6 measured rain check. The model’s crests are 32–56 mm farther out after 0.8 s. Refining from
  1.6 to 1 mm changes the crest positions by at most 0.25 mm. The ±40 ms observation window does not close
  the gap. The single pressure pulse does not capture delayed drop coalescence, crown and stalk collapse.
  [Craeye et al., 1999](https://pure.tue.nl/ws/files/1414355/Metis133016.pdf)
  [Reproduction](../packages/physics/scripts/sea04-rain-measured.mjs)
- Item 5. `38b0cfd3eb` and `coupling/sea04-bathymetry.test.js` check local bed depth and the live
  4:1 depth step. The reflection and transmission magnitudes are 0.33357 and 1.32693 against
  the long-wave limits 1/3 and 4/3, with 2.29e−12 J energy closure.
- Item 6 in part. `38b0cfd3eb` and `sea-wake-rain.test.js` check ATMO-04 contact forcing,
  integrated pressure impulse, retained volume, ring propagation and exact replay.
- Item 7. `38b0cfd3eb` and `sea-wake-fft-native.test.js` check exact scalar/SIMD spectra and
  live state, depth queries, replay and transform work. Water’s `wake-agreement.browser.mjs`
  exercises the lazy physical asset and its rendered surface on WebGPU and WebGL2.
- Items 1 and 4 measured comparisons. `b5ce59d479` preserves the DHI and Rabaud–Moisy
  protocols and raw hashes in [the measurement record](../packages/physics/scripts/sea04-measured.md).
  The refined DHI case gives 63.95 mm RMS on the nominal archive clock. The circular analytic
  comparison also misses by 61.18 mm. The two photographed wake angles miss by −7.35° and +2.75°.
  These comparisons remain open.
- Items 1 and 4 follow-up. The [measurement record](../packages/physics/scripts/sea04-measured.md)
  adds a refined Briggs M4 breakwater comparison and `sea04-rabaud-gaussian.mjs`. Briggs gives
  0.03792 and 0.04465 RMS on successive grids, so the measured error does not converge at all transects.
  The convolved Gaussian gives 18.99° and 11.58° against 19.85° and 9.00° in the photographs.
  The slower case moves outside ±1° after refinement. The faster case already misses on the coarse grid.
- Item 1 measured cylinder follow-up. DHI same-run WG1 fixes the input while WG9 stays held out.
  Fine RMS falls to 17.98 mm with no timing or gain fit. The exact linear solution gives 18.33 mm RMS.
  [Reproduction](../packages/physics/scripts/sea04-measured.md#dhi-f1-cylinder)
- Item 1. `75ee9d9129` and `coupling/sea04-diffraction.test.js` check the Penney–Price tip and
  MacCamy–Fuchs cylinder with the production finite wake. Refined normalized complex RMS is 0.05144
  and 0.08465, respectively. An incident-only packet forms its own diffracted wave, and restore replays
  the screen exactly. These are analytic comparisons. The independent tank acceptance is separate.
- Item 5 in part. `75ee9d9129` and `sea-wake-modes.test.js` check uniform Doppler propagation, exact held
  pressure, capillary dispersion and weak viscous decay. Seven independent tank wavelengths give
  1.30% RMS against 22.36% for gravity alone. Their published wavelength precision is 0.4%.
- Items 5 and 6 in part. `96f97c0344` converts WakeSolver input and port errors to coded errors
  with a fix and documents `wakeHeight`. `sea-wake.test.js` checks grid, initial state and source errors.
- The existing `coupling/loads-quay-wake.test.js` checks the straight-wall standing mode and the hull-driven
  reflected wake. Finite diffraction acceptance will use the measured Briggs M4 gauges and the independent
  with-cylinder WG9 series from DHI Test 008, with the separate no-cylinder record for the incident input.
  [Briggs, Thompson and Vincent, 1995](https://doi.org/10.1061/%28ASCE%290733-950X%281995%29121%3A1%2823%29)
  [DHI Test 008](https://www.ccp-wsi.ac.uk/catalogue/test_cases/test_case_008/)

#### SEA-04 four-point pass

- Point 5 (166bf67f94). `packages/physics/tests/coupling/sea04-accepted.test.js` checks signed surface and submerged ports, borrowed memories, arena growth and late malformed source and mode trials. Rejection preserves the complete wake snapshot, depth velocities, breaking data and accepted receipt. A control arena and the recovered retry produce identical bytes.
- Point 6 (166bf67f94). `packages/physics/tests/coupling/sea04-workers.test.js` and `packages/physics/tests/sea04-workers.browser.mjs` compare TypeScript and native wakes, exact complete state, and 1, 2 and 4 joined participants. Gravity advances 149 and the current/capillary case 399 real complex pairs. The four-way case dispatches 99, 100, 100 and 100 modes. The existing FFT has the same order and transform receipts.
- Point 7 (166bf67f94). `packages/water/test/quay-diffraction-film.browser.mjs` renders the same wave packet with the live finite quay and open take. It measures 4.38 cm reflection and +0.92 cm in the lee versus a −3.25 cm open trough. The two takes close the wave and absorber ledger within 5.12e−13 relative. Both renderers match accepted query heights within 4.54e−8 m and replay every state and RGBA byte.
- Point 8 (166bf67f94). `packages/physics/scripts/sea04-measured-source.py` and [the measured reproduction](../packages/physics/scripts/sea04-measured.md) score DHI WG9 with the independent WG1 input, giving coarse and fine RMS 18.220 and 17.975 mm on the original clock. `sea-wake-modes.test.js` gives 1.30% RMS for Scott’s seven capillary wavelengths against 22.36% for gravity alone. The Craeye ring crests stay 32–56 mm too far out. No measured target fits a model parameter.

The observed wave amplitudes and wake angles, free advancing hull, current gradients, delayed drop collapse and original film bindings remain open. The row stays REOPENED at four points.

### SEA-02 Ocean surface synthesis and query (`@margoengine/physics/sea`, commits 52b68ca65, 4514375c8, 713c344ef, 3dbda315d; patches added by 33ab69766 and 4ec0717e8), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/sea/surface.ts` (415 lines), `tests/sea-surface.test.js`, the `sea-wake.test.js` patch tests, the audit row, the catalog row, `docs/limits.md` row "Sea surface" and the demo-review rows. `git log --since=2026-11-25` on the sea source shows no change to the wave synthesis since the audit: only error wording (713c344ef) and the wake `patches` and `waterBelow` hooks. Ran under run-with-timeout: `sea-surface.test.js` + `sea-wake.test.js`: 20 tests, 20 pass, 0 fail. `packages/water/test/sea-agreement.browser.mjs` (WebGPU, Apple Metal): passed (2043 vertices, 408 waves, worst 0.0% of its bound, largest difference 0.0020 mm). Not run: the WebGL2 `--compat` variant, and `coupling/seakeeping.test.js` (it tests the hull, not this surface).

**Validation.** Every reference is the same linear formula the code implements, or an identity of it: `one wave in water {Infinity,12} m deep` checks height, normal, surface and below-surface velocity against closed-form Airy theory, bound 1e-9 a (rounding, derived; self-consistent, not measured). `a JONSWAP sea` checks variance equals the spectrum's m0 (1e-9, exact), kinematic condition w = dh/dt (1e-6, finite-difference error) and divergence-free flow (1e-5): exact identities, not measurements. Seed, order, refresh, bad-option, pressure (1e-9 rho g) and `waveComponents` tests are determinism or self-consistency. `sea-agreement` checks GPU against CPU with a derived f32 bound: a renderer-agreement test, not a physics validation. No published measurement is used anywhere (no buoy, wave-staff or tank record); no Longuet-Higgins (1952) Rayleigh crest or height distribution check on the synthesised sea; no steepness or choppiness test.

**Fails points** 1, 2, 3, 4, 5, 6, 7 (point 8 is partly met: limits.md names the linear-theory differences).

**Audit list.**
1. FFT cascade with choppy horizontal displacement (Tessendorf 2001) — NOT DONE. `surface.ts` is a plain sum of linear waves, height a cos(theta) with no horizontal displacement; `grep` finds no choppy term (header, lines 1-35: "no Stokes asymmetry"). The drawn FFT code lives in `packages/water/src/fft.ts`, not in the physics sea that hulls read.
2. Jacobian (fold) output for foam and sharp crests — NOT DONE; nothing in `sample` returns it.
3. Spectrum varying across the scene — NOT DONE. Spectrum read once at `at` and applied everywhere (`surface.ts:30,253`, "taken for the whole sea until refresh()", limits.md row).
4. Currents Doppler-shift waves — NOT DONE. `currentAt` only adds the current's velocity (`surface.ts:336-339`); no k.U term in omega.
5. Horvath 2015 spectra — NOT DONE; only the wave solver's JONSWAP with cos^2 spread.
6. Steep seas (Gerstner/second-order/Stokes) — NOT DONE; limits.md still says steep seas look rounder.
7. Validate against Longuet-Higgins 1952 Rayleigh crest and height distributions, or any measured sea — NOT DONE (see Validation).
8. Cost O(bins) per point (about 816 waves) — NOT DONE; sums are still in TypeScript, no Rust/Wasm or FFT grid for many points (K17 not used by this entry).
9. Query-not-Solver, coupling — PARTIAL: wake patches (`sea-wake.test.js` "a sea adds its wake") and hull loads (`sea-surface.test.js` hull test, Archimedes to 1e-6) exist; no two-way return from bodies to the sea beyond SEA-04, no conserved-quantity account.
10. PA-11 synchronous query — DONE (`sample`, `water.sample`; "same seed gives the same bits" test).
11. Drawn water uses the same sea — DONE (4514375c8, `sea-agreement.browser.mjs` passes; limits.md "Drawn sea"), though limited to 896 waves and no sideways displacement drawn.
12. Water velocity below the surface (BS-1, BB-2) — DONE (`one wave...` test below-surface u, v, w; `sea-wake` waterBelow tests).
13. Demo rows EF-1, EF-5, BS-6, BS-3: sharp-crested swell and wave-following waterline — PARTIAL: hull rides the sea (EF-1 FIXED by the seakeeping coupling), but no sharp crests or foam Jacobian for EF-5, BS-6.

**To do before it can be VERIFIED:**
1. Add Tessendorf FFT synthesis with choppy displacement (horizontal lambda D) and the Jacobian, as a tier of `SpectralSea` using the existing K17 FFT, keeping `sample` and `water.sample` consistent with the displaced surface (invert the displacement when querying a point).
2. Let the spectrum vary over space (interpolate the wave solver's per-cell spectrum, Horvath 2015 section on spatial variation), or sum cascades per patch.
3. Doppler-shift waves by a current: omega' = omega + k.U (Longuet-Higgins and Stewart 1960 on wave-current interaction); test on a counter-current against the dispersion relation and wave blocking.
4. Validate against measurement: Longuet-Higgins 1952 Rayleigh height and crest distributions on a long synthesised record, and a published wave-buoy or JONSWAP-campaign spectrum (Hasselmann et al. 1973) reproducing Hs, Tp and m2 with derived bounds; add a Stokes second-order (or Gerstner) check of crest-trough asymmetry against Tick 1959 or Longuet-Higgins and Stewart 1964.
5. Add Horvath 2015 spectra (Pierson-Moskowitz, Donelan-Banner directional, Elfouhaily 1997) as a spectrum option.
6. Move the hot sum into a Rust/Wasm SIMD or FFT-grid path, record work counts, and test far-from-origin queries.
7. Refuse out-of-range inputs with a coded MargoError naming the fix, not bare `RangeError` and `TypeError` (`surface.ts` constructor).
8. Add a coupling test with a floating-body return (SEA-04 or SEA-12) that accounts for energy or momentum exchange with the sea.
9. Film controls: placed swell events, storm targets and a look parameter set (steepness, choppiness, whitecap seed) for EF-5, RITS-2, OO-2.

### SEA-15 Tracers and slicks in water (`@margoengine/physics/tracers`, commits ccbc86285 to 03332d94c, 28 SEA-15 commits since 2026-11-25), owner Codex: REOPENED

**Checked.** Read docs/physics-solvers.md row, the audit rows and "film upgrade progress" notes, docs/limits.md tracer sections, packages/physics/src/tracers.ts plus tracer-bed, tracer-bed-wash, tracer-wall-jet, tracer-fay, tracer-wax, tracer-evaporation, tracer-oil-dispersion, tracer-stokes, tracer-floc, tracer-diffusion, and the test files. Under run-with-timeout: `node --test` on tests/tracers.test.js, tests/coupling/tracers.test.js, coupling/breaches.test.js and coupling/swim.test.js: 66 tests, 66 pass, 0 fail. `packages/environment/tests/swim-sediment.browser.mjs` on WebGPU (1994 sand pixels at lift, 17.1 px downstream, clears after settling, 674.8 um bed relief) and on `--compat` (2023 px, same 17.1 px): both ran and passed.

**Validation.**
- Wall-jet stress vs downstream electrochemical points (tests/tracers.test.js:49, :77): published measurements, 14 points, RMS log error 0.127 to 0.097; the points are not used for fitting, but the bound is an improvement check, not derived.
- Dense sand pickup (coupling :1168): four held-out BOKA flume retreat rates, RMS log error 1.734 to 0.734, worst factor 2.81. Measurement, held out.
- Cohesive settling (:1337): Wax Lake Delta field profiles; RMS log error 4.681 to 0.854, worst factor 5.01 (fall profile). Measurement, but it is given measured aggregate size.
- Wax tank radii (:99): nine tank radii, 1.056 to 0.480. MGO tank run (:156): 0.134 m RMS vs 1.081 m. Measurements. The 30% blend is under-spread by 3.59.
- Shallow-wave Stokes drift (:666): Melito et al. tracking profiles, RMS 0.82 mm/s, envelope check. Measurement.
- Okubo/Poje scale law (:764): calibrated on Poje drifters, compared with nine Okubo dye extents; worst factor 2.34. Held-out measurement.
- CMO experiment 4 (:576): Rhodamine range check. Measurement.
- Fay spreading, evaporation, Delvigne-Sweeney, Visser drift, floc growth (Winterwerp): exact or integrated-law checks (self-consistent), bounds are tolerances.
- Free jet centreline 12.7% high vs Xia and Lam fit.
Missing: measured ray or propeller lifted mass, field oil spreading, absolute entrainment, confined tunnel flow.

**Fails points** 2, 3, 6, 7 (4 and 8 partial).

**Audit list.**
1. Van Rijn pick-up with Soulsby-Whitehouse Shields curve replacing constant 0.05 — DONE (tracer-bed.ts; coupling :1168, swim.test.js bed-stress test).
2. Phares wall-jet law replacing the 0.1/5% factors — DONE (tracer-wall-jet.ts; tracers.test.js:49).
3. Release height uncited — DONE (van Rijn reference level).
4. Bed print through EARTH-01 / TerrainBed — DONE for one writer (coupling :946, :1088; browser test). Multi-writer bedrock acceptance NOT DONE (work-queue line 106).
5. Taconite plume from a breached hold via field port — DONE (hullBreaches port; breaches.test.js; pellets vs fines).
6. Fay spreading — DONE (:351), measured only for waxy/MGO tank oils.
7. Mackay evaporation — DONE (Stiver-Mackay, :428), no independent evaporation measurement: PARTIAL.
8. Delvigne-Sweeney dispersion — DONE (:811), no absolute entrainment measurement: PARTIAL.
9. Breivik Stokes drift — DONE (:606, :666).
10. Depth-varying and scale-dependent diffusivity — DONE (:529, :764); Okubo diagram checked.
11. Flocculation — DONE (:1255, :1337), 5x error left.
12. Propeller/thruster bed lifting — DONE (:946, :1088).
13. Slicks ride the live sea — DONE (:232).
14. The ray's sand puff measured against lifted mass, original shot binding — NOT DONE.
15. Rival OpenDrift breadth (emulsification, dissolution, biodegradation, ensembles) — NOT DONE.
16. Scaling: Rust/Wasm, threads — NOT DONE (none in src/tracers*; no particle-count work record).
17. Wake and bubble sources from LIFE-03 tail — NOT DONE (known-bugs: tail wake lacks consumer).

**To do before it can be VERIFIED:**
1. Validate ray or propeller lifted sediment mass against a measured jet-scour or resuspension data set (e.g. Rajaratnam jet scour, propeller scour data) and close the short-clearance wake.
2. Accept per-writer erosion on shared bedrock grids (work-queue line 106).
3. Add emulsification, dissolution and biodegradation weathering, plus measured oil validation (Mackay evaporation, field spills), to meet OpenDrift breadth.
4. Reduce the 5.01x floc and 3.59x wax errors or derive and state their bounds.
5. Hot loops for many parcels in Rust/Wasm SIMD with recorded work counts.
6. Bind the original BB-7 and EF-11 shots and render real frames.

#### SEA-15 four-point pass

- Point 5 (3809dc24da). `packages/physics/tests/coupling/tracers.test.js` rejects the second live water sample after an earlier parcel moves. It checks all owned bytes, balances, exported port metadata and exact retry against a continuous run. The signed cell test checks offset field queries and replay. Source, field and range failures name the fix and help page.
- Point 6 and audit item 5 (3809dc24da). `packages/physics/tests/coupling/tracer-random-workers.test.js` confirms exact 1, 2 and 4 participant Box–Muller draws, sparse high counters, real dye, slick and sediment replay with exact callback order, and atomic recovery. `packages/physics/tests/tracer-random-workers.browser.mjs` starts and stops all three helpers and records 107,450 paired Philox rounds, with hash `2424abc9c94278c9`. Native output preserves the signed origin snapshot.
- Point 7 and audit item 6 technical cutaways (3809dc24da). `packages/environment/tests/breach-ore.browser.mjs` compares a sealed hold and a 131.09 kg live release on both renderers. At 4.2 s it draws 25.85 kg of suspended fine ore and 104.50 kg of accepted pellets on the bed. Full same-backend RGBA and snapshots replay exactly. `packages/environment/tests/swim-sediment.browser.mjs` verifies the moving ray, sediment plume and accepted downstream bed relief on both renderers. The original cuts are open.
- Point 8 and audit item 1 measured comparison (3809dc24da). `packages/physics/scripts/sea15-jet-scour-measured.mjs` compares two held-out ultrasonic static crater volumes using source nozzle and grains, two engine resolutions and the instrument readout interval. The 5 mm engine gives 1.29 and 1.00 cm³ against observed 57.49 and 116.47 cm³. Both miss. The static tank profiles do not constrain the cumulative, repeat-counting lifted-mass ledger. [Evidence and limits](limits.md#accepted-parcels-and-independent-jet-scour-sea-15)

Direct lifted-mass validation, evolving jet recirculation, multi-writer bed acceptance, the open accuracy and weathering regimes, and original BB-7 and EF-11 integration remain open. The row is REOPENED at four points.

### SEA-14 Water entry and exit (`physics/entry`, commits 89bec7f16, b890b38ad, 12b84154b, c002e262b), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/entry/solver.ts` (1114 lines), `slam.ts`, `cavity.ts`, `packages/physics/tests/entry.test.js`, `tests/coupling/entry.test.js`, the Water entry row in `docs/limits.md:1719`, and the audit and known-bugs entries. Ran `node --test packages/physics/tests/entry.test.js packages/physics/tests/coupling/entry.test.js` under run-with-timeout: 15 tests, 15 pass, 0 fail. The browser scripts (`water/test/splash.browser.mjs`, `hull-entry-splash.browser.mjs`) were not run; this pass is CPU tests only. The only commit since the audit date is c002e262b (hull launch observed without duplicate loads), which adds no entry physics. Nothing was changed after the audit to answer its list.

**Validation.** `entry.test.js:74` sphere slam peak: measured (Shiffman and Spencer; Antolik et al.), C in 0.9 to 1.1 at h/R 0.08 to 0.2, an uncalibrated band. `:109` ricochet: measured (Johnson and Reid), within 15% of the critical angle. `:87` cone Wagner radius: exact solution. `:139` cavity threshold (Duez, 7.2 m/s, exact to 1e-9) and pinch against Aristoff (10%): the pinch compares the code with the cavity model it implements, not a measured run. `:198`, `:206`, `:237`, `:274`, `:289`, `:306`: Archimedes draft, exit, breach, wake balance, snapshot, Lamb added mass; exact or self-consistent. The coupling file has frame-rate independence, seek and density checks (self-consistent). Speirs' measured slam impulse is in docs only (0.050 against 0.067, about 25% low), not a test. Missing: any test of exit force, crown sheet, Worthington jet speed or height, surface seal or asymmetric entry. The jet law is fitted to one golf ball (`solver.ts:131-134`).

**Fails points** 1, 2, 3, 5, 6, 7 (point 4 is partly met: the SEA-08 launch link and wake and foam sources are tested; point 8 is honest).

**Audit list.**
1. Surface seal (Marston et al. 2016) — NOT DONE. Only the deep seal exists (`solver.ts:751`); `docs/limits.md:1719` says a dome-over is not modelled.
2. Crown sheet dynamics — PARTIAL. The sheet speed is `sqrt(alpha) U sqrt(sine)` (`:572`); the sqrt(sine) factor is invented. No sheet evolution and no test.
3. Worthington jet scaling (Gekle and Gordillo 2010) — PARTIAL. A constant 9.85 ratio (`:134`) calibrated on one sphere; no test.
4. Bubble pinch-off — NOT DONE.
5. Truly asymmetric entry — NOT DONE. An equivalent axisymmetric body is used.
6. Exit-force validation against Truscott et al. — NOT DONE. No test.
7. Speirs slam impulse as a test — NOT DONE. Docs only.
8. Cavity gate `sine > 0.5` uncited — NOT DONE (`:567`).
9. Invented sqrt(sine) grazing factor — NOT DONE (`:572`).
10. Hard-coded 1025 kg/m3 — PARTIAL. Lines 313 and 384 read the sea's density, but `:573` and the default at `:204` still use 1025. KB-PHYS-AUDIT2 still lists it open with no regression test.
11. Jet speed ratio calibrated on one case — NOT DONE (`:134`).
12. SEA-08 link — DONE. Test at `tests/coupling/entry.test.js:62` ("EntrySolver observes a launching HullSolver hull without duplicating loads or wake displacement").
13. FLIP or VOF splash sheets rival — NOT DONE.

**To do before it can be VERIFIED:**
1. Add a surface seal and crown sheet model (Marston et al. 2016, JFM; Aristoff and Bush 2009) and test it against their measured dome-over or seal times.
2. Replace the 9.85 jet ratio with the Gekle and Gordillo (2010) scaling, and test it on at least two measured spheres or discs, one of them not used to fit.
3. Add exit-force tests against Truscott et al. measurements, and the Speirs et al. slam impulse as a test.
4. Read the water's density at `solver.ts:204` and `:573`, with a regression test (KB-PHYS-AUDIT2).
5. Cite or derive the `sine > 0.5` gate and the sqrt(sine) factor (`:567`, `:572`), or replace them with a cited law.
6. Add bubble pinch-off and an asymmetric entry (a body pitched or a diver), each with a measured case.
7. Add a coded-error test for out-of-range inputs beyond the existing refusals; add a scaling record (work counts, Wasm for the slam profiles).
8. Add a film-direction test: seeded or placed splash events and look parameters.

### SEA-12 Hydrodynamic loads on arbitrary bodies (`@margoengine/physics/loads`, commits 5d2524732, 7bcfb11e3), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/loads/{solver,morison,segments,shapes,quay}.ts`, the four test files and the audit and known-bugs entries. Commits: 5d2524732 (the solver, 2026-11-26) and 7bcfb11e3 (rod segments loaded by the water, SOFT-02, 2026-11-26). Under run-with-timeout, `node --test` on `loads.test.js`, `loads-segments.test.js`, `load.test.js` and `coupling/loads.test.js`: 16 tests, 16 pass, 0 fail. No browser test exists (CPU-only solver).

**Validation.** `loads.test.js` "Lamb's ellipsoid integrals": a published table (DNV-RP-C205 D-2), added-mass coefficients, bound 0.001. "Morison's coefficients follow DNV-RP-C205": published curves, reference is the standard's own fit, not measurement. "a pile's wave load, a sphere's drag...": worked numbers from the same formulas, self-consistent. "a light sphere ... (1 + C_A)/(m/(rho V)+C_A)": exact solution of its own equations. "a steel ball sinks at its terminal speed": analytic solution of its own drag law (2%); the sphere drag fit is the one it checks. "a crate floats ... leeway": a few percent of wind, qualitative against leeway literature. "a fixed pile sheds at St U/D": the code's own oscillator. Sainflou, Goda and PIANC tests are closed formulas re-evaluated. `loads-segments.test.js`: White's fit and DNV steady drag, closed forms. Coupling file: only frame-rate independence and seek. Still missing: any measured data (Sarpkaya 1976, Keulegan and Carpenter 1958, Haehnel and Daly 2004 debris impact, tank flotation or capsize), and any held-out case.

**Fails points** 2, 3, 4, 5, 6, 7 (1 and 8 are partial).

**Audit list.**
1. Buoyancy righting moment so divers and debris settle their attitude: NOT DONE. `solver.ts:~333` applies buoyancy at the shape centre; the torque is only `(centre - cm) x force` (about `:378`). No centre of buoyancy; no heel test. The research recipe in `physics-solver-audit.md:266` is unbuilt.
2. Exact submerged-volume buoyancy (catalog; known-bugs "floating bodies have no righting moment"): NOT DONE. Box prism is exact only upright, other shapes an equivalent ellipsoid (`:307-313`). The known-bugs entry is still open.
3. Morison loads on soft-body rod segments (hoses, cables): DONE. `segments.ts` (`segmentLoads`) and 7bcfb11e3; tests "a submerged segment floats..." and "a segment through the surface..." in `loads-segments.test.js`, plus the rod tests. Closed forms only, no measured case.
4. Mesh pressure integration (reuse SEA-08 wetted loads): NOT DONE.
5. Cummins radiation damping and rotational added inertia: NOT DONE (catalog admits it).
6. Haehnel and Daly debris impact, anchors: NOT DONE (no code).
7. Validation against Sarpkaya 1976 and Keulegan and Carpenter 1958: NOT DONE.
8. Two-way coupling tests with HYDRO-01, SEA-08, LIFE-03: NOT DONE. The only coupling tests are frame rate and seek; flood coupling is one-way.
9. Red flags: wind at 1 m, ad hoc emerged area, default Cd 1.0, spin drag reusing Cd: not fixed (`solver.ts:63`, `:372`, defaults still 1).
10. Coded errors: NOT DONE; plain `TypeError`/`RangeError` are thrown (`solver.ts:167-198`), no `MargoError`.
11. Rust/Wasm or threads, work counts: NOT DONE.

**To do before it can be VERIFIED:**
1. Build a centre of buoyancy and righting moment (exact box and mesh via wetted pressure integration, cap centroid for ellipsoids) with a heel test against hydrostatic GM theory, and close the known-bugs entry.
2. Validate against measurements: Sarpkaya 1976 or Keulegan and Carpenter 1958 force coefficients, a published flotation or roll decay test, Haehnel and Daly 2004 impacts, with derived bounds and a held-out case.
3. Add radiation damping (Cummins 1962), rotational added inertia, debris impact and anchors.
4. Two-way coupling tests with HYDRO-01 (bodies block flow), SEA-08 and LIFE-03, with momentum accounted.
5. Replace the red-flag constants with cited values; throw `MargoError` with a help link.
6. Add a Wasm hot loop for many bodies, work counts, and limits entries.

**2026-11-26 upgrade progress.** The centre-of-buoyancy correction passes the manufactured finite-angle box and
mesh cases, the small-heel metacentric limit, and the transformed ellipsoid half-cap test. A real rigid model
settles at 26.91° using the published weight or 26.68° using the incompatible published relative density
for the independently photographed 27.5° float. The derived image-resolution band is 0.92°. All bare
argument errors in the loads entry now use `MargoError` with a specific repair and help anchor. Dynamic pressure
validation, roll decay, hydrodynamic radiation, reciprocal water coupling and native scaling remain open.

  The surface-pressure mode integrates live incident pressure for boxes or closed meshes. The pressure and
  sloping-waterline tests in `packages/physics/tests/loads.test.js` check its force and moment and show that
  incident acceleration contributes once. Two member tests reproduce the missed short wetted interval and
  the phase-dependent KC error. The held-out Sarpkaya 1976 test compares force coefficients and the measured
  peak of ten β = 4480 runs against calibration from β = 3123 and 5260. Mass and drag mean absolute errors are
  0.092 and 0.063, compared with 0.039 and 0.214 for DNV. The maximum normalized peak-load error is 0.374.
  The 57 Keulegan–Carpenter 1958 runs are outside this calibration. Their maximum β, including printed
  rounding, is below 3,076. The Sarpkaya calibration starts at 3,123. The DNV fallback reproduces these
  subcritical data with mean absolute errors of 0.429 in inertia and 0.379 in drag.

  The next checkpoint adds implicit rotational water inertia, passive modal Cummins radiation and measured
  woody-debris impact. `loads.test.js` checks rotational coefficients against the NACA Report 323 table, the
  rigid torque against its exact mass-inertia equation, and radiation against a two-state implicit reference plus
  snapshot replay. `coupling/loads-debris.test.js` checks the held-out concrete support and off-centre impact
  load-cell groups, the exact elastic pulse, and single reciprocal normal impulses on a mutually filtered pair.
  `coupling/loads-reciprocal.test.js` checks SEA-08 hull and LIFE-03 active tail exchange with immersed SEA-12
  bodies through actual shallow water. Its held-forcing receiver is a test fixture. Native surface-water
  momentum receipts and passive swim-water reactions remain open.
  `coupling/loads-mooring.test.js` checks the taut tether's fixed-pile reaction, slack engagement, the axial
  oscillator at two world rates, off-centre dynamic attachment impulses, and bit-exact replay.
  The drag and wind revision replaces the four red-flag shortcuts. `loads-compact-drag.test.js` checks the
  clipped projected shape, centroid wind, separate spin law and a held-out cube series. The live loads tests
  cover the resulting wind wrench, submerged spin with translational drag disabled, independent origin cells,
  and the SIMD batch against the TypeScript rigid trajectory and snapshot. `loads-kernel.test.js` checks both
  memory builds, including locked axes, sparse rows and malformed input regions.
  The moving-free-surface test keeps both ends of the acceleration stencil at a common wet point. It guards
  the false acceleration impulse reproduced by the live sea fixture as a wave crosses a floating body's sample.
  Water's `loads-quay.browser.mjs` exercises FW-6 and CY-9 at component level. On both GPU backends the existing
  wake changes the advancing vessel and the debris trajectory, supplies the quay's wash and crest, and
  drives the rendered mesh. The wake-only draw changes 3,212 WebGPU pixels and 3,211 WebGL2 pixels.
  The worst wake geometry difference is 0.29 μm. The two rigs replay to hash `2403bb19b4c9de7f`.
  `coupling/moving-cylinder-blockage.test.js` proves accepted pressure, geometric displaced volume,
  next-tick feedback from a real rigid row and replay for a guided cylinder and a rectangular pier.
  `coupling/flood-blockage.test.js` proves the paired impulse for partial immersion. The live
  `coupling/loads-paddle.test.js` and `coupling/loads-wading.test.js` cover LIFE-07 shaft torque and
  LIFE-01 water/body exchange and reduced load on the stance contacts.
  `loads-radiation-profile.test.js` validates passive strip and panel modes against their reference band and
  the held-out Vugts triangular section. The loaded resonator test holds the six-axis body's linear and
  angular damping against the exact discrete system. `coupling/loads-reciprocal.test.js` now also uses the
  public passive swim and body-drag receipts with live shallow water and independent disable controls.
  It closes opposing impulse per step to (2.02×10^{-16}) N·s and the 44-frame total to (3.94×10^{-7}) N·s.
  `coupling/loads-hull-projected-drag.test.js` exercises reciprocal drag on the production SEA-08 hull
  and SEA-12 debris in the same water. The two moving bodies return momentum through separate profiles.
  The 48-frame maximum drift is (1.02×10^{-6}) N·s with identical plain and shared replay.
  `coupling/flood-body-drag.test.js` checks eccentric torque, yaw-dependent projection, dry zero,
  passive energy and framework seek. The fitted-draft handoff uses the same coefficients in the
  live TypeScript and SIMD heave and roll solves and checks their held wrenches against the implicit recurrence.
  `coupling/loads-swim-actuators.test.js` checks two-way tail and fin recoil through the production receiver,
  live HYDRO and projected rigid drag, with independent disabled paths. The worst water-step momentum
  residual is (1.27×10^{-15}) N·s and the 40-frame total residual is (5.77×10^{-7}) N·s.
  The guided cut-cell upgrade closes and reopens an entire cell without dividing by zero storage.
  `coupling/moving-cylinder-blockage.test.js` accounts for volume, pressure reaction and energy through
  a periodic seam, and reproduces its state hash. The count stays fixed at two substeps per tick at rest
  from 99% occupancy to full coverage. A separate fully closing footprint repeats 50 seams
  over 1,200 ticks and 7,200 pressure stages with 0.125 m³ of water and 234.375 N·s water
  momentum conserved to floating-point roundoff and bit-exact replay.
  `loads-radiation-coupled-profile.test.js` compares the full panel fit to its numerical reference and
  checks the independent Vugts width-confined sway–roll experiments. It verifies signed cross terms and
  a reactive pole outside the sample band. `loads-coupled-radiation.test.js` checks all six wrench components
  about an offset centre, pressure-independent passive memory, dry and rewet transitions, two native
  layouts and replay. `loads-kernel.test.js` guards exact legacy behavior, the coupled numerical envelope
  and rejection of a singular six-axis matrix before it publishes a wrench.
  The opt-in rigid wake uses accepted transverse point acceleration and the actual wetted lift arm.
  `coupling/loads-member-viv.test.js` matches the independent Carberry force-transducer peak at two
  rates, finds the uncoupled control outside the bound and checks live linear and angular impulse.
  Quantitative force phase and free-response amplitude remain outside that frequency qualification.
  `coupling/projected-drag-settlement.test.js` checks accepted drag after Hydro transport, f64 wetness,
  a rejected dry impulse, an independently rewet control, overlap order and bit-identical seek.
  Its periodic seam regression reproduces the two-sided impulse discontinuity and verifies the wrapped
  force, nearest-image yaw moment, one-cell alias handling and replay. At 1 μm from the seam, the
  impulse magnitude falls from 0.0179085 to (6.88×10^{-12}) N·s.
  Water’s `shallow-surface.browser.mjs` draws a single coupled Hydro state. Both renderers show the
  16.331 mm depth change with a draw residual below 0.086 μm and verify the associated rigid
  pressure impulse, volume and replay. `water/test/flood-rigid-drag.browser.mjs` exercises the standalone
  Flood's reciprocal horizontal drag with one free body on both renderers. It checks stored momentum,
  dry and locked-body cases, and paired recovery after abort.

  A local First Wake diagnostic used the archived camera and assets at 71 s with a closed hull proxy.
  Turning on the reciprocal wake changed solved heave by 0.139 m, sampled quay crest by 0.564 m,
  and sampled peak wash by 0.022 m/s. The rig held the authored horizontal track and attitude.
  Its hull dimensions came from the scene and the proxy mass from displacement. These are paired
  simulation results. Production wall reflection, splash and foam still need their surface bindings.
  The original First Wake render hull's 331,065 triangles contain 171 open, nonmanifold or
  inconsistent edges after welding coincident vertices. Of these, 116 have an endpoint below the
  authored waterline. The hydrostatics mesh validator rejects this surface, which is why the
  diagnostic uses a closed solver proxy. Cyprus playback also remains open.

  The continuous First Wake diagnostic ran from vessel time zero on an extended 1.2 m wake grid.
  It rendered the original camera and assets at 67 s and 71 s on WebGPU, with 3,765 and 4,005
  solver ticks. At 71 s the solved heave differed by 0.216 m from the disabled-wake control.
  The 3.16 m absolute peak was a trough. Signed replays on the same domain show a +2.49 m crest and −3.16 m
  trough at 71 s, and +3.13 m and −2.72 m at 67 s. Turning off feedback from wake to hull leaves the high
  waves. Turning off forward displacement leaves only centimetre-scale waves at the strongest earlier time.
  The advancing source concentrates submerged flux at the surface centreline. Qualification of its depth and
  width treatment and the production wall interaction remain open.

  A continuous diagnostic projected the same advancing source from its submerged depth and width over the same
  1.2 m grid. At 71 s it measured +0.329 m crest and −0.523 m trough over 4,005 ticks. The maximum volume
  projection residual was 2.86×10⁻¹⁴ m³ per step. This isolates the forcing error. The grid does not resolve
  the 1.435 m steady transverse wavelength at that time. Independent amplitude, energy exchange, resolved
  production reflection and splash still need qualification.

  The opt-in production source transfer in `46d930c1a5` conserves signed volume while distributing advancing
  hull flux over depth bands and transverse quadrature points. `sea-wake.test.js` checks the finite-depth modal
  response, and `coupling/seakeeping.test.js` checks the live transfer and frame-zero replay. The actual First Wake
  trajectory runs all 4,005 ticks with the new source. On the same 1.2 m grid the 71 s crest is +0.334 m and the
  trough −0.522 m. The eight-length independent KRISO KCS run has 15.10 mm profile RMS error against 0.4695 mm
  measurement uncertainty. The predicted profile RMS is 25.70 mm versus 15.32 mm measured. No values were fit
  to that cut. The linear wake mode remains outside the amplitude requirement.

  Intersecting the archived quay mesh at still water gives the main wall at z = −10.55 m and the east return
  at x = 200.4 m. The old diagnostic used the above-water lip at z = −9.93 m. At 9.7 m depth the existing
  shallow-water wall's propagation speed is 9.75 m/s, versus 2.07–4.59 m/s for the authored wave bands.
  A prognostic dispersive quay boundary and its impact-to-spray transfer remain open.

  The subcell source correction in `c726258102` reduces the frozen KRISO KCS eight-length signed RMS error
  from 15.10 to 13.86 mm at 60 Hz and 0.25 m spacing. The test in `sea-wake.test.js` checks volume and signed
  Fourier modes for a moving patch against exact area weights. The aft part of the measured cut still has 17.90 mm
  profile RMS against 34.60 mm predicted. At 120 Hz and 0.125 m spacing the corrected full error is 14.40 mm
  at the same checkpoint, and aft RMS is 38.46 mm. These two spacings show that the profile discrepancy survives
  grid refinement. Neither the source weights nor the tank inputs were fitted to that cut.

  The strip orientation correction in `28cd511079` leaves the structured KCS loft's 469 signed samples and
  the 2-, 5- and 8-length world hashes bit-identical at both spacings. At the common 120 Hz solver rate, the
  0.25 m and 0.125 m physical grids give 13.647 mm and 14.401 mm signed RMS error after eight lengths. Their
  predicted RMS is 25.515 mm and 26.295 mm alongside 15.325 mm measured. The two profiles differ by 2.712 mm
  RMS. The freeze uses the fixed bare hull at 2.196 m/s, 0.3418 m draft, 7 m water depth and y/L = 0.15094065,
  with a 1/16 Froude length scale and no fitted phase or scale. The receiving grid uses an absorbing border.
  The reported experimental scale is 0.4695 mm. [NMRI case and geometry](https://www.nmri.go.jp/study/research_organization/fluid_performance/cfd/cfdws05/Detail/a1-1/index.html)
  [Independent signed wave cut](https://www.nmri.go.jp/study/research_organization/fluid_performance/cfd/cfdws05/Detail/data/KCS_data/fixed/wave_cut.dat)
  [Kim, Van and Kim, 2001](https://doi.org/10.1007/s003480100332)

  The longitudinal mode of a rectangular hull exposed an extra beam-sized convolution on each lateral
  quadrature point. `0dc6e0416a` removes that second beam dependence. It matches the exact end-face mode,
  including the known bilinear scatter and depth transfer, in `coupling/seakeeping.test.js`. The same file's
  code-built and GLB-imported workboat test gives identical rise, righting, rigid trajectory, wake and replay
  for the same geometry and mass properties. The live free-motion test still closes the combined wake work
  to 0.00088 J, and the existing coupled quay test passes on WebGPU and WebGL2.

  Under the same KCS freeze the corrected footprint gives 15.764 mm RMS at 0.25 m and 16.536 mm at
  0.125 m. The fine port still carries 1,300 signed rows with the same band volumes and transverse moment.
  Its world hash is `1a3ed8eea60cf8b4`. A separate even-reflection control on the previous 0.25 m source
  shifts the result from 13.647 to 13.684 mm RMS. The footprint correction fixes the analytic source
  mode and increases the measured profile error. Neither footprint nor the sidewall control closes the
  held-out case. The independent geometry and forcing inputs were frozen for every comparison.

  An offline body-fitted prismatic potential-flow diagnostic improves the frozen KCS signed error to
  7.169 mm and 8.148 mm at 0.25 m and 0.125 m. Its manufactured signed trace errors refine from
  14.70% to 7.88%, tow work stays positive, and the two predictions differ by 2.996 mm RMS.
  Geometry, advection, regularization and predictions were frozen before scoring all 469 measured
  stations. The fine error is above the 0.4695 mm experimental uncertainty and the aft interval has
  a 13.87 mm error. At the raw centerline transom lip the flat free-surface model predicts 59–65 mm
  of water above the actual solid edge with no flow reversal at the sampled probes. The experiment
  reports wash-over and unsteady stern flow. The current runtime held-out item remains open.
  [Kim, Van and Kim, 2001, §4.1](https://doi.org/10.1007/s003480100332)
  [Independent KRISO signed wave cut](https://www.nmri.go.jp/study/research_organization/fluid_performance/cfd/cfdws05/Detail/data/KCS_data/fixed/wave_cut.dat)

  A separate stern diagnostic retained the actual above-water shape from the full-height NMRI IGES.
  The model transom lip is 15.8 mm above design water. At an independently specified +47.405 mm
  height, two tessellations integrate 1.57611 and 1.57673 N of hydrostatic load on the aft face.
  The separate original offset integration gives 1.58645 N. Extruding the centre-plane pressure
  across the wetted width would give 3.260 N. This checks geometry and integration with a static
  prescribed height. It is not a measured load comparison.

  In the 3D transient diagnostic, the solid volume and open face areas come from the same
  piecewise-affine geometry. A tilted-facet control checks the volume and both apertures exactly.
  Full-span uniform inflow at 0.04 and 0.02 m has no discarded open face area and agrees in lateral
  velocity RMS within 0.027% at matched duration. Mass and pressure reaction residuals stay below
  5.56×10⁻¹⁷ m³ and 7.50×10⁻¹⁵ N·s, respectively. These checks qualify the pressure and flux routing
  for the frozen geometry.

  The earlier prismatic solve supplies a predicted 3D inlet. The transient samples 49 measured
  velocity stations at the fixed published plane after freezing the output. At 0.24 s, the
  aft, lateral and vertical RMS errors are 0.7990, 0.04556 and 0.11696 m/s on the 0.04 m grid.
  The 0.02 m grid gives 0.8113, 0.03757 and 0.12214 m/s. The 0.04 m run through 0.72 s gives
  nearly the same errors. Moving its inlet 0.12 m upstream changes axial error to 0.6709 m/s.
  All are above the 0.00835 m/s experimental uncertainty. The lip wets locally, and no resolved
  reversal develops. None of the observed velocities set the inlet or tune numerical parameters.
  The separate Maki step experiment reports a shedding Strouhal number near 0.20. The finest
  local diagnostic predicts 0.1002. A vortical 3D incoming flow, transmitting outer boundary
  and near-wall shear treatment still need to be qualified.
  [Maki, Beck and Troesch, 2005](http://www.iwwwfb.org/Abstracts/iwwwfb20/iwwwfb20_40.pdf)
  [NMRI KCS geometry](https://www.nmri.go.jp/study/research_organization/fluid_performance/cfd/cfdws05/Detail/KCS/kcs_g%26c.htm)
  [Independent near-stern velocity cut](https://www.nmri.go.jp/study/research_organization/fluid_performance/cfd/cfdws05/Detail/data/KCS_data/fixed/kcs_vel_cut_wop.dat)

  The straight-quay coupling in `fbee5a3b75` enforces zero normal flow in the controlled reflected mode.
  The normal velocity is below 2×10⁻¹⁵ m/s, with an open-control speed of 3.88 mm/s in the live hull test.
  A separate low-crest browser fixture draws the coupled surface within 2.47×10⁻⁸ m of the solver on both renderers.
  Only reflection raises the physical crest above the sill. The Water binding clips its image domain and spawns
  a burst from the accepted crossing and interpolated velocity. The control still passes the subcrest and replay
  checks. This validates the composition on a straight wall with a clear hull path.

  Transforming the 215,465 vertices of the archived render hull with its authored scale and pose confirms that
  the underwater surface passes through the actual main quay face from about 4.25 to 16.67 s of vessel time.
  A point is 5.80 m behind the face at x = −22.585 m and vessel time 8.42 s. This is within the main quay span
  and is independent of the closed hull proxy. A diagnostic departure eased out over vessel time 7.65–55.65 s
  had at least 1.02 m clearance to the wet face in the sampled geometry and returned to the authored path before
  the reviewed shot. The diagnostic changes the earlier ship motion. The archived shot has yet to be corrected
  and rendered with a resolved reflective wake. An independently checked one-key revision changes the first
  sideways easing endpoint from 26 to 56 s. Indexed triangle and between-sample bounds give 1.234 m clearance
  to the wet face, 0.278 m to the lip at sample times, and at least 0.200 m for the full course. It reproduces
  the original camera and ship pose at all 1,657 reviewed samples. The east return and water beyond the main
  wall enter the frame. A straight half-plane mask would hide that water, so the full shot needs finite-quay scattering.
  The one-key change rendered archived frames 307 and 368 at 1920 × 1080 on WebGPU and WebGL2, with all twelve
  original assets and the authored camera. Those frames retain the original procedural wake and establish clearance.

  The new prescribed-path ledger in `coupling/loads-prescribed-wake.test.js` reads the exact submerged sources
  from an advancing HullSolver and covers 60 ticks with actual propagation. It accounts for 447.5221 J in open
  water and 485.6044 J in the wet half of a reflecting quay, with maximum errors of 2.16×10⁻¹² J and
  4.21×10⁻¹² J against independent water-state energy and exact replay. This accounts for work in the prescribed
  source. The optional `coupling/loads-surge-wake.test.js` closes the free guided-surge loop on plain
  and shared layouts. At 90 ticks 274.829 J transfers from a live rigid hull to water, with a 0.000171 J
  maximum residual against a 0.01717 J f32 roundoff bound. The disabled control adds 505.701 J to
  water with unchanged body energy. A pre-existing wave starts a hull at rest. Frame zero and mid-step
  checkpoints replay exactly. Prescribed surge and surface-volume work now use a single joint energy change.
  The heaving and rotating mirrored case transfers 783.3405 J, closes to 6.03×10⁻¹² J, rejects unsupported
  pressure before changing the ledger and replays exactly. The free-motion tier now pairs surge, heave, roll
  and pitch on a guided anisotropic native hull and a single periodic wake. The live test accounts for
  1,097.17 J entering the water, with 0.00083 J maximum imbalance against 0.0311 J of f32 roundoff allowance.
  With the return disabled the imbalance rises to 2,719.02 J. Both layouts replay exactly. The wave supplies
  zero yaw torque and this free-motion case omits wall reflection.

  A continuous prescribed-motion diagnostic takes the corrected archived poses as exact 60 Hz chords. It uses
  the closed hull proxy and both its live HullSolver ports. On the 240 × 80, 1.2 m straight-wall periodic grid,
  it advances from vessel time zero to film 1:11 in 4,005 ticks. At that time the separate potential-and-height
  energy integral differs from the prescribed work by 1.66×10⁻⁶ J. Restoring film 1:07 and re-advancing gives
  hash `69247bab3a5ca545` both times. This proves time and work accounting across the original departure.
  The grid does not resolve the short waves, and a straight mirror cannot represent the finite quay ends.

  A closed 9,100-triangle physics hull derived from the original render geometry replaces the nine-station
  stand-in in the diagnostic. At the original waterline its submerged volume is 4,330.90 m³ against
  4,335.26 m³ from integration of the original section envelope. At 127 intermediate stations unused in
  construction, area RMS error is 0.52 m² compared with 30.20 m² for the old proxy. These are geometry
  comparisons, not tank measurements. The actual hull exposed a strip integration bug. Cyclically rotating
  a triangle could reverse the sign of its cut, so area and first-moment terms cancelled. Oriented crossings
  fix the integral before it feeds the submerged source. The two analytic box regressions check exact section
  area, centroid, signed wake volume and lateral moment after reindexing. See Journée and Massie (2001),
  [Offshore Hydromechanics, §8.3](https://ocw.tudelft.nl/wp-content/uploads/OffshoreHydromechanics_Journee_Massie.pdf),
  for the section-based load model.

  On the same 1.2 m diagnostic with the actual derived hull and corrected course, the 4,005-tick replay
  ends with 4.255 MJ of water energy. The independent water integral and prescribed work differ by
  8.77×10⁻⁷ J, and the film 1:07 snapshot repeats the film 1:11 hash `94c58054fcc32923`.
  With the longitudinal footprint correction, the same unresolved diagnostic ends at 6.084 MJ and closes
  the work to 1.003×10⁻⁶ J. Seeking from 1:07 reproduces the new 1:11 hash `5e69c9b2f04e731b`.
  The original shot still needs resolved diffraction around the finite quay and its spray transfer.

  The indexed waterline contour runs from x = −79.00 to 201.00 m and z = −105.10 to −10.55 m.
  Both reviewed cameras see open water beside the east return at [206, −16] m. The archived apron stops
  3.98 m above the seabed, so extending that footprint to the bed changes the modeled geometry. Its exact
  shutters bracket vessel ticks 3765–3766 at 1:07 and 4005–4006 at 1:11. The transverse wake wavelengths are
  1.424 and 1.435 m at those anchors, and the Kelvin cusp wavelength is about 0.95 m. At 0.15 m spacing the
  full finite return needs at least 1.728 million projected cells before adding a sponge. The public
  source grid cap is 1.049 million and the straight image cannot preserve the return's water topology.
  The boundary receiver for this shot must accept the same-tick hull sources and publish height, velocity
  at depth and its own discrete work receipt. The renderer, hull and spray need that same accepted state.

  The loads-local `FiniteQuayWake` now accepts both hull source layouts and carries the wave around fixed
  faces with open tips and depth-dependent wet cells. The finite-volume tests in `coupling/loads-finite-quay.test.js`
  verify zero flux through a blocked face, transmission through its open lower layer, reciprocal surface work,
  one-sided wet sampling, accounted sponge loss and exact replay. The midpoint advance uses the same accepted
  3D potential for the surface and depth velocities. In the independent Porter–Evans half-depth barrier case,
  the live packet transmits 69.06% at 0.50 m spacing and 78.22% at 0.25 m. The continuum energy fraction
  integrated over that incident spectrum is 86.08%. The coarse-to-fine complex carrier coefficient error
  falls from 0.229 to 0.109. The vertical column preconditioner lowers the fine barrier solve's maximum
  iteration count from 276 to 67 with the same scattering coefficients within 2×10⁻¹¹. The real First Wake
  prefix on a 300 × 160 grid with nine layers starts emitting at vessel tick 100. At tick 110 its water
  carries 2.482 J, with 4.23×10⁻⁸ J absorbed and work residual below 2.8×10⁻¹⁴ J. The 1.2 m grid does not
  resolve the shot's wakes, and the active step still uses 1,200 combined iterations. A 0.075 m single-level
  full-frontage case needs about 84.1 million wet-volume slots and 8.13 GiB in this implementation before
  input masks and checkpoints. These checks isolate the finite-domain model, spatial error and scale cost.
  Measured finite-edge validation, a scaled receiver for the original footage and the full render remain open.
  [Porter and Evans, 1995](https://doi.org/10.1017/S0022112095002849)

  A real coarse finite diagnostic now runs the corrected vessel from tick zero through tick 4,006.
  The original 67 s and 71 s shutters read the same accepted state on WebGPU and WebGL2, with all 12
  original assets and the original camera. The reported GPU height residual is below 0.45 µm and the
  final checkpoint replays exactly. The 8 m horizontal grid preserves the finite ends and the 3.98 m
  under-apron opening. It gives diffuse unresolved waves. The 370 surveyed sites measure peak water
  heights 0.200 m and 0.149 m against crest heights of about 1.982 m. No crest crossing occurs in
  the diagnostic. The full run's maximum relative work residual is 1.77×10⁻¹¹.

  The finite potential now provides time-centred Bernoulli pressure at depth. The analytic standing-mode
  test checks the pressure at each depth against an independent harmonic recurrence. A live rigid hull
  emits both finite-wake sources and moves differently with the returning pressure enabled. The water
  work closes and both controls replay exactly. This verifies a two-way connection for the chosen hull.
  Matching the full mechanical return work and resolving the original quay and stern remain open.

  A geometry-preserving Galerkin correction reduces the fine aperture run from 67 to 14 maximum iterations.
  Complex scattering changes by less than 3×10⁻¹¹ and the run replays exactly. The manufactured three-dimensional
  case at 0.075 m reduces its harmonic solve from 1,316 to 66 iterations. The regression checks the exact fine
  potential and open-face flux on two odd grids and confirms a fully sealed side stays exactly at zero.

  On the actual First Wake 1.2 m prefix the same Galerkin change cuts the active combined iterations
  from 1,200 to 115. At tick 110 the water energy agrees between solvers within 8.4×10⁻¹⁴ J.
  The renderer now reads `FiniteQuayWake.surfaceMask()` directly. The chained Water quay test checks
  4,225 positions and normals on WebGPU and WebGL2 within 1.11×10⁻⁷, including a closed corner ray and
  an open corner ray. The dry in-grid patch matches the no-water reference exactly.

  `coupling/loads-surge-wake.test.js` also exercises a rigid guided hull on a non-periodic 37×19 grid with a
  finite curtain, a submerged opening and an active absorber. The shared displacement operator and reciprocal
  surge impulse book 361.314 J into the wave and sponge, with at most 0.000211 J of total energy discrepancy
  against the f32 rounding bound of 0.00916 J. This closes longitudinal work at fixed draft. The unpaired
  control generates 468.358 J while retaining its initial speed. The coupled run replays exactly in both
  memory modes. The full free-motion ship and the resolved First Wake shutters are still open.

  `coupling/loads-free-hull-wake.test.js` matches finite-quay returns for heave, roll and pitch as well as surge.
  It reads the wave potential, elevation and normal flux independently and integrates the native applied rigid
  loads. The 48-tick run transfers 1,145.211 J into the wave and sponge. Total work closes to 0.000872 J
  against the f32 bound of 0.01610 J, and both memory modes replay bit for bit from two checkpoints.
  The remaining First Wake issue is resolving the actual source and propagating its waves through the full scene.

  `coupling/loads-quay-space-order.test.js` checks the fourth-order horizontal stencil on a diagonal
  carrier. With the vertical grid held fixed, at 0.15 m the absolute normal-flux rate error falls
  from 0.12977 to 0.00974 m⁻¹. This is below the 0.03261 m⁻¹ error of the default 0.075 m grid.
  The same test checks the reciprocal flux and conservation through a partial lower opening, zero
  cross-wall flux at a closed face and exact replay with the absorber active.

  The eighth-order option in `coupling/loads-quay-space-order.test.js` reduces the same carrier's
  horizontal-rate error at 0.15 m from 0.009739 to 0.00009570 m⁻¹. This is under one fifth of the
  fourth-order error at 0.075 m with one quarter of its horizontal cells. The aperture test checks
  reciprocal flux, zero flow at every closed face, volume balance, sponge work and exact replay.
  On the 22.63 m source-to-quay mode probe, the isolated horizontal phase error falls from 0.05762
  rad to 0.000186 rad. At 29 vertical layers the vertical error is still 0.405 rad. The separate
  fourth-order temporal error is 0.00255 rad. Run the mode probe with `--phase-only` to reproduce
  these isolated dispersion comparisons. The original shot still requires convergence of its depth
  response and diffraction.

  An analytical slab comparison isolates depth pressure from horizontal dispersion. An offline
  cubic Galerkin basis with 31 open-column and seven under-apron degrees of freedom aligns with
  the physical source bands and the 5.72 m opening. Across five frozen wavelengths from 40 m to
  0.9496 m, its distributed-pressure matrix error is at most 0.872%, cross-aperture error 0.782%,
  and error for a specified signed force quadrature 2.03%. At the shortest wavelength the
  corresponding 33-layer finite-volume errors are 4.46%, 14.53% and 12.25%. The independent
  point-source control still misses at 0.9496 m with a 49.66% full pressure-matrix error and
  33.91% across the aperture. An exact local Green jump correction in a depth-separable model
  reproduces the source-split control within 6.81×10⁻¹³. The general finite geometry needs an
  equivalent for its spatially varying horizontal operator. The offline comparisons do not
  change the runtime or qualify its depth pressure.

  The eighth-order layer encountered a convergence refusal on the initial potential derived from
  the archived hull sources. Its stronger horizontal stencil needs a lower weight in the
  symmetric column relaxation. With the weight corrected, the high-frequency masked-grid regression
  in `coupling/loads-quay-eighth-smoother.test.js` takes 25 and 26 iterations on the even and odd
  grids. The old weight took 469 and 724, and hit the convergence limit in the layered-aperture
  case. That case takes 49 iterations with a worst local flux residual of 3.76×10⁻¹² m³/s across
  the three cases. The linear solver tolerance and iteration limit are unchanged.

  In a run of seven fully open faces the eighth-order flux now uses four cell-pair differences
  and zero staged face corrections, down from nine. The aperture-weighted route remains at
  fractional or closed faces. The 7.2 × 4.2 m local aperture case can use the compact stencil
  on 51,944 of 66,008 horizontal faces at 0.15 m and 240,592 of 268,720 at 0.075 m. The flux
  regression compares both routes against independent successive applications of the face
  polynomial to within 8×10⁻¹⁶ for its test field.

  The Galerkin assembly now reuses the fine-cell labels and stores coarse edges in bounded pages.
  This removes two dense integer buffers, about 420 MiB at 55 million fine cells, and the separate
  full-size copies of coarse edges. `coupling/loads-quay-hierarchy-memory.test.js` checks original edge
  order, protected zero edges, identical projected fields and replay. On the separate regional grids
  at 0.15 m and 0.075 m, the lower opening retained nonzero flux and the 0.001 m³ load balanced
  within 4×10⁻¹⁷ m³. This reduces setup memory. A full-box preflight at 0.15 m and 34 layers
  assembled the original 400 × 240 m mask and the hierarchy for 145,084,800 volume slots,
  of which 107,565,639 are wet. The operator held 16.78 GB of typed arrays after setup.
  The ten-minute preflight stopped during its first nonzero harmonic projection.
  The probe used a localized trace from the archived incident spectrum on the full mask.

  The larger eighth-order solves now add the symmetric column and Galerkin corrections.
  `coupling/loads-quay-additive.test.js` checks identical operators at both aperture grid
  spacings and at a high-frequency masked control above the selection size. At 0.075 m,
  total fine and coarse face visits fall from 104.36 million to 66.01 million for the Robin
  projection and from 111.74 million to 72.05 million for the submerged impulse.
  The method removes an eight-byte scratch word per volume slot, or 1.08 GiB at the full
  145-million-slot grid. Iterations can rise as each iteration becomes cheaper.
  Projection tolerance and the accepted aperture geometry stay the same. The archived 0.15 m
  passage uses 50,599 fine matrix products instead of 95,241 across 210 ticks. At 0.075 m the
  final 30 ticks use 8,906 instead of 18,786 from the same tick-180 checkpoint. The largest
  gauge difference is 4.57×10⁻¹³ m. Both replays remain exact. On the original 145-million-slot
  grid, setup held 15.62 GB of typed arrays. The twelve-minute preflight logged 32 fine matrix
  products before stopping during the first projection. This direct volume solve still
  cannot supply the full fine trajectory.

  A separate 7.2 × 4.2 m local passage used the same archived hull-source spectrum on 0.15 m
  and 0.075 m cells, with the same 34 depth layers and 210 fourth-order 60 Hz ticks on
  `8a9103610a`. The four area-averaged traces use identical 0.30 × 0.30 m footprints and fixed
  scoring windows. Weighted RMS coarse-to-fine differences are 0.093% at the incident gauge,
  0.888% at the face, 0.975% in the reflected window and 4.400% off the ray. Both grids replay
  exactly. Volume defects stay below 4.62×10⁻¹⁷ m³ and energy defects below 4.43×10⁻¹⁰ J.
  The coarse and fine perimeter sponges take 37.7% and 36.2% of the initial wave energy.
  This verifies the local passage at the fixed crop and leaves full-domain radiation and
  the original-shot acceptance open.

  The independent [outgoing-boundary control](../packages/physics/scripts/measure-finite-quay-outgoing.py)
  solves the same eighth-order normal graph in a 3D waveguide with a finite-ended curtain. It
  returns all empty-channel power, moves 48.26% of the incident aperture power into other
  propagating orders, and closes total power within 4.0×10⁻¹⁵. Extending both ports changes
  accepted scattering coefficients by less than 5.0×10⁻¹⁴. Reversing the incident and outgoing
  orders matches the flux-weighted coefficients within 1.8×10⁻¹⁴.

  In a separate normal transect of the archived quay, 49 incident modes reconstruct the frozen
  local source packet without a sponge. Moving the two ports changes the four traces by less than
  7.7×10⁻¹³ relative. Refining 0.15→0.075→0.0375 m reduces the reflected waveform difference
  from 3.76% to 1.70% and the wall-face difference from 1.91% to 0.82%. The transect holds geometry
  uniform along the tangent. The missing finite-end scattering and full time history still
  govern original-shot acceptance.

  The opt-in fourth-order time step in `coupling/loads-finite-quay.test.js` checks held pressure, the single
  volume kick, the finite-domain absorber and failure before publication. The free-hull regression transfers
  1,144.557 J with a maximum closure error of 0.000308 J and exact replay. The original 22.63 m wave ray in
  the [mode probe](../packages/physics/scripts/measure-finite-quay-dispersion.mjs) isolates temporal lag.
  With 0.15 m horizontal cells and 29 layers, the wider horizontal stencil and the fourth-order time step give
  0.058 rad horizontal, 0.406 rad vertical and 0.0026 rad temporal shift. The 42-layer choice reduces the
  vertical term to 0.190 rad on that ray. These are discrete mode checks. The original wake and its near-wall
  diffraction still require a resolved full-history capture.

  `coupling/loads-wake-waterplane.test.js` checks the baked reference waterplane against exact area and affine
  moments, an independent rectangle wave mode and finite-domain volume with exact replay. On the indexed
  First Wake hull at 67 s and 71 s, the 52,752 surface rows recover the independently integrated short-wave
  modes within 0.084% and 0.054% before receiver projection. The separate submerged advancing rows are
  unchanged. `coupling/seakeeping.test.js` checks the same steady buoyancy, righting and wake state from
  code-built and GLB hulls with both the legacy wake and the baked finite receiver.

  `coupling/loads-quay-point-depth.test.js` checks individual depth source rows against the volume pairing
  of a uniform-layer normal mode, including a point between the free surface and first layer. A second case
  verifies the closed upper neighbour, signed volume, work and the coded error below the bed. Both memory
  modes replay exactly. This replaces uniform-depth band smearing for compatible finite-domain publishers.

  `coupling/loads-wake-advance-points.test.js` checks the live producer through the same finite receiver.
  The point bake separates signs within a cell and preserves signed longitudinal area and three first
  moments. During the archived shutters its 9,077 point rows preserve the signed volume and moment
  sums to 4.8×10⁻¹² in the scene's SI units. An independent mesh integral gives at most 4.7935% complex
  error across six original modes before receiver projection. Including independent discretized depth
  and horizontal transfer gives 4.8992% at 0.025 m and 6.4490% at 0.075 m. The code-built and GLB hull
  test also uses the point publisher. These are source checks. The full quay replay still needs a
  spatially converged propagation solve.

  The [local oblique-packet comparison](../packages/physics/scripts/measure-finite-quay-local-packet.mjs)
  launches a 1.29 m carrier 1.84 m from the surveyed 5.72 m aperture. At 0.15 m resolution with both
  fourth-order options, the 9 m crop's surface trace differs by up to 13 nm between an open and sealed
  deep path. Energy closes to 3.2×10⁻¹² J and the solve replays exactly. Holding the geometry fixed and
  widening the crop to 12 m changes the face and reflected traces by 0.065% and 0.480% RMS.
  The reflected trace differs from the summed-image reference by 17.34% RMS and the off-ray trace
  differs by 78%. That reference includes the initial image tail. A separate even continuation of
  the actual incident-only launch gives 11.64% RMS for the reflected return and 24.95% for the off-ray
  trace. These checks cover the local four-second crossing. The full trajectory and its wake remain unresolved.

  The newer 4 m point-source run exposed a small accumulated free-surface volume defect when the net
  volume crossed zero. The iterative residual retained a constant potential mode. The mean correction
  in `coupling/loads-quay-mean-mode.test.js` balances the Robin volume independently in two sealed
  basins, with and without signed sources. The regression fails on the old projection. On the exact
  archived mask with a frozen diagnostic potential, the previous projection misses the volume sum by
  8.67×10⁻⁹ m³. The corrected projection misses by at most 4.70×10⁻¹³ m³ in the two controls.
  `coupling/loads-quay-wet-traversal.test.js` records exact dense versus indexed output and replay for
  the same masked aperture. Its projection visits 581,952 active entries versus 1,496,448 dense entries.

  The full point-source diagnostic completed the prescribed original trajectory from frame zero on the
  4 m grid using the pre-correction solver. It saved both shutter pairs at vessel ticks 3765–3766 and
  4005–4006, replaying tick 4006 bit for bit from tick 4005. The finite receiver accepted 204,994,272
  nonzero surface rows and 35,463,839 nonzero point rows with zero source rejections. The largest direct
  volume residual was 1.66×10⁻¹⁰ m³, and relative work residual stayed below 3.48×10⁻¹¹. The independent
  volume observer still failed at ticks 2965–2969, with a peak absolute defect of 5.33×10⁻⁸ m³ on this
  older build.

  The strict corrected baseline on `6119b80d6d` ran the same 4 m grid and prescribed trajectory from
  frame zero through tick 4006. All 240,458,111 nonzero source rows were accepted. The direct source
  volume residual stayed below 3.42×10⁻¹³ m³, and free-surface-plus-sponge volume closed within
  1.35×10⁻¹² m³, including all five previously failing ticks. The relative work residual was below
  3.47×10⁻¹¹. Both original shutter pairs were captured, all saved frame hashes verified and the
  4005→4006 snapshot replay matched exactly. The two shutter height pairs differ from the pre-fix
  run by at most 5.23×10⁻¹³ m. The 4 m grid establishes the mass, work and replay baseline.
  At the original 67.005208/67.015625 s and 71.005208/71.015625 s exposures, both renderers read
  the corrected 4 m state with the original cameras and assets. GPU surface displacement agrees
  with the saved solver values within 1.55×10⁻⁶ m. Against a matched readback of the pre-fix
  point-source state, three of the four renders are pixel-identical. The last differs in four
  pixels by one 8-bit code. Over the two windows at 370 wall sites, the largest sampled heights
  are 0.19635 m and 0.23479 m. The lowest crest clearances are 1.78586 m and 1.74736 m, and
  neither renderer emits spray. These are results for the corrected 4 m point-source baseline.
  Fine spatial convergence and the original-shot acceptance remain open.

  The 4 m full-history diagnostic used the same archived shutters and quay structure as the 8 m run,
  and both renderers sampled the accepted wave heights within 1.54×10⁻⁶ m. Wall peaks rose to 0.332 m
  and 0.311 m at the 67 and 71 s shutters from 0.200 m and 0.149 m at 8 m. Both stayed below the wall crest
  and produced no spray. The changes across grids show the shot's wall response has yet to converge.

  The finite receiver was compared with the 26 measured Briggs M4 lee-side wave gauges using an incident
  packet at the published period and height and an identical open-water normalization. At the fixed 14 s
  sample, RMS errors in relative wave height for 30°, 60° and 90° are 0.039, 0.030 and 0.056 at 0.50 m.
  The 0.25 m grid gives 0.015, 0.027 and 0.067. The gain is on the 30° transect. The full 26-point error
  stays about 0.043. With the optional fourth-order horizontal stencil the two total errors at the same
  sample are 0.0379 and 0.0447. The 90° values dominate the remaining error. Table 5 of the paper reports
  0.052 for its regular-wave prediction, also with the largest discrepancy along 90°. The original paddle
  history is unavailable. The packet window affects the results, and refinement does not yet converge
  against the full 26-gauge record.
  [Briggs, Thompson and Vincent, 1995](https://doi.org/10.1061/%28ASCE%290733-950X%281995%29121%3A1%2823%29)
  [Opt-in coarse and fine comparison](../packages/physics/scripts/measure-finite-quay-briggs.mjs)

  Frame-zero seek, origin rebasing and rigid mobility now pass their framework regressions. On both renderers the
  Flood case restores and exactly replays accepted horizontal momentum while buoyancy is still active. The original
  editable Cyprus raft shot remains unavailable. The original review video identifies only the title and encoder.
  The standalone [Cyprus raft demo](../examples/cyprus-raft.html) uses a Blender-built period interpretation,
  based on George Clark’s 1874 Great Lakes patent. The loaded asset floats on the same spectral and passing wake
  state that Water draws. The sealed chambers and timber displacement mesh are separate from the visible grate.
  The [asset source](../examples/assets/source/sea12/README.md) records the construction and modeled mass.

**Paused on Scott’s direction.** The corrected 4 m First Wake replay covers all 4,006 ticks. On the
unchanged fine domain the full-volume preflight reached its twelve-minute limit during the first
projection. The finite-curtain outgoing-wave check landed in `c38c7d9589`. The full fine replay and
independent KCS stern-flow acceptance remain open.

**Commit and test receipts on public main**

| Audit item | Commit and test |
| --- | --- |
| 1. Hydrostatic righting | `4195a70985`, `loads.test.js` checks finite-angle box and mesh righting, the small-heel GM limit and the independently photographed free float. `7ea413ac19`, `loads.test.js` checks the transformed mass centre and the correct first-frame buoyancy torque after a mass override or collider edit. `6360d0000d`, Water test `buoyancy-example.browser.mjs` checks the optional debug arrows, the analytic sphere force, righting torque and exact seek on both renderers. |
| 2. Exact displacement | `4195a70985`, `loads.test.js` checks clipped box and closed hull displacement and the transformed ellipsoid cap centroid. `6b1828acaa`, `loads-capsule.test.js` checks the closed-form capsule sections and centroid, and `loads.test.js` checks the live pitched rigid body. `water/test/buoyancy-example.browser.mjs` draws and replays the sphere and righting box on both renderers. |
| 3. Rod segments | `7bcfb11e3`, `loads-segments.test.js` checks buoyancy, drag and finite wet intervals. SOFT-02 owns the rod integration. |
| 4. Incident pressure | `983be44429`, `loads.test.js` checks live incident pressure on submerged and partly wet meshes and the single acceleration contribution. |
| 5. Radiation and rotational inertia | `113a391fde`, `loads.test.js` checks Lamb inertia and Cummins memory. `16800c8b12`, `loads-radiation-coupled-profile.test.js` and `loads-coupled-radiation.test.js` check full cross-axis coefficients, forces, modal work and replay.  `2f0aaf8bb7`. This upgrade checks constraint reactions and held wrenches on TypeScript and both Wasm variants in `loads-coupled-radiation.test.js`. |
| 6. Debris and anchors | `113a391fde`, `coupling/loads-debris.test.js` checks held-out Haehnel–Daly impacts and reciprocal impulses. `coupling/loads-mooring.test.js` checks the taut oscillator, slack and dynamic anchorage. |
| 7. Independent measurements | `983be44429`, `loads.test.js` checks the withheld Sarpkaya β = 4480 diameter series. `4195a70985` checks independent Hori float heel. `113a391fde` checks held-out Haehnel–Daly force. `16800c8b12` checks Vugts sway–roll in its width-confined geometry. The historic Keulegan–Carpenter cases remain outside the Sarpkaya envelope. `c726258102`, `sea-wake.test.js` checks the conservative subcell transfer. The independent KCS waveform remains outside measurement uncertainty. |
| 8. Reciprocal neighbours | `c8af3a4312`, `coupling/loads-hull-projected-drag.test.js`, `coupling/loads-reciprocal.test.js`, `coupling/loads-swim-actuators.test.js`, `coupling/loads-paddle.test.js` and `coupling/loads-wading.test.js` check return impulse. `16800c8b12`, `coupling/moving-cylinder-blockage.test.js` checks accepted pressure, closing cells and seam replay. `1a6c425709`, `water/test/loads-quay.browser.mjs` checks the quay component. `51254088d7`, `projected-drag-settlement.test.js` checks accepted wet/dry impulses and `shallow-surface.browser.mjs` draws the single physical state on both renderers. `d973c1ce1e`, `coupling/projected-drag-settlement.test.js` checks 50 periodic seam crossings, conserved mass and momentum and replay. `5da4190576`, `water/test/flood-rigid-drag.browser.mjs` checks the standalone Flood's accepted drag and paired replay on both renderers. `7ea413ac19`, `coupling/loads-wake-float.test.js` checks live SEA-04 wake-to-float buoyancy against a finite-depth mode and the analytic sphere cap across 42 ticks, with bit-exact replay. `124baff110`, `coupling/loads-paddle.test.js` and `coupling/loads-wading.test.js` check settled wet and drying impulses, a shared cell and replay.  `2f0aaf8bb7`. This upgrade checks the accepted flood impulse at a locked body in `coupling/projected-drag-settlement.test.js`. `8915608827`, `water/test/buoyancy-example.browser.mjs` checks live raft motion, the rendered scene and exact frame-zero replay on both backends. `fbee5a3b75`, `coupling/loads-quay-wake.test.js` checks reflection, no through-wall flow and live hull replay. `3ec33d0cbc`, Water’s `loads-quay.browser.mjs` checks the reflected surface, land-side clipping and overtopping spray on both renderers. `1562435c66`, `coupling/loads-prescribed-wake.test.js` checks powered hull work in open water and the wet half of a quay. `2a71563477`, `coupling/loads-surge-wake.test.js` checks reciprocal free surge, initial wave motion and exact replay. `44ebaa7c02`, `coupling/loads-prescribed-wake.test.js` checks the joint energy from simultaneous depth-band and surface-volume sources. `1e6935bbdd`, `coupling/loads-free-hull-wake.test.js` checks simultaneous free heave, roll, pitch and surge work with replay. `28cd511079`, `coupling/seakeeping.test.js` checks the swept source volume and lateral first moment after hull triangle reindexing. |
| 9. Drag and wind geometry | `1a6c425709`, `loads-compact-drag.test.js` and `loads.test.js` check projected area and centroid, drag against held-out cube measurements, and separate spin damping. `c8af3a4312`, `loads.test.js` checks dissipative stiff drag. `51254088d7`, `loads-member-viv.test.js` checks rigid wake frequency against independent force data and the wet lift moment. `6b1828acaa`, `loads-capsule.test.js` checks capsule projections and clipped windage centroids. |
| 10. Coded errors | `4195a70985`, `loads.test.js` checks actionable mesh and shape errors. `c8af3a4312`, `coupling/moving-cylinder-blockage.test.js` checks the public factory repair. `16800c8b12`, `loads-coupled-radiation.test.js` checks incompatible profile inputs. `fbee5a3b75`, `loads-quay-wake.test.js` rejects invalid image sources before either field changes. `38af9a2c59`, `water/test/wake.test.js` checks coded renderer and spray input errors. |
| 11. Native work and origin cells | `1a6c425709`, `loads.test.js` checks independent static origin cells, one SIMD batch and replay. `16800c8b12`, `loads-kernel.test.js` and `loads-coupled-radiation.test.js` check both layouts and memory variants. `13b6c14dd0`, `world.test.js` and `coupling/loads-swim-actuators.test.js` verify both retained mirrors, atomic rebasing and production water–body replay. |


**2026-11-27 floating and the step's energy (Claude laptop, P12 on Scott's order).** `floating(physics, bodies)` builds the
LoadSolver bodies from a body's own colliders (hull faces, closed meshes, cylinder and cone prisms of the circle's area,
compound parts, turned colliders through the new `LoadBody.rotation`); `bodyLoad` and `debugRender` report and draw the
displaced volume, centre of buoyancy, waterline and loads (`loads-floating.test.js`). A real defect found on the way:
the buoyancy was taken where the step starts, so an undamped floating box gained 20 % of its heave amplitude a cycle at
60 steps a second and 1.8 % at 240 (KB-LOADS-HEAVEGAIN1). It is now taken at the rigid step's energy-neutral pose,
(s - 1) / (2 s) of the step on, as the hull solver's loads are; the amplitude holds to the sampling bound over 20 s
(the regression test). `coupling/loads-wake-float.test.js` and `loads-radiation-profile.test.js` take their analytic
references at that pose. Still open from the list above: radiation damping by default for compact bodies, and decay
against published floating model tests.

### SEA-03 Nonlinear and rogue waves (`@margoengine/physics/rogue`, commits 47be5f699, 116edc307), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/rogue/index.ts` (1068 lines) and `groups.ts` (278 lines), plus the row in `docs/physics-solvers.md`, `docs/limits.md`, and the audit rows. Commits since the audit (2026-11-25) are only 47be5f699 and 116edc307 (three sisters); nothing touches a dynamic or high-order spectral tier. Tests run under run-with-timeout: `packages/physics/tests/rogue.test.js` 9 pass / 0 fail; `packages/physics/tests/sisters.test.js` 3 pass / 0 fail. There is no `tests/coupling` file for it, and no GPU or browser test.

**Validation.**
- Stokes second harmonic (deep, 20 m, 8 m): exact solution, bound 1e-7.
- Longuet-Higgins sum and difference terms: exact, 1e-12.
- Longuet-Higgins and Stewart bound long wave: exact, 0.05 to 0.1 percent.
- Rayleigh limits and expected largest wave of 1000 waves: exact, 0.4 percent.
- Skewness: checked against the kernels' own sum, so it is self-consistent, not independent.
- Draupner crest: placed by the code and then read back, so it is self-consistent and proves only placement.
- Kimura's table 2 (sisters.test.js:29): a published table, 2 percent. The three-in-a-row rates are checked against the code's own computed rates.
- No published measurement is used. Missing: the Onorato et al. 2004/2009 tank kurtosis against BFI, Forristall 2000 crest and height laws, Mori, Onorato and Janssen 2011, Christou and Ewans 2014 field rogue rates, and the Chabchoub 2012 Peregrine tank case. Nothing is checked on breaking or on regimes the model was not built for.

**Fails points** 1, 2, 3, 4, 5, 6, 7 (partial), 8 (partial).

**Audit list.**
1. High-order spectral tier (Dommermuth and Yue 1987; West et al. 1987; Ducrozet 2016), with the second-order model as the fast tier — NOT DONE. `docs/physics-solvers.md:104` and `docs/limits.md:1705` both say it is not built. There is no tier switch behind one API.
2. Dynamic focusing, so a placed rogue group builds and breaks over a hull in time (the film item) — NOT DONE. A rogue is a constrained NewWave inside a fixed window of 8 zero-crossing periods (`index.ts:292-294`). It is a prescribed shape, not Benjamin-Feir or Dysthe/NLS evolution.
3. Fenton 1985 fifth-order waves, steep Stokes beyond second order — NOT DONE.
4. Breaking — NOT DONE. A crest steeper than Barthelemy's onset is kept (`limits.md`). The Bx = 0.855 onset and dissipation are not built.
5. Validation against Onorato, Forristall, Mori and Christou-Ewans — NOT DONE (see Validation).
6. Rogue rate "one wave per zero-crossing wavelength squared per period" uncited (`index.ts:587-590`) — NOT DONE. Fedele's space-time extremes are listed as not used.
7. The 8 Tz event window is a free choice (`index.ts:292-294`) — NOT DONE. It is documented as a choice, not derived.
8. O(N²) pair cost per point — NOT DONE. About 50 microseconds at 160 components in plain TypeScript, with no Wasm or SIMD and no threads.
9. Finite-depth statistics (the depth factors of Janssen 2018) — NOT DONE. Deep-water statistics are used in shallow water, which is documented.
10. A coupling test and a `Solver` form instead of a bare query — PARTIAL. It implements `SeaSurface`, and `rogue.test.js:207` checks slope, orbital motion and pressure against the surface. No test floats a hull or body on a rogue, and no conserved quantity is accounted.
11. Coded errors naming the fix (floor, point 5) — PARTIAL. The messages name the fix (`rogue.test.js:241`), but they throw plain `RangeError` and `TypeError` (`index.ts:172-190`, 567, 579, 762, 809). `MargoError` appears nowhere in the folder.
12. Three sisters and placed groups (added since the audit) — DONE for statistics and placement. Code is in `groups.ts`; tests are `sisters.test.js:29`, `:50`, `:66`. It does not close any audit item above.

**To do before it can be VERIFIED:**
1. Build the HOS solver (West et al. 1987 with Dommermuth-Yue dealiasing, adaptive RK, finite depth) so a placed group focuses and breaks in time. Keep the second-order sea as the fast tier behind one API. Add Dysthe or NLS as the mid tier if wanted.
2. Validate against measurements: Chabchoub 2012 Peregrine tank (amplification about 3), the Onorato kurtosis against BFI, Forristall 2000, Christou and Ewans 2014, and Benjamin-Feir growth rates (instability below 2.83 ε k0). Use bounds derived from the measurement scatter.
3. Add breaking onset and dissipation (Barthelemy 2018; Derakhti 2020) and Fenton 1985 fifth-order waves.
4. Cite or replace the rogue rate and derive the event window. Add finite-depth statistics (Janssen 2018).
5. Throw `MargoError` with codes, add a hull-on-rogue coupling test with conserved quantities, add Wasm SIMD or threaded pair sums, record work counts, and add film seed or placement tests on the dynamic tier.

#### SEA-03 four-point pass

- Point 5 and audit item 11 (0f282397e6). `packages/physics/tests/rogue.test.js` rejects nonfinite queries, dry spectra, misaligned currents and malformed grids with fix-linked codes, preserves caller samples exactly after a rejected flow, differentiates the full placed-wave envelope in both axes and checks that pressure stops below the bed.
- Point 6 and audit item 8 (0f282397e6). `packages/physics/tests/coupling/rogue-pair-workers.test.js` exercises one, two and four participants on ordinary and finite-depth placed spectra at signed coordinates, with an exact scalar comparison and rewind. `packages/physics/tests/rogue-pair-workers.browser.mjs` starts and releases three actual Chromium helpers. The two-tile case evaluates 263,175 pairs, 263,174 in f64x2 lanes.
- Point 7 and audit item 10 coupling evidence (0f282397e6). `packages/water/test/rogue-film.browser.mjs` draws the same prescribed crest that drives the live launch. The crest is 1.350 m versus 0.06239 m in the plain sea, with 19.73° versus 0.045° of roll. Both renderers check exact accepted bytes and direct resolved images through hold, restore, re-advance and rewind. The proof covers prescribed placement and one-way surface-to-hull loading.
- Point 8 and audit item 5 measured comparison (0f282397e6). `packages/physics/scripts/sea03-flume-crests-measured.mjs` uses the separately specified Dematteis et al. wavemaker inputs. At 96 components and 40 Hz the second-order model gives 19, 1 and 3 extreme maxima against the independently observed 78, 99 and 88 for the three regimes. The most favorable tested threshold rounding gives 24, 7 and 6. [Limits](limits.md#placed-second-order-waves-and-flume-crest-counts-sea-03)

High-order phase evolution, breaking, wider measured accuracy, full two-way coupling and the original production shot remain open. The row stays REOPENED at four points.

### SEA-01 Wave spectrum and wave-field evolution (`@margoengine/physics/waves`, commits 62fa8c303, 526cc95c9, bb9be393e, 8035cee71), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/waves/spectral.ts` (928 lines), `st4.ts` (372), `packages/physics/tests/waves.test.js`, the SEA-01 rows in `docs/physics-solvers.md`, `docs/physics-solver-audit.md` (lines 60, 188, 344) and `docs/known-bugs.md` (KB-PHYS-AUDIT2). No commit touches the waves source or tests since the audit (2026-11-25 onward, only the four above, all before it). Ran `node scripts/run-with-timeout.mjs --max=15 -- node --test packages/physics/tests/waves.test.js`: 11 tests, 11 pass, 0 fail (about 65 s). Not run: no GPU or browser test exists for waves, and `foam.test.js` (coupling) was not re-run.

**Validation.**
- Kahma and Calkoen gale (20 m/s): published measurement; e* within -15%/+25% of 2.1e-3 chi*^0.79 at three fetches, slope 0.7 to 0.9. The bound is arbitrary (set around the measured 1.07 to 1.17). 20 m/s is also a case the ST4 sheltering was calibrated on (`st4.ts:44-49`), so it is not held out.
- JONSWAP fetch laws at 10 m/s: published fit; Hs within 25%, Tp within 15%. Arbitrary bounds, and 10 m/s is a calibration case too.
- Alves, Banner and Young 2003 fully developed sea: published measurement; the test band is wider than the data's.
- Dispersion and group velocity: exact solution, 1e-12.
- Swell test: self-consistent only (arrival at the group velocity, "late > 1.6 m" from 2 m, a 10% period band). It is not compared with any measured swell decay.
- The held-out 30 m/s gale is in `docs/limits.md` only, not in a test. No Young and Verhagen finite-depth growth test. No swell-decay test against Ardhuin et al. 2009.

**Fails points** 2, 3, 4, 5, 6, 7 (and 1 in part: no exact nonlinear transfer or ST6 tier).

**Audit list.**
1. Film item: swell propagation and dissipation against Ardhuin et al. 2009 SAR swell decay — NOT DONE (the swell test is a crude arrival window).
2. Film item: the held-out 30 m/s Kahma-Calkoen gale as a test — NOT DONE (`waves.test.js:100-132` is 20 m/s).
3. Calibration case used as validation (KB-PHYS-AUDIT2) — NOT DONE, still open.
4. Arbitrary bounds — NOT DONE (25%, 15% and -15/+25% are not derived from the data scatter).
5. Currents and Doppler shift — NOT DONE (`spectral.ts:9`, `:34`).
6. Diffraction, reflection, triads, garden-sprinkler correction — NOT DONE (`spectral.ts:34`).
7. Wave roughness back to ATMO-01 — PARTIAL (friction velocity comes from the waves with ST4, `waves.test.js:134`; no test of the wind profile responding).
8. Return from SEA-04/05 at the nearshore boundary — NOT DONE.
9. Young and Verhagen 1996 finite-depth growth — NOT DONE (a depth-breaking test only, `waves.test.js:216`).
10. Duration-limited growth and refraction tests — NOT DONE.
11. ST6 / exact nonlinear transfer tier — NOT DONE.
12. Speed, about 4.7 s per step on 32 x 32 — NOT DONE (no Rust/Wasm or threads; tests take about 65 s).
13. Coded errors — NOT DONE (plain `RangeError`, `spectral.ts:342-366`, not MargoError with a help link).
14. Fetch law on a grid that resolves the coast — DONE (`waves.test.js:100`, "a gale of 20 m/s grows the sea...").
15. Fully developed sea in U10 — DONE (`waves.test.js:160`).

**To do before it can be VERIFIED:**
1. Add a held-out 30 m/s Kahma-Calkoen test and a swell decay test against Ardhuin et al. 2009; derive every bound from the published scatter.
2. Move the calibration to separate data from the validation cases and close the open KB-PHYS-AUDIT2 item.
3. Add currents (Doppler shift), diffraction/reflection, triads and the garden-sprinkler correction (SWAN and WAVEWATCH III manuals), or a documented tier that does the same.
4. Test duration-limited growth, refraction (Snell, Longuet-Higgins) and finite depth against Young and Verhagen 1996.
5. Send roughness to the wind (ATMO-01) and take the nearshore return from SEA-04/05, each with a coupling test and a conserved-energy check.
6. Throw MargoError with help links in place of RangeError.
7. Build the hot loops in Rust/Wasm SIMD with work counts, and add an ST6 or exact-transfer fidelity tier.
8. Add film controls (placed events, targets) and a limits entry that matches the code.

#### SEA-01 four-point pass

- Point 5 and audit item 13 (5429226e54). `packages/physics/tests/coupling/waves.test.js` rejects a late nonfinite wind sample after an earlier candidate interval. Accepted f64 spectrum, clock and friction bytes stay unchanged and a corrected retry equals the continuous result. Wind input is converted between signed cells and the spectrum cell follows snapshot restore. `packages/physics/tests/waves.test.js` checks coded errors and preserves a caller's JONSWAP output on rejected normalization.
- Point 6 and audit item 12 (5429226e54). `packages/physics/tests/coupling/wave-transport-workers.test.js` compares the same ULTIMATE QUICKEST axes with scalar and one, two and four native participants through open, land and periodic boundaries, signed rewind and failed-flux recovery. `packages/physics/tests/wave-transport-workers.browser.mjs` uses three actual Chromium helpers with the caller. The 19-by-11 case evaluates 82,971 active fluxes, 81,654 in SIMD lanes, and 76,356 wet updates, 75,144 in SIMD lanes.
- Point 7 and audit item 10 duration evidence (5429226e54). `packages/water/test/swell-film.browser.mjs` draws the live propagated spectrum and floating buoy. Across an 80 m span, arrival lags 36 s, and downstream significant height climbs from 0.234 to 0.319 m after wind cutoff. Both renderers reproduce complete frame bytes and the accepted physics through hold, direct restore, re-advance and rewind. Original RITS-1, OO-2 and BS-6 remain open.
- Point 8 and audit items 3 and 9 comparison (5429226e54). `packages/physics/scripts/sea01-lake-george-measured.mjs` uses independent downstream measurements and separately specified calm or upstream forcing. Six of 16 height comparisons intersect the published intervals with numerical and readout sensitivity. The far-gauge heights remain 0.073 and 0.112–0.113 m too high. The stronger-wind peak is 0.277 Hz against 0.326 Hz measured. Runs against the same Kahma–Calkoen calibration curve are consistency checks. [Limits](limits.md#accepted-wave-transport-and-independent-lake-george-gauges-sea-01)

Changes in source-term fidelity, measured swell-decay coverage, current and coast feedback, field accuracy and full production routing remain open. The row stays REOPENED at four points.

### SEA-05 Nearshore waves and surf zone (`@margoengine/physics/surf`, commits 8c7453cd8, 046ee7e0d), owner Codex: REOPENED

**Checked.** docs/physics-solvers.md row, docs/physics-solver-audit.md (Film-set table, THIN row, research notes), docs/physics-demo-review.md (CF-3, BB-2, CY-10, CY-14, Below the Swell), docs/limits.md surf entry, packages/physics/src/surf/index.ts (1,086 lines), packages/physics/tests/surf.test.js, tests/coupling/surf.test.js. No commit touches the surf code since the audit (the only two surf commits, 8c7453cd8 and 046ee7e0d, are dated 2026-11-26). Ran under run-with-timeout: `node --test packages/physics/tests/surf.test.js packages/physics/tests/coupling/surf.test.js`: 14 tests, 14 pass, 0 fail (233 s). No GPU or browser test exists for this row (no `test:browser` script).

**Validation.**
- Shoaling (energy flux): exact solution, 2 percent. Snell refraction: exact, 1 degree. Set-down: Longuet-Higgins and Stewart (1964) analytic, 4 percent. Set-up slope: Bowen analytic, 0 to 15 percent. Undertow: the model's own formula -(E_w+2E_r)/(rho h c), 1 percent, self-consistent. Longshore: balance of the model's own friction law, 10 percent, self-consistent. Wave action against a current: exact conservation. Bound wave: Longuet-Higgins and Stewart slope, 10 percent (R^2 0.86), analytic.
- Run-up R2% within 25 percent of Stockdon et al. (2006) on 1:50 and 1:25 (surf.test.js:321-345). This is a published field fit, but the model's short-wave swash is taken from Stockdon's own S_inc (index.ts:940-962), so it is partly circular. The 25 percent bound is a tolerance, not derived. Only one sea (0.5 m, 8 s) is tested.
- No test against a lab or field measurement (Boers 1996, Haller 2002, Visser 1991, Longuet-Higgins 1970, DUCK94). No held-out case.
- Shore set-up is about twice Stockdon's fit (0.114 against 0.050 m); this is stated in limits.md and unfixed.

**Fails points** 1, 2, 3, 4, 5, 6, 7 (8 largely met: limits.md:1700 is detailed and honest).

**Audit list.**
1. Phase-resolved (non-hydrostatic) tier published as orbital velocity for plants, sand and fish (film BB-2) — NOT DONE. No non-hydrostatic solver; no orbital-velocity field export found in surf/index.ts (only a surface elevation, `boundWave`).
2. Validate against Boers 1996, Haller 2002, Visser 1991, Longuet-Higgins 1970, DUCK94 — NOT DONE.
3. Run-up not built from Stockdon's own terms (index.ts:956,973 flagged) — NOT DONE. S_inc is still Stockdon's (index.ts:940); limits.md says "rather than resolved".
4. Adaptive breaker gamma — NOT DONE (fixed gamma, limits.md).
5. HYDRO-03 morphology coupling — NOT DONE (no sediment test in surf tests).
6. Overtopping — NOT DONE (the catalog assigns it to the shallow water; no surf test).
7. Both-ways HYDRO-01 test — PARTIAL. surf.test.js uses a staggered surf-water couple (run-up test, rip test), and the current-refraction test exists, but the coupling file holds only frame-rate and seek tests (coupling/surf.test.js:30-31), with no conservation accounting.
8. Return to SEA-01 — NOT DONE (waves feed in via spectrum; no returned reflection or dissipation test).
9. Shore set-up about twice Stockdon's — NOT DONE (stated, not fixed).
10. Hard cap Hrms <= 2h (index.ts:719-723) — NOT DONE; the cap remains.
11. Rival capabilities (SWASH, XBeach-NH, FUNWAVE) — NOT DONE.
12. Catalog extras: swash, wet-sand line, run-up marks — PARTIAL. Run-up and a wet-sand record are tested (surf.test.js:189), but no swash-mark output for the renderer was found.
13. Coded errors — NOT DONE. Out-of-range input throws plain RangeError/TypeError (index.ts:202-365), not MargoError with a help link (surf.test.js:356 matches message text only).
14. Scale — NOT DONE: TypeScript only, about 5 ms a step for 1,200 cells (limits.md); no Rust/Wasm kernel.

**To do before it can be VERIFIED:**
1. Validate against measured data not used for tuning: Boers (1996) barred-beach flume, Haller et al. (2002) rip channels, Visser (1991) longshore current, Longuet-Higgins (1970); give derived bounds.
2. Replace the S_inc-from-Stockdon swash with resolved run-up (a non-hydrostatic tier after Zijlema, Stelling and Smit 2011), and publish the orbital-velocity field for plants, sand and fish (BB-2).
3. Fix the 2x set-up overshoot and remove the Hrms <= 2h cap; add an adaptive gamma (Ruessink et al. 2003).
4. Add couplings with conservation tests: HYDRO-03 sediment, SEA-01 return, overtopping.
5. Throw MargoError with codes and help links.
6. Add a Rust/Wasm hot loop and recorded work counts; directional bound waves (Herbers et al. 1994).
7. Add a swash-mark output for the renderer, plus a directed-event test (seeded sets, placed rips).

#### SEA-05 four-point pass

- Point 5 and audit item 13 (d01b0c6751). `packages/physics/tests/coupling/surf.test.js` checks fix-linked errors, signed incident-wave coordinates and preservation of the previous energy, roller, port and shore-history bytes after a rejected shallow-water sample. The height query reproduces its accepted value immediately on restore and the coupled world replays exactly.
- Point 6 and audit item 14 (d01b0c6751). `packages/physics/tests/coupling/surf-force-workers.test.js` compares both radiation-stress phases with scalar results at 1, 2 and 4 participants, for an odd periodic 2D beach and a one-row shore. Both phases reject finite-input overflow before publication. `packages/physics/tests/surf-force-workers.browser.mjs` exercises three real Chromium helpers and records 186 moment cells, 4,278 ordered directional contributions and 195 divergence cells. 178 moment and 186 divergence evaluations use SIMD lanes.
- Point 7 and audit item 12 (d01b0c6751). `packages/water/test/swash-film.browser.mjs` draws the live shallow-water surface and accepted wet history. The grouped shore advances 25.5 to 33.5 m and retreats to 30.5 m with a 0.788 m/s backwash. At the marker, accepted depth drops from 15.56 to 2.11 mm and the dark wet mark remains visible. The groups-disabled control stays dry there. Both renderers repeat complete accepted physics and direct RGBA through hold, restore, re-advance and rewind.
- Point 8 and audit item 2 comparison (d01b0c6751). `packages/physics/scripts/sea05-boers-measured.mjs` uses the published offshore forcing and scores independent wave-height and mean-level measurements at five stations in each of three regimes. At 27 m modeled setup exceeds the measured levels by 5.35, 8.19 and 2.56 mm. The combined readout and numerical allowances are 1.86, 1.85 and 2.30 mm. [Evidence and limits](limits.md#native-surf-forcing-accepted-swash-and-measured-setup-sea-05)

Wider measured accuracy, phase-resolved nearshore flow, breaker and uprush fidelity, return to the offshore spectrum and sediment coupling, individual force queries at a direct checkpoint, and the original production shots remain open. The row stays REOPENED at four points.

### ATMO-04 Precipitation microphysics (`@margoengine/weather/precipitation`, commit acbc53c7e), owner Codex: REOPENED

**Checked.** Commits for the row: acbc53c7e (the only code commit; the others are doc edits). No commit has touched `packages/weather/src/precipitation.ts` or its test since the audit (only ATMO-03's 8833dbf0c edited them earlier). Read `packages/weather/src/precipitation.ts` (689 lines), `packages/weather/tests/precipitation.test.js`, the coupling uses in `packages/physics/tests/coupling/synoptic.test.js` and `packages/physics/tests/runoff.test.js`, and the limits row (`docs/limits.md:1694`). Ran under run-with-timeout: `node --test packages/weather/tests/precipitation.test.js`: 14 tests, 14 pass, 0 fail. No GPU or browser test exists for this entry. No `tests/coupling` folder exists at the repo root; the coupling tests live in `packages/physics/tests/coupling`.

**Validation.**
- "raindrops fall at the speeds Gunn and Kinzer measured": published measurement, not fitted. Drop speeds for 1 to 5.8 mm. Bound: one-sided, model below measured and within 7%. The bound is the observed error of the drag law, so it is fitted to the result, not derived.
- "a fine droplet falls at Stokes's speed": exact solution. The bound is 0.15 Re^0.687, which comes from the drag correction. That one is derived.
- "hail and graupel fall as Heymsfield and Wright's power laws give": published fit, but the model is built from the same fit. Bound ±8% is arbitrary. Self-consistent, not independent.
- "the drops carry exactly the rate asked for": Marshall-Palmer intercept within 15%, arbitrary. The rate check is an identity of the construction.
- Snow speed test only asserts "about a metre a second", which is a loose range. It is not compared with Locatelli and Hobbs (1974) or any aggregate data.
- The shaft, gust, snow-line and hail-share tests are behaviour checks with no outside reference.
- Missing: any disdrometer data, any held-out regime, extreme rain (more than 100 mm/h), and the drop size distribution against measurement.

**Fails points** 1, 2, 3, 4, 5, 6, 8.

**Audit list.**
1. Rain carried by the gusty wind drop by drop, not one median speed — NOT DONE. `precipitation.ts:531-545` still takes one speed, the median drop's, for the whole shaft. Test "rain varies from place to place and gusts bend its streaks" covers gust bending only with that single speed.
2. Rings and splash sources on SEA-04 — NOT DONE. No SEA-04 import or rain output in `packages/physics/src`. The only SEA-04 hit is a mention in the docs.
3. Rain damping of short waves (Tsimplis 1992, Kuo and Hao) — NOT DONE.
4. Snow fall speeds checked against Locatelli and Hobbs 1974 — NOT DONE. The test only asserts about 1 m/s.
5. Below-cloud evaporation — NOT DONE (`precipitation.ts:38`).
6. Melting: rain/snow switch is a smooth function of air temperature, hail and graupel never melt — PARTIAL. The snow share follows temperature (test "the snow line follows the air"), but there is no melting layer.
7. Gamma or normalised size distributions (Testud 2001); two-moment scheme (Seifert and Beheng 2006) — NOT DONE. The size distribution is exponential only.
8. Breakup and aggregation — NOT DONE (`precipitation.ts:38`).
9. K23 particle ballistics — NOT DONE. No batched ballistics path; a sample costs about a millisecond (`docs/limits.md:1694`).
10. Validate against 2DVD disdrometer data — NOT DONE.
11. Coupling tests — PARTIAL. Conserved-water tests with ATMO-03 and runoff (HYDRO-02) exist in `synoptic.test.js` and `runoff.test.js`. Nothing exists for SEA-04, ATMO-06 or K23.
12. Coded errors — NOT DONE. Throws are plain `RangeError` and `TypeError` (`precipitation.ts:77-85,163,433-492`), not MargoError with a help link.

**To do before it can be VERIFIED:**
1. Carry each drop size at its own fall speed, so the shaft sorts by size in gusts (`precipitation.ts:531`), as Veron and Mieussens 2016 describe.
2. Add SEA-04 rain rings, splash sources and wave damping, with a coupling test (Kuo and Hao 2026; Tsimplis 1992; Laxague and Zappa 2020).
3. Validate snow against Locatelli and Hobbs 1974 with a real band, and rain and DSD against disdrometer data on held-out regimes, with bounds derived from the data scatter.
4. Add evaporation below cloud base and a melting layer; let hail melt.
5. Add a gamma or normalised distribution and a two-moment tier (Seifert and Beheng 2006; Testud 2001) behind the same API, with aggregation and breakup.
6. Add a batched particle path (K23) with work counts, in Rust/Wasm SIMD or documented otherwise.
7. Replace RangeError and TypeError with MargoError codes that name the fix.
8. Replace the arbitrary ±8% and ±15% bounds with ones derived from the source data.

#### ATMO-04 four-point pass

- Point 5 and item 12 (724edba73f). `packages/weather/tests/precipitation.test.js` checks coded fix-linked errors, signed wind coordinates, and unchanged supplied output after a late invalid source. Correcting the source produces a fresh field's exact result. The uniform-air test bounds differential size transport against independent characteristic quadrature.
- Point 6 and item 9 (724edba73f). `packages/weather/tests/rain-flight-workers.test.js` passes the existing K23 integrator with size-resolved rain, comparing 1, 2 and 4 participants in 511- and 769-drop signed-origin and contact replays. A failing contact leaves accepted poses and work intact. `packages/weather/tests/rain-flight-workers.browser.mjs` starts three real Chromium helpers and records 2,307 RK4 evaluations and 64,596 f64x2 state updates for 769 drops.
- Point 7 and the trajectory and contact portions of items 1, 2 and 11 (724edba73f). `packages/weather/tests/precipitation-film.browser.mjs` follows a 1 mm drop that moves 3.29 mm farther in a live gust and a 4.8 mm drop that moves 1.22 mm farther. Forty-eight actual crossings deposit 1,303.69 µL and produce visible SEA-04 capillary rings. The cold take draws 44 compact aggregates. Both renderers reproduce complete accepted state and full RGBA independently. The directly affected RITS-5 shaft also passes replay and the size-weighted profile check in `packages/physics/tests/boundary-layer-surface.browser.mjs`.
- Point 8 and the measured comparisons of items 4 and 10 (724edba73f). `packages/weather/scripts/atmo04-measured.mjs` uses PWS100 forcing and independent Paris Parsivel2 observations. Size concentrations overlap 2 of 8 observed bands. Modeled terminal speeds exceed both instruments' medians at all seven populated sizes. All 94 independent Kiruna snow aggregates are slower than the model outside the approximate instrument allowance. The Locatelli and Hobbs comparison has shared model lineage. NASA IFloodS 2DVD access requires Earthdata sign-in. [Evidence and limits](limits.md#atmo-04-size-resolved-precipitation-and-falling-drops)

Measured accuracy, 2DVD validation, observed snow habits, damping and spray, below-cloud evaporation and melting, time-evolving size distributions, breakup and aggregation, atmospheric coupling and the original film shots remain open. The row stays REOPENED at four points.

### LIFE-03 Aquatic locomotion (`@margoengine/physics/life`, commits 708e96a06, c1a005f94, 9c667b698, ae9371354, 56a1deab8, 3161bb917, 20b87aa03, d58422ca9, 03332d94c), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/life/{solver,model,wake,kernel}.ts`, `swim-kernel/src/lib.rs`, `tests/swim.test.js`, `tests/coupling/swim.test.js`, the catalog row, audit rows, known-bugs entry and limits.md section. Commits since the audit (2026-11-25) on the swimmer paths are all SEA-15 sand-pickup work; none touches the tail wake, Strouhal, tail-frequency cap, form drag or fin-lift clamp. Ran under run-with-timeout: `node --test packages/physics/tests/swim.test.js packages/physics/tests/coupling/swim.test.js` gave 25 tests, 25 pass, 0 fail. `packages/environment/tests/swim-sediment.browser.mjs` passed on WebGPU (1994 sand pixels at lift, 17.1 px downstream, 674.8 um bed relief) and with `--compat` (WebGL2, 2023 pixels, same relief); the runner prints no pass count.

**Validation.**
- `Lighthill mean thrust...` (coupling/swim.test.js:49): exact solution, a 128-sample cycle integral of the code's own Lighthill formula, 1e-12. Its Strouhal assertion (:68) is at a chosen speed of 1.5 wavelengths per second, not a reached speed.
- `BB-4 axial speed...` (:74): exact tanh solution of the code's own ODE; checks first-order convergence only.
- `BB-9 ... coast` (:94): exact quadratic-drag solution of the same model.
- `BB-3 Blake drag stroke`, `fin lift curvature` and `BB-8 wake impulse`: closed forms of the model's own equations.
- `BB-7`/`SEA-15` sand tests: van Rijn and Shields relations, self-consistent. Mass is conserved between water and bed.
- No test uses a published measurement. Nothing is checked against Bainbridge 1958 (U about 0.75 L f), Taylor et al. 2003 Strouhal at the reached speed, or Domenici and Blake 1997 fast-start radius. The reached speed is never compared with Strouhal 0.2 to 0.4.

**Fails points** 1, 2, 3, 4, 5, 6, 7 (8 partly).

**Audit list.**
1. Shed the tail wake as vortex and bubble sources into SEA-13 and SEA-15 — NOT DONE. `SWIM_WAKE_FIELD` (`wake.ts`) is read only by the sediment bed (`src/tracers.ts:458,1283`) for pectoral jets. Nothing consumes the tail rows (known-bugs "Open: LIFE-03 swimmer wake" says so). The test at coupling/swim.test.js:187 only checks the emitted impulse.
2. Reached cruise speed against Bainbridge 1958 — NOT DONE (no test).
3. Strouhal 0.2 to 0.4 at the reached cruise (setup gave about 0.49) — NOT DONE. `model.ts:68` and the :68 test use a chosen speed.
4. Divers carried by wave surge — PARTIAL. Test `BS-1 the diver receives actual SEA-02 orbital acceleration` (:161) exists, but one material-acceleration sample is taken at the centroid. There is no SEA-12 loads coupling.
5. Max tail frequency 3 Hz regardless of size (`solver.ts:212`) — NOT DONE.
6. Fin lift servo-clamped with no induced drag (`lib.rs:276-285`) — NOT DONE.
7. Form drag 0.1 x frontal area (`solver.ts:233`) — NOT DONE.
8. Lighthill 1971 large-amplitude theory — NOT DONE; the code uses the small-amplitude 1960 result.
9. Immersed-body high-fidelity tier (Gazzola 2011) — NOT DONE; the spine wave is visual only.
10. Muscle bodies — NOT DONE.
11. SEA-12 two-way coupling test — NOT DONE (no `SwimSolver` test with the loads solver).
12. Seabed sand puff — DONE. Tests `BB-7 the live pectoral wall jet...` and `SEA-15 a native fin jet...` pass, and the browser test passes on both backends.
13. Domenici and Blake 1997 fast-start validation — NOT DONE.

**To do before it can be VERIFIED:**
1. Add a tail-wake consumer: shed vortex rings and bubble sources into SEA-13 and SEA-15, and add a coupling test with conserved momentum. Cite Triantafyllou et al. 2000 and Gazzola 2011.
2. Add a validation test against Bainbridge 1958 reached speed and Taylor et al. 2003 Strouhal 0.2 to 0.4 at the reached speed, with a bound derived from the published scatter. Fix the setup that gives 0.49, or document why.
3. Remove the fixed 3 Hz cap (`solver.ts:212`). Derive the frequency from size and the Bainbridge scaling.
4. Replace the fin-lift clamp (`lib.rs:276-285`) with a lift-curve and induced-drag model (Prandtl lifting line). Replace the 0.1 form-drag factor (`solver.ts:233`) with Hoerner 1965 shape-based drag.
5. Add Lighthill 1971 large-amplitude theory and a validated high-fidelity tier, or an immersed-body tier (Gazzola 2011), behind the same API.
6. Add a SEA-12 two-way coupling test, and a Domenici and Blake 1997 fast-start radius check.
7. Add a SIMD Rust hot loop (`grep` finds no `v128` in `lib.rs`) or record the work counts. Correct limits.md (it does not state the 3 Hz cap or the missing wake consumer).

**Handed back to Codex (2026-11-26), unfinished work on branch `claude/life-03-wip` (fbab02274), not landed:** to-do 3 and
the form-drag half of to-do 4, plus a moving-wall friction model. Take it, finish it, or drop it; nothing of it is on main.
- The default maximum tail frequency is the fast bound of Sanchez-Rodriguez, Raufaste and Argentina 2023 (Nature
  Communications 14, 5569): the root of (L/Lc)^2 = (f0/f)^2 (1 - f/f0)/(1 + kappa f/f0) with f0 = 21 Hz, Lc = 0.5 m,
  kappa = 4 (`maximumTailFrequency(length)`), replacing the fixed 3 Hz.
- The body's form drag is Hoerner's form factor on its skin friction, 1 + 1.5 (d/L)^1.5 + 7 (d/L)^3, d = (width height)^1/2.
  `formDragArea` becomes an extra area, default 0.
- The laminar share of the skin friction is raised by the moving wall of the swimming wave: the body and cycle mean of the
  larger of the Blasius and the moving-wall frictions (Ehrenstein and Eloy 2013, JFM, eqs. 5.3 and 5.4 from 2.11 with
  C_3D = 1.8; about 20% at St 0.3). Computed in the kernel without trig (`moving_wall`).
- The swim tests pass 25/25. Not done: the Bainbridge/Taylor validation test, docs and README.
- Measured with published morphometrics (peak-to-peak 0.2 L, wavelength L, tail span 0.25 L, width 0.1 L, height 0.2 L), at
  0.3 to 0.8 of the maximum frequency for 0.1, 0.3 and 1 m bodies: 0.88 to 0.96 L per beat and St 0.21 to 0.23. That is
  inside Videler's 0.5 to 1.0 and Taylor's 0.2 to 0.4, but faster than Bainbridge's U = L (3f - 4)/4 (0.75 L a beat). The
  likely cause is the small-amplitude reactive thrust (Hess and Videler 1984; Anderson et al. 2001). The next step was
  Lighthill 1971 large-amplitude thrust, whose tail inclination (about 32 degrees here) lowers it.

### LIFE-04 Collective animal motion (`@margoengine/physics/schooling`, `behavior/src/steering.ts`, commits d50e1fb72, 8f568e67d, de25a7f79, 006faf636, ba4efdc15), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/schooling/solver.ts`, `kernel.ts`, `ports.ts`, the docs/limits.md "Collective animal motion" section, the audit and demo-review rows. `git log --since=2026-11-25` for the schooling paths shows only the 25 Nov fix commits that the audit already covered. No change since the audit adds noise, seeds, or any validation. Ran under run-with-timeout: `node --test packages/physics/tests/coupling/schooling.test.js packages/behavior/tests/steering.test.js`: 28 pass, 0 fail. The browser test (`packages/physics/tests/physics-browser.js` has a school run at 24/30/60 fps) was not run; no `test:browser:school` script exists.

**Validation.** Every test is exact or self-consistent, and none uses a published measurement. The "topological ranking" test checks a hand-built four-body tie ordering. The curvature test checks a lateral-acceleration bound (an exact kinematic identity). The coast test checks a closed-form quadratic-drag law. The BB-6 test (`schooling.test.js:188`) only asserts that spread rises and then falls (a trend, no number). The AVIARY-3 test checks the bank ratio a/g. The steering tests check analytic speed and drag laws. Missing: Couzin et al. 2002 order parameters (polarization, angular momentum) across swarm, torus and parallel regimes; Ballerini et al. 2008 anisotropy; Katz et al. 2011 interaction forces; Cavagna et al. 2010 correlations. No test is on a school of hundreds.

**Fails points** 1, 2, 3, 4, 5, 6, 7.

**Audit list.**
1. Topological neighbours (k about 6.5) as the default: PARTIAL. A rank limit exists (`neighbours`, solver.ts:259-262), but the default is all neighbours inside the sensing zone (metric), and `neighbours` is an integer with no anisotropy or k=6.5 default.
2. Noise and seeds: NOT DONE. No random or seed in the solver, kernel or ports.
3. Validation against Couzin 2002 order parameters: NOT DONE.
4. Ballerini 2008 anisotropy, Katz 2011, Cavagna 2010: NOT DONE.
5. Reef schools of hundreds hold, scatter before the shark and re-form (BB-6): PARTIAL. The test uses a small reef fixture and a trend assertion; the film scene is not wired (demo-review says OPEN).
6. Member defaults with a basis (thrust 1 N, lateral 2 m/s², radius 0.2 m, solver.ts:283-286): NOT DONE. They are unchanged.
7. Herds wired to LIFE-01: NOT DONE.
8. Rival capability, GPU boids at 10^5 agents: NOT DONE. The Wasm SIMD kernel uses a grid, but no work counts or scale test at large N.
9. Fish tail-beat and fin banking verified in a shot (BB-4): PARTIAL. LIFE-03 coupling test exists, shot playback is open.
10. Coded errors: PARTIAL. Most validation throws plain `RangeError` (solver.ts:106-263), not `MargoError`.

**To do before it can be VERIFIED:**
1. Add a noise model with seeds (Vicsek et al. 1995) and make topological neighbours (Ballerini 2008, k about 6.5, anisotropic) the default.
2. Validate against Couzin et al. 2002 phase-diagram order parameters, plus Ballerini 2008, Katz 2011 and Cavagna 2010 measurements, with derived bounds.
3. Document the sources of the member defaults, or replace them with species data.
4. Wire herds to LIFE-01 with a coupling test.
5. Add a 10^4 to 10^5 agent scale test and recorded work counts.
6. Convert `RangeError` throws in solver.ts to coded `MargoError`s that name the fix.
7. Wire the film reef scene (hundreds of fish, shark) and check real frames.

### BIO-01 Plant mechanics under wind and water (`@margoengine/physics/vegetation`, `@margoengine/scatter/plant-motion`, commits a4d123a96, f4eef9b63), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/vegetation/model.ts`, `src/vegetation.ts` (grep), `tests/vegetation.test.js`, `tests/coupling/vegetation.test.js`, docs/limits.md "Rooted plant mechanics", the audit row, the design in the work queue and the demo-review reproductions. No commit has touched the vegetation source or tests since the audit (only a comment move in f4eef9b63, before it). Under run-with-timeout: `node --test packages/physics/tests/vegetation.test.js packages/physics/tests/coupling/vegetation.test.js` 9 pass, 0 fail; `packages/scatter/test/plant-motion.test.js` 1 pass, 0 fail; `scatter/test/states.browser.mjs` ran (plant states compose, fire, ground, flood and the rest compiled, 20 WGSL modules, 0 errors; it prints no assertion count, so it checks shader compilation, not plant poses). `--compat` and the flood variants not run.

**Validation.** One test is validated against an exact solution: "resolves both analytic cantilever frequencies" checks the uniform clamped-free Euler-Bernoulli frequencies (beta 1.8751 and 4.6941) to 2e-12 (the quadrature error, derived) and the midpoint-rule phase error. That tests the dry uniform stem and nothing else. The gust-delay, Airy-wave, impact, rupture/uprooting and replay tests are qualitative orderings or exact-replay checks: sign changes, "shallower reed moves farther", an arrival order, and a root moment compared with the code's own formula. No published measurement is used. Missing: Moore and Maguire tree frequencies, Gardiner ForestGALES critical wind speeds, Luhar and Nepf blade reconfiguration or flume data, a tapered, wet or crowned frequency reference.

**Fails points** 1, 2, 3, 4, 5 (partly), 6 (partly), 7, 8 (partly).

**Audit list.**
1. Large-deflection blades and reconfiguration (Luhar and Nepf 2011; the designed Vogel scaling) — NOT DONE. The model is two small-angle modes. limits.md says it has no finite-angle reconfiguration, and `grep` finds no Vogel code.
2. Branch hierarchy (Habel et al. 2009) — NOT DONE (limits.md: no branch topology).
3. Turbulence spectrum (Stam 1997) — NOT DONE; wind is whatever the FlowField supplies.
4. Windthrow computed ForestGALES-style — NOT DONE; `anchorMoment` is a user number (`model.ts:55`), and the test compares it with a hand-built moment.
5. Validate against Moore and Maguire tree frequencies and Gardiner critical wind speeds — NOT DONE.
6. Taper, wet and rupture validation — PARTIAL: wet and rupture have qualitative tests only; taper has none.
7. Self-weight P-delta in air; Cd = 1 default — NOT DONE (default still `model.ts` `dragCoefficient ?? 1`).
8. FIRE-04 and EARTH-02 coupling tests — NOT DONE; the coupling file covers only the rigid and flow ports.
9. Film: seagrass, kelp, anemones and tentacles swaying with orbital surge (BS-1, BB-1, BB-2) — PARTIAL: the Airy-field reed test in `tests/coupling/vegetation.test.js` exists, but there are no fish-body contacts, tentacle chains or real SEA-02 field coupling.
10. Gust-front grass and trampling by hooves (HORSE-6, TREE-1) — PARTIAL: the downwind arrival test exists, but trampling and a travelling-gust grass patch do not.
11. Open bug: time-zero snapshot restore rejects (known-bugs.md, BIO-01) — NOT DONE; only a test workaround.
12. Scale (SIMD Wasm kernel, replay hash, shared memory) — DONE (`vegetation-kernel*.wasm`, tests "same hash on plain and shared world memory" and "replay exactly").
13. Coded errors — PARTIAL: it throws RangeError and TypeError, not MargoError (`model.ts:73-85`).

**To do before it can be VERIFIED:**
1. Add finite-angle reconfiguration (Vogel exponent, Luhar and Nepf 2011) and test it against their flume data.
2. Add branch topology (Habel et al. 2009) and a turbulent wind spectrum.
3. Compute windthrow from a ForestGALES-style critical moment and test it against Gardiner et al. 2000.
4. Validate taper, crown and wet frequencies against Moore and Maguire 2004 and a published kelp or seagrass measurement.
5. Add FIRE-04 and EARTH-02 coupling tests and fish-contact and trampling tests.
6. Throw MargoError with fix text, and fix the time-zero snapshot bug in the field registry.

### FLUID-07 Thin films and droplets (`physics/thin-film`, commits 75f931cd2 through 3cb9cb3eb, 25 commits tagged FLUID-07), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/thin-film/{index,drips,drop-flight,drop-receiver,surface}.ts`, `thin-film-kernel/src/lib.rs` (by commit stat), `tests/thin-film.test.js`, `tests/coupling/thin-film.test.js`, the catalog row, the audit rows, `docs/limits.md` and the FLUID-07 and PA-23 parts of `docs/known-bugs.md`. Under run-with-timeout: `node --test` on the two test files gave 43 tests, 43 pass on packages built from current main, including "a pendant drop matches held-out thinning on tilted glass" (`thin-film.test.js:891`: peak amplitude against the measured 1.01 mm within 0.05 mm, a held-out measurement); a first run on an older build failed it. `thin-film.browser.mjs` ran on WebGPU and with `--compat` (WebGL2) and completed: 4041 and 4069 wet pixels, 72 drop pixels, runnels seen from inside, 0 shader errors. It prints no pass counts.

**Validation.**
- "complete wetting has the measured capillary spreading exponent" (`thin-film.test.js:612`): measured exponent range 0.094 to 0.125 (Cazabat and Cohen Stuart 1986, via Ehrhard 1993). It is not fitted. The mesh-refinement bound is a width/40 comparison.
- "fixed-volume gravity current predicts the measured absolute spreading radius" (`:668`): Huppert 1982 Table 1 run x, within 5% of his empirical radius fit. The 0.9 coefficient comes from his measurements, and the model has no free parameter that was tuned to it.
- "gated incline retains Huppert's cube-root front history" (`:734`): exact similarity solution within 5%, plus a digitized movie increment ratio of 0.78 to 1.06. This is a digitization of Huppert 2006, not a lab table.
- "level cap width predicts the independently measured SLIC retention angle" (`:350`): Vallabhuneni 2023 gives a release tilt of 3 degrees. The test passes both the measured advancing and receding angles and a measured volume.
- "shallow strip retains or slides under a bracket of the Furmidge force" (`:148`): the Furmidge 1962 force balance, bracketed by two chosen angle limits. It is self-consistent and not measured.
- "film depth ... three held-out PLIF bands" (coupling `:199`): Wang, Jia and Duan 2020, pixel-digitized depth bands. Steady flow, the inlet is calibrated, three flows are held out.
- "transient fall matches drop-tower measurements" (coupling `:370`): Hinkle 1987 speeds within 2% plus 5 mm/s. This validates the airborne drop, not the film.
- The Fermigier underside-instability wavelength and the Zhang and Basaran drop volume (2.6% low) appear only in `docs/limits.md`. Only a Mori-based sill model is tested.
- Still missing: a measured contact-line trace, partial-wetting slip, steep contact slopes, measured sliding of a drop on glass, and measured rain-on-glass runoff.

**Fails points** 2, 3, 5, 6, 7 (point 4 is mostly met).

**Audit list.**
1. Contact-angle beading via precursor and disjoining pressure (Schwartz and Eley 1998) replaces the scalar deadband — PARTIAL. Done in `lib.rs` through commit e81431f3a, with the tests at `thin-film.test.js:389`, `:420` and `:504`. It is limited to shallow slopes, and the docs list steep contact lines as open.
2. Advancing and receding hysteresis — DONE. Commit fec3c5104, test `:504`, and the 32 by 32 tilted case at `:547`.
3. Drop detachment: pendant drops detach (Wang, Mucha and Turk 2005 drop particles) — PARTIAL. Timed release from a configured sill is built (`drips.ts`, `drop-flight.ts`, coupling `:223`). There is no pinch-off away from an outlet, and `limits.md` says so.
4. Splash, rebound and satellite drops on impact — NOT DONE (limits.md).
5. Film mass loads its rigid body — DONE. Commit 299205b5c, test coupling `:811`.
6. Drop impact recoil on the mount — DONE (coupling `:894`, `:947`).
7. Rain interception on moving glass (EF-4, LAST-TRAM-8) — DONE for the solver (coupling `:108`, `:122`, `:972`, browser test). The original bridge and chart-room shots remain open.
8. Validation against Huppert 1982, Tanner and Furmidge — DONE for Huppert and Tanner. Furmidge is self-consistent plus one SLIC point.
9. Measured partial-wetting dynamics (sliding drop speed, contact-line trace) — NOT DONE.
10. Two-tier fast and high-fidelity models behind one API — NOT DONE. There is one lubrication model.
11. Extreme-range refusals with a coded MargoError — PARTIAL. Many inputs throw a plain `RangeError` with a `code` (`index.ts:239-295`, `drips.ts:34`), not a MargoError.
12. Scaling — PARTIAL. There is a Rust/Wasm kernel, but no threads or SIMD evidence and no recorded work counts.
13. Rival comparison — NOT DONE. No three.js or Babylon rain-glass comparison was found.

**To do before it can be VERIFIED:**
1. Add free pinch-off and detachment of drops from the film (Wang et al. 2005, with measured pendant breakoff volumes), plus splash and rebound (Mundo 1995 or Yarin and Weiss 1995 thresholds).
2. Add a measured partial-wetting drop slide, for example Podgorski, Flesselles and Limat 2001.
3. Move all `RangeError` throws to MargoError with a code and a fix.
4. Record work counts and thread or SIMD evidence, and add a fast tier.
5. Add a rival comparison row.

#### FLUID-07 four-point pass

- Point 5 and audit item 3 (119f92f328). `packages/physics/tests/coupling/thin-film.test.js` rejects a late overflowing pressure wave after candidate volume computation. All accepted bytes and the last accepted native receipt remain unchanged. A corrected retry equals a fresh run. `packages/physics/tests/thin-film.test.js` and the coupled drop checks exercise coded validation with fixes.
- Point 6 and audit item 4 native scaling (119f92f328). `packages/physics/tests/coupling/thin-film-workers.test.js` compares plain and shared 1, 2 and 4 for exact patterned/contact and suspended films, signed fields and replay. `packages/physics/tests/thin-film-workers.browser.mjs` uses three real Chromium helpers and the caller, with 2,137 face matrix products and 2,169,055 gradient SIMD pairs on the final accepted step. Packaged workers dispose after cancellation and normal use. A separate fast tier remains open.
- Point 7 (119f92f328). `packages/physics/tests/thin-film.browser.mjs` checks seeded runnels and glazing, then dry-start directed spray on a live rolling 6 mm pane and real detached drops into a lower film. The accepted receipt is 18.47 mL of rain, 9.86 to 4.11 mL resident and 1.16 mL in the receiver. Both renderers verify exact snapshots and full resolved frames across hold, restore, re-advance and rewind, with outside and inside cameras. The original EF-4 and full tram film integrations remain open.
- Point 8 and audit item 2 measured comparison (119f92f328). `packages/physics/scripts/fluid07-sliding-drop-measured.mjs` independently holds out two Le Grand et al. terminal speeds. The low run remains pre-terminal. The high 80 µm precursor run gives 13.92 and 13.73 mm/s over two intervals against the 10.24–11.22 mm/s band, even carrying the full grid sensitivity. At 40 µm the high run never reaches either scoring interval. [Evidence and limits](limits.md#accepted-film-motion-and-independent-incline-drops-fluid-07)

Independent terminal accuracy, steep contact lines, free pinch-off, impact splash and rebound, the wider rival comparison and original production binding remain open. The row remains REOPENED at four points.

### ATMO-06 Airborne particle transport (`physics/airborne`, commits 965fab2df, 615b8daae), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/airborne/index.ts` (707 lines), `environment.ts` (86), `airborne-kernel/src/lib.rs` (66), `tests/airborne.test.js`, `tests/coupling/airborne.test.js`, the catalog row, the audit rows (audit table line 80, solver row line 139) and the ATMO-06 section of `docs/known-bugs.md`. The only commit touching its source or tests since the audit is the original landing 965fab2df (no commit since 2026-11-25 changes the code; 615b8daae only refreshes pins). Ran `node scripts/run-with-timeout.mjs --max=15 -- node --test` on both test files: 10 tests, 10 pass, 0 fail (4 solver tests including a production-build check, 4 coupling tests plus the 24/30/60 fps replay test). No airborne browser or GPU test exists, so none was run.

**Validation.**
- "Stokes and buoyancy give the analytic settling and relaxation trajectories": exact solution (exponential relaxation with Cunningham slip), 1024 ulp bound derived from float precision. Exact, but the closed form is the integrator's own formula.
- "droplet diameter squared obeys diffusion-limited evaporation...": re-derives the code's own d-squared law with the code's constants. Self-consistent. Salt residue uses the published kappa 1.12 constant (Petters and Kreidenweis 2007).
- "one stochastic step has the exact homogeneous OU mean and variance": exact solution, 6-sigma sampling bound, derived. Homogeneous case only.
- Coupling tests (PA-54, PA-61, PA-55, PA-21, PA-04): wiring and conservation checks (mass ledger, replay, frame-rate independence). No measured data.
- Missing: any independent measurement. No Gunn and Kinzer 1949 terminal velocities, no Prairie Grass dispersion (Barad 1958), no measured evaporation or deposition data.

**Fails points** 1, 2, 3, 4 (partial), 5, 6 (partial), 7 (partial).

**Audit list.**
1. Snow with Bohm 1989 fall speeds — NOT DONE (kinds are only `mineral-dust`, `freshwater-mist`, `sea-spray`, `environment.ts:3`; no snow code).
2. Spume torn from SEA-13 crests in high wind (Andreas 1998) — PARTIAL (whitecap spray source via `coupling/airborne.test.js` "PA-21 and RITS-4"; no spume tearing model or wind-speed spume flux).
3. Thomson 1987 inhomogeneous well-mixed model with drift — NOT DONE (uniform RMS per axis, `index.ts:449`; no ATMO-01 turbulence field).
4. Haider and Levenspiel 1989 non-spherical drag — NOT DONE (spheres only, `environment.ts:44-53`).
5. Heymsfield and Westbrook 2010 snow fall speed — NOT DONE.
6. Sardoy 2007 embers (burning, mass loss, landing temperature) and Costa 2006 ash — NOT DONE (known-bugs lists them as out of scope).
7. Ranz and Marshall 1952 ventilation and wet-bulb evaporation — NOT DONE (`environment.ts:63-68`: no ventilation factor, saturation at air temperature).
8. Temperature-dependent vapour diffusivity — NOT DONE (fixed 2.5e-5, `environment.ts:67`).
9. Validate against Gunn and Kinzer 1949 and Prairie Grass — NOT DONE (no test cites either).
10. Bounce and resuspension — NOT DONE.
11. Spray moisture and cooling returned to the air — NOT DONE (known-bugs: needs output layouts; vapour is only in the mass ledger).
12. Seeds and small debris — NOT DONE.
13. Film rows EF-12, EF-7, RITS-4 — PARTIAL (spray bands tested from live whitecaps; renderer binding still open per demo review).
14. Rival comparison to HYSPLIT or FLEXPART — NOT DONE.

**To do before it can be VERIFIED:**
1. Add independent measured validation: Gunn and Kinzer 1949 terminal velocities across drop sizes, and Prairie Grass (Barad 1958) crosswind-integrated concentration for dispersion.
2. Build Thomson 1987 inhomogeneous turbulence with drift, fed from the ATMO-01 and ATMO-02 field (`index.ts:449` is uniform).
3. Add ventilated, wet-bulb evaporation with temperature-dependent diffusivity (`environment.ts:63-68`) and check it against measured droplet evaporation (Ranz and Marshall 1952).
4. Add snow (Bohm 1989, Heymsfield and Westbrook 2010), non-spherical drag (Haider and Levenspiel 1989), ash (Costa 2006) and embers (Sardoy 2007), plus bounce and resuspension.
5. Replace the plain `RangeError`s (`index.ts:207-536`, `environment.ts:27,50`) with coded `MargoError`s naming the fix.
6. Return spray moisture and cooling to the air, and add a threaded or large-N scaling work count (one 66-line kernel, no recorded scaling).
7. Add the spume source (Andreas 1998) for the EF-12 film and a rival comparison note in `docs/limits.md`.

### BREAK-03 Ductile crushing: hulls, car bodies, rail cars (`physics/crush`, commits 25759ed00 9ef07dff9 28668a645 b7472cd5b da07f5d54 f1e1145da dc0dfa8ef a0325f916 116d3054e 408e506ac 64367a884 168006e3c 1b1a25c61 0fc03c638 24e67d6ff e5a8d911a f39137bee 6fbbf8e86 fa058693d dd6d4b7f2 f82be85af 8300fcbe0 3701ff631 ecd6f501f cf8fb2938), owner Codex: REOPENED

**Checked.** Read `packages/physics/src/crush/{index,shell,material,girder,indentation,ground,envelope}.ts`, the crush tests, the README crush section, the catalog row, the audit row and the KB-PHYS-AUDIT1 bullets. Ran under run-with-timeout: `node --test` on `tests/crush*.test.js` and `tests/coupling/crush*.test.js`: 82 tests, 82 pass on packages built from current main (a first run on an older build failed three shell friction tests for want of `readSphereFriction`, added in 9ef07dff9). `crush-plate.browser.mjs` passes on WebGPU and with `--compat` (WebGL2), 0 shader errors.

**Validation.**
- `crush.test.js` "elastic barrier… quarter-period peak": exact closed form (Huang 2002), derived bound.
- `crush.test.js` "square tube work falls within five independent measured compression replicates" (Yob et al. 2016, Table 4): published measurement. The inputs are the tube dimensions and tensile data, and the bound is the replicate mean plus or minus one sample standard deviation.
- `crush-indentation.test.js` "circular marine plate predicts four measured rupture strokes and work" (Simonsen and Lauridsen 2000): published measurement, with inputs from the specimen table and coupon data. Printed errors are about 5% on stroke and up to 7.6% on work (150.3 J against 159.17 J, 224.3 J against 254.24 J). The tolerances were not re-read in full.
- `crush-plate.test.js` first-mode buckling against Stein's measured bay: published measurement, early loading only.
- `coupling/crush-staged.test.js` FRA full-scale passenger coach: loading velocity RMSE 1.10 mph against a 2.0 mph bound, stop time within 0.01 s of 0.114 s, stroke within 0.15 ft of 3.31 ft. Held-out measurement, but the bounds are chosen by hand and the rebound is not asserted tightly.
- `coupling/crush-staged.test.js` NHTSA 8104 coupe NCAP pulse: held-out measurement, RMS about 4.3 g against a 5 g bound, speed RMS 0.38 m/s against 0.5, stroke within 0.02 m, rebound within 0.5 m/s. The bounds are hand-chosen and loose against a roughly 35 g peak.
- `coupling/crush-ship-model.test.js` two measured wet model-ship trials: measured work off by 1% to 7%, stroke off by 5% to 6%, force off by 5% to 12%.
- Shell tests: Hertz load, momentum exchange and exact replay. These are self-consistency checks, not data.
- Missing: any full-scale ship collision or grounding record, Minorsky energy against damaged volume, and super-folding mean force across several tubes.

**Fails points** 2 (partly), 3, 4 (partly), 5 (partly), 6, 7 (partly), 8 (partly).

**Audit list.**
1. Pedersen and Zhang friction and sliding — PARTIAL. Dry Coulomb friction is built (`coupling/crush.test.js` "crush sliding minimizes contact kinetic energy… friction bound") and native shell friction is built (9ef07dff9), and its tests pass on a fresh build. No Pedersen and Zhang comparison exists.
2. Sustained contact / latched pass-through (KB-PHYS-AUDIT1) — DONE. A unilateral damped support step is in `index.ts` around 434-566. The test "a pressed crush patch supports a sustained load" passes, and `known-bugs.md:955` records the fix. README text at `README.md:5733` still tells users to use sensors.
3. Single-radius gate around one point — PARTIAL. Shell contact and grounding trace the bed, but station patches are still preset points.
4. Seal loss is a linear stroke ratio (`index.ts:390,561`) — NOT DONE as a mechanism. Measured membrane rupture (indentation) and live seam apertures exist, which is partial.
5. Smith progressive-collapse hull girder — PARTIAL. `girder.ts:162` balances a section and the girder-joint test passes. It is validated only on elastic reloading slope, with no collapse data.
6. SEA-10 flooding and deformed-mesh output — DONE. `crush-shell-flood.test.js` and the coupling test pass.
7. Grounding (Simonsen) — PARTIAL. Terrain-bed tracing passes `crush-ground.test.js` against derived plane impulses, with no grounding measurement.
8. Wierzbicki and Abramowicz super-folding — PARTIAL. `material.ts:101` uses the equation, checked on one tube family.
9. Amdahl 1983 and Minorsky energy against damaged volume — NOT DONE.
10. FEM shells as the strong tier — PARTIAL. `shell.ts` and its Wasm kernel are built, but there is no general shell contact or automatic tearing (docs admit this).
11. NCAP 56 km/h pulses — DONE as a held-out test, though with loose bounds.
12. Automatic contact detection — NOT DONE.
13. Wasm hot loop — DONE for the shell kernel, with no recorded work counts.

**To do before it can be VERIFIED:**
1. Build a ship collision and grounding model (Pedersen and Zhang 1998, Simonsen 1997) with a published full-scale or model-scale validation. Add Minorsky 1959 energy against damaged volume.
2. Derive the NCAP and FRA bounds from measurement scatter and rate-tier convergence instead of 5 g, 2 mph and 0.5 m/s, and validate on several vehicles.
3. Replace the linear seal-loss ratio (`index.ts:390,561`) with a rupture criterion, and add general shell contact, automatic contact detection and automatic tearing.
4. Add a coupling test to SEA-08 where contact energy deforms the hull (catalog edge), plus fluid pressure on the shell.
5. Record work counts for the shell kernel scaling, and add film direction inputs for seeded placed breakups.
6. Update `docs/limits.md`, which has no BREAK-03 limits entry, and the README sensor advice.

#### BREAK-03 four-point pass

- Point 5 and audit items 2 and 6 (dcdd72fd18). `packages/physics/tests/coupling/crush.test.js` holds the previous accepted damage and reaction when a rigid input is rejected. `packages/physics/tests/coupling/crush-shell.test.js` checks failure without partial publication and single-world attachment. `packages/physics/tests/coupling/crush-contact-inertia.test.js` and `packages/physics/tests/flooding.test.js` keep stored water and its contact inertia under zero prescribed gravity. The README shows supported contact with an explicit collision filter for the crush pair.
- Point 6 and audit item 5 work counts (dcdd72fd18). `packages/physics/tests/coupling/crush-shell-workers.test.js` compares plain and shared one, two and four participants on two odd-sized meshes, including signed-cell rewind and registered pressure. The 211-face case matches the previous scalar Wasm byte for byte and counts 38,430 SIMD face evaluations. `packages/physics/tests/crush-shell-workers.browser.mjs` observes three real Chromium helpers and worker cleanup.
- Point 7 (dcdd72fd18). `packages/physics/tests/crush-plate.browser.mjs` renders a civilian dock fender under contact from a moving carriage. The fender retains 2.24 mm of deflection and the carriage rebounds at 0.7379 m/s. A parked control stays flat. Each renderer verifies exact accepted snapshots and complete resolved images on hold, replay and rewind. The original EF-11 shot remains open.
- Point 8 and audit item 8 comparison and item 6 limits (dcdd72fd18). `packages/physics/scripts/break03-steel-tube-measured.mjs` compares six independent ASTM A500 axial compression tests without fitting to their results. Predicted mean force is 13.09–27.01% low and work is 13.87–26.59% low. [Evidence and limits](limits.md#civilian-shell-contact-and-independent-tube-compression-break-03)

The published evidence leaves the full ship grounding, general shell contact, automatic tearing, wider vehicle validation and original production integration open. The row remains REOPENED at four points.

## Pass 4, 2026-11-26 (`main` at 2d5d7fa8c)

VERIFIED 0, REOPENED 1. SOFT-02 was set LANDED (marked in cde856e2c); it is judged directly against the standard and its catalog row, as a first landing. No other row was set LANDED.

### SOFT-02 rods, ropes, cables, chains (`@margoengine/physics/rod` with `segmentLoads` in `@margoengine/physics/loads`, commit 7bcfb11e3; d53e71328 named in the queue only regenerates `docs/api-surface.md`), owner Claude: REOPENED

**Checked.** The diff of `src/rod/index.ts` (599 lines), `src/loads/segments.ts`, `morison.ts`, `water.ts` and `solver.ts`, the README section and the `docs/limits.md` entry. `tests/rod.test.js` and `tests/loads-segments.test.js`: 13 pass, 0 fail (18 s, under `scripts/run-with-timeout.mjs`, on packages built from 2d5d7fa8c). No coupling test and no browser test exist for the rod.

**Validation.** Exact solutions, each with a stated bound:
- a clamped rod in a steady current against its own discrete springs (0.2%) and the Euler–Bernoulli cantilever (1%, with 1/n² convergence stated);
- a slack line between pins against the chain of its links and the catenary;
- a taut cable's first frequency against the beam-string closed form (0.5%).

The strumming test checks lock-in qualitatively: frequency within 15% of the cable's own frequency, amplitude between 0.3 and 1.2 diameters. Khalak and Williamson (1999) and the wake oscillator's tuning are cited, but the bounds are not derived from either. The segment-load tests check closed forms: buoyancy, wetted length, drag damping, and White's drag fit against DNV.

No test compares the rod with a measurement: a towed or current-loaded cable, a flexible riser's vortex-induced vibration (Chaplin et al. 2005), or a mooring line's tension.

**Fails points** 1, 2, 3, 4, 5, 6, 7, and the floor.

**Against the catalog row** ("bend and twist, wrapping, friction, anchor chains, rigging, vines"; Discrete Elastic Rods, Kugelstadt and Schömer, Sueda et al.). The builder's own catalog state says "partial", with wrapping, Discrete Elastic Rods, X-54 and X-55 open.

**To do before it can be VERIFIED:**
1. **Floor.** `Rod` is not a framework solver. It lives on the rigid `Physics` world, not the `Solver` contract (`describe`, `init`, `step`, ports, state regions), and no coupling harness test runs it (frame-rate independence, seek equals continuous run). Make it a framework solver, or give it the contract through the rigid world's solver, and add the coupling tests that `npm run check:coupling` asks of a framework solver.
2. **Twist.** It is built (`GJ / l` springs, `twistStiffness`) but no test asserts it. Add a torsion test against the closed form (twist angle `T L / (G J)`) and a coupled bend-twist case, such as the buckling of a twisted rod into a plectoneme (Bergou et al. 2008, section 7).
3. **Wrapping and friction.** Missing: a rope over a peg, bollard or pulley, with the capstan law `T2 = T1 e^(mu theta)` as its validation (Sueda, Kaufman and Pai 2008; X-53). Rope-on-rope contact with friction is missing too.
4. **Anchor chains and mooring.** Missing:
   - seabed contact with axial and lateral friction;
   - chains that take no compression;
   - clump weights, snap loads and breaking at a rated load.

   Validate against a published mooring-line tension record or the MoorDyn and OrcaFlex benchmark cases (Hall and Goupee 2015).
5. **Model breadth.** Missing:
   - Discrete Elastic Rods (Bergou et al. 2008) as the high-fidelity tier beside the capsule-chain tier, behind one API;
   - extensible Cosserat rods with shear (Kugelstadt and Schömer 2016) for soft cables and vines;
   - plasticity or a set curl for vines and wire.

   Rivals: PhysX articulations and ropes; MoorDyn and OrcaFlex for mooring lines (seabed friction, line types, snap loads).
6. **Measured validation.** At least one measured case with a bound derived from its scatter:
   - a flexible cylinder's vortex-induced vibration amplitude and frequency against Chaplin et al. (2005) or Trim et al. (2005), replacing the 0.3–1.2 diameter band;
   - a cantilever or cable in a towing tank.
7. **Coded errors.** `src/rod/index.ts` lines 137, 191, 194, 198, 212, 215, 222, 227, 400, 431, 456, 547 and 550, and `src/loads/segments.ts` lines 236 to 271, throw bare `RangeError` or `TypeError`. Use a coded `MargoError` that names the fix, as the rod's `state` errors already do.
8. **Scale and film.** Record work counts for a long rod (the 4,096-link limit) and many rods (a kelp forest, a ship's rigging). Add direction inputs: a target shape or pose to blend toward, wind on rods in air (ATMO wind field), and a seeded sway.

## Pass 5, 2026-11-27 (`main` at 85c25e4af)

VERIFIED 0, REOPENED 1. SEA-09 was set LANDED with each audit item given its commit and test. The checks were narrow: SEA-09's own tests and those of the solvers it couples to directly.

### SEA-09 manoeuvring, propulsion, resistance, sailing hull (`@margoengine/physics/ship`, 17 commits c6f276858 to 85c25e4af), owner Claude: REOPENED

**Checked.** `tests/ship.test.js`, `tests/coupling/ship.test.js` (with `PackIceSolver`, `WakeSolver` and `HullSolver`), `coupling/planing.test.js`, `coupling/rowing.test.js` and `coupling/sailing.test.js` (with AERO-02's `SailForce`): 50 tests, 50 pass (41 s, under `scripts/run-with-timeout.mjs`, on packages built from 85c25e4af). Every refusal in `src/ship` is a coded `MargoError` through `shipError` (no bare `RangeError` or `TypeError` is left), and the transcendentals are pinned.

**Audit list.** Items 1 to 12 and 15 to 17 are done as the item lines above state, each test opened and passing:
- heel, with KB-SHIP-HEEL1 fixed;
- shallow water, with KB-SHIP-SHALLOW1 fixed;
- waves, planing, sailing, oars, the B-series and four quadrants;
- Holtrop and Mennen wired into the solver, the autopilot and track following, ice;
- work counts in place of a Wasm kernel, which is reasonable for a per-ship ODE;
- coded errors.

Item 13 (validation) is partly done. Item 14 (red flags) is partly done: the squat speed cap and the shaft depth are still stated assumptions rather than cited values.

**Validation.** Most measured checks are against data that was not fitted:
- KCS's turn and heel against MARIN and KRISO, inside the band the two facilities span;
- KVLCC2 against SIMMAN 2008 and 2014;
- level ice within 1.2 standard deviations of MT Uikku's basin tests;
- drift within twice its run-to-run spread;
- the single scull's blade efficiency within two standard deviations.

What is fitted is stated: N'r at h/T 1.2 to KRISO's 20/5, the roll lever and damping to MARIN's peak and final roll, and Sysser 1, which belongs to the Delft series. The 20/5 zigzag at h/T 1.5, 45% under KRISO, is an accepted difference: a fully measured model also misses it, so it sits at the state of the art.

**Fails points** 2 and 8; the other six hold.

**To do before it can be VERIFIED:**
1. **Derive the hand-set bounds, or record each as an accepted difference with the scatter that supports it.** Each bound should come from the measurement's stated uncertainty (or the figure-reading error) plus the spread between facilities or runs:
   - the bank moment N' within 35% and the sway force Y' within 45% (`ship.test.js:1810`, `:1812`);
   - KVLCC2's 20/10 at h/T 1.5 within 30% (`:1868`);
   - S175's added resistance within 15% per point (`:1275`);
   - KVLCC2's added resistance within 35% per point (`:1314`);
   - Shoemaker's planing trim within 15% (`:1378`);
   - the ORC polar within 15% per point (`:1602`).
2. **The bank sway force at h/T 1.2 has the wrong sign.** Near the switch from attraction to repulsion it gives repulsion where Vantorre et al.'s measured force stays near zero, and the test leaves that case out. Fix it, for example with the depth dependence of Lataire and Vantorre's later regressions, or put it to the lane manager as an accepted difference. It is documented in `docs/limits.md`.
3. **Unconfirmed citation.** "I. M. Sherif, P. Xin and X. Zhou, Brodogradnja 78(1), 2027" (`docs/clean-room.md`, the source of the h/T 1.2 advance of 2.92 L and of Amin and Hasegawa's reprinted formulas) could not be found, and its volume is dated after today. Give its DOI, or take the data from Amin and Hasegawa (2010) and a confirmed free-running source.
4. **The catalog row is stale.** The state column of SEA-09 in `docs/physics-solvers.md` still says heel, leeway, keel lift, oars and planing are not built.
5. **Squat cap and shaft depth.** The speed cap of 0.69 and the shaft depth d − 0.6 D are still assumptions. Cite them, for example ITTC squat guidance (ITTC 2017, 7.5-02-06-02) and a shaft immersion from the hull's particulars, or derive them.

## Pass 6, 2026-11-27 (`main` at 00d9fdf9b)

VERIFIED 0, REOPENED 1. FIRE-05 was set LANDED as a first landing; it is judged against the standard and its catalog row. The checks were narrow: its own tests, its threads test, and the tests of what it touches (the terrain bed, breakables, hull plates and rigid bodies). Each measured source was looked up.

### FIRE-05 explosive source and fragments (`@margoengine/physics/explosive`, commits d6a16ef69 to 00d9fdf9b), owner Claude: REOPENED

**Checked.** `tests/explosive.test.js`, `tests/explosive-gun.test.js` and `tests/coupling/explosive.test.js`, `explosive-gun`, `explosive-hits`, `explosive-kernel` and `explosive-threads`: 38 tests, 38 pass (under `scripts/run-with-timeout.mjs`, on packages built from 00d9fdf9b).

What holds:
- every refusal is a coded `MargoError` with a help link;
- the source has no host transcendentals;
- fragment flight is a Rust and Wasm SIMD kernel on 1 to 64 threads with the same bits, and the TypeScript and kernel hits agree to the bit;
- frame-rate independence and seek-equals-continuous hold;
- momentum and energy are accounted exactly for the gun's recoil and the charge's budget;
- film direction is seeded.

**Sources looked up.**
- Sonder et al. 2022 (JGR Solid Earth 127, doi:10.1029/2022JB023952) exists. It reports up to about 8% of each blast's energy airborne and up to about 20% seismic.
- Fielder and Guest's "Explosion craters on the Earth and Moon" (Communications of the Lunar and Planetary Laboratory 115, 1967) exists and covers Fauld.
- Kennedy's Gurney chapter, and Noble and Abel's closed-vessel table as the 1911 Britannica's "Ballistics" prints it, are standard sources.

**Validation, test by test.**
- **Gurney speed against Kennedy's measured values, within 10%.** It checks Kennedy's own rule, E ≈ 0.7 ΔH_d, against the table it came from, and leaves out nitromethane, the case the rule misses. This is a fair check of the code, but not an independent test of the model.
- **Air share against Sonder et al.'s 23 blasts.** The measured shares sit a factor of 1.84 above the law. The test accepts a mean off by up to a factor of 2, and each blast within 2.5 of the data's own spread, so a systematic 84% miss passes.
- **Seismic share against "10 to 17%".** The default seismic coupling of 0.15 is taken from Sonder et al. (`charge.ts:209`), so this is calibration, not validation. The band is also the paper's airborne plus seismic total, while the test compares the seismic share alone.
- **Fauld.**
  - The crater-work share bound (0.1 to 0.3) is set by hand.
  - The "measured 250 m crater" could not be confirmed as Fielder and Guest's figure. Other reports give about 300 m across at the widest, and Sonder et al.'s law gives 250 to 340 m, so the stated limit ("about 30% wider than measured in rock") may be wrong.
- **Noble-Abel closed vessel.** The propellant constants are fitted to the same 21 pressures the test checks (`gun.ts:50`), so this is a fit check. Only cordite's force against its separately measured gas volume (20%) is independent.
- **The 6-in. gun's 2150 ft/s.** Cordite's burning rate is calibrated to this figure (`gun.ts:29`), so the 0.5% check is self-consistent, although the test name presents it as a result. The peak-to-mean pressure ratio of 2 to 3 is held out, but only as loose as its source's "2 or 3 times".
- **Fragment sizes, throw and plate holing.** Mott's distribution is checked only as a statistical shape, and the 2 mm and 50 mm plates only as qualitative cases. Nothing is compared with civil measurements: rock-blasting fragment sizes, flyrock throw, or structural punching of plates.

**Fails points** 2, 3, 4 and 8; points 1, 5, 6 and 7 hold.

**To do before it can be VERIFIED:**
1. **Independent measured validation from civil data, with derived bounds.** Under the standing rule, no weapons-effectiveness data is used anywhere in the engine.
   - Fragment size distributions against rock-blasting and brittle-fragmentation measurements: sieved muck piles fitted by the Kuz-Ram or Swebrec distributions (Cunningham 1987; Ouchterlony 2005), or brittle-fragmentation tests.
   - Throw and debris range against measured flyrock and quarry-blast throw (for example high-speed video of bench faces).
   - The debris field against a surveyed civil blast or an accidental explosion's debris record.
2. **Separate fits from checks.** Name every fitted constant in its test (the Noble-Abel constants, cordite's burning rate, the seismic coupling). Validate each against data not used to fit it, such as a second gun's muzzle speed and pressure from the same or another range table, or a second closed-vessel series.
3. **The seismic share** is compared with Sonder et al.'s airborne plus seismic band. Compare like with like (their seismic share alone, up to about 20%), and use blasts not used to choose the 0.15 default.
4. **The air share** runs 1.84 times under Sonder et al.'s blasts. Explain or correct the law's reference charge so the mean bias is gone, then bound the scatter from the data.
5. **Fauld's crater.** Confirm the diameter from Fielder and Guest's text (or the Ministry of Defence survey) and correct either the test's 250 m or the `docs/limits.md` claim that the law overshoots rock by about 30%. Derive the crater-work bound.
6. **Plate holing.** Use a punching and tearing model with a cited source and test it against civil and marine structural punching tests, not only "2 mm opens, 50 mm holds". Candidates are quasi-static and impact punching of ship-side plates by indenters (Simonsen and Lauridsen 2000; Alsos and Amdahl 2009).
7. **Coupling.** The catalog sends ejecta mass and speed and the hot gas to ATMO-06 (dust), FIRE-03 (fire) and EARTH-06 (ejecta deposits). Only breakables read the `explosions` field. Add those couplings with a test each, plus the blast hand-off to FIRE-04 that the air share names.
8. **The catalog row is stale.** FIRE-05's state column in `docs/physics-solvers.md` still says "stand-in: PA-51, 52, 53".

## Catalog gaps found

- **Soft bodies cut or torn into separate bodies.** SOFT-06 (landed in `a82ff99eb`) does not cover this. What exists:
  volumetric bodies split into separate bodies with their own state through the virtual-node method in
  `packages/physics/src/soft-split.ts` and the blade cut `SoftBodies.cut` (tests "a bar tears … in two pieces" and
  "a blade through a block makes two pieces whose volumes add to the block"); cloth splits into separate cloths only
  with `splitOnTear: 'all'` (the default is `'cells'`) and only along existing edges. What is missing: a torn
  pressure shell that stays in one piece keeps all its gas, and one split apart loses its gas at once with no
  venting. The catalog now states cutting and tearing into separate bodies in SOFT-04 and SOFT-01, and widens SOFT-06
  with venting, bursting and torn shells becoming separate bodies.
- **DYN-04 full tyre.** `packages/physics/src/tyres.ts` holds the 1992 sine form of the Magic Formula with a
  load-sensitive peak and a friction-ellipse rescale for combined slip, and a brush model. The catalog row now names
  Pacejka's 2012 Magic Formula (MF 6.x) with combined-slip weighting functions, load and inflation-pressure
  sensitivity, camber, aligning moment and relaxation length.

## Four-point checkpoints for audit table rows

### ICE-04 Pack ice and floes

#### ICE-04 four-point pass

- Point 5 (50e4e322ce). `packages/physics/tests/coupling/pack-ice.test.js` checks fix-linked errors, cross-bank port reads through memory growth, retention of accepted snapshots and work after a late invalid source, and the signed live cell after restore. Repairing the rejected input repeats the same accepted bytes.
- Point 6 (50e4e322ce). `packages/physics/tests/coupling/pack-ice-workers.test.js` checks ordered pair contacts and live rigid impulses at 1, 2 and 4 participants against the same signed replay. A nonfinite result in the last worker range preserves accepted poses and work. `packages/physics/tests/pack-ice-workers.browser.mjs` starts three real helpers and records 6,256 f64x2 floe drift rows in 16 substeps, plus 29,141 ordered contact candidates for 391 floes.
- Point 7 (50e4e322ce). `packages/water/test/pack-ice-film.browser.mjs` renders the real 71-floe pack and rigid launch. The matched vessel-contact control shows a 0.753 m/s loss of speed and an approximately 2.599 kN·s opposing impulse, balanced with ice momentum. The pack retains its volume while redistributing 65.02 L to rafts and 74.71 L to ridges. Both backends repeat the complete accepted snapshots and full RGBA for their own draws.
- Point 8 (50e4e322ce). `packages/physics/scripts/ice04-pack-resistance-measured.mjs` scores the change in two tow-force pairs from Xue et al. Table 3, held out from the model and its material parameters. Going from 60 to 80 percent ice gives modeled versus measured increases of 0.542 versus 0.774 N and 1.590 versus 1.231 N. Both are inside the published repeat envelopes with hull-to-floe friction. Using measured floe-to-floe friction globally takes the higher-speed condition outside its repeat-only envelope. [Evidence and limits](limits.md#ice-04-shared-native-drift-and-independent-tow-resistance)

Bonded fracture, polygons, wave interaction, ICE-05 thermodynamics, separate contact friction, absolute tow resistance and original shots remain open. The row stays REOPENED at four points.

### ICE-01 Snowpack

#### ICE-01 four-point pass

- Point 5 (316b7367c1). `packages/physics/tests/coupling/snowpack.test.js` checks fix-linked errors, foreign-bank heat with memory growth, unchanged cover, heat, runoff and version after a late native overflow, and the live signed origin after restore. Corrected forcing repeats the same accepted bytes.
- Point 6 (316b7367c1). `packages/physics/tests/coupling/snowpack-workers.test.js` verifies exact 1-, 2- and 4-participant signed replay across both grid sizes. Ordered snowfall and drift precede independent column updates. `packages/physics/tests/snowpack-workers.browser.mjs` starts three real helpers. The 221-column case records 714 conduction links and 38,556 bisection iterations, with 694 links solved in f64x2 pairs. Both grids also repeat the previous scalar Wasm exactly.
- Point 7 (316b7367c1). `packages/weather/tests/snowmelt-film.browser.mjs` links accepted ATMO-09 heat to snowpack discharge and real shallow water. Snow area goes from 300 to 128 m² in 15.67 simulated hours and 10.965 m³ reaches the pond. The unheated control stays dry and snow-covered. Accepted height and the renderer gauge agree within 20 µm. Both renderers repeat exact full RGBA and accepted snapshots.
- Point 8 (316b7367c1). `packages/physics/scripts/ice01-col-de-porte-measured.mjs` checks later snow depth and water equivalent from two independent six-day weather windows. The model's depth RMSE is 0.011 and 0.018 m. On the last warm day it retains 232.89 kg/m² against 189 kg/m² measured. Even the instantaneous residual of 31.70 kg/m² exceeds the 25 kg/m² spatial RMS scale. The 300-to-150 s refinement and one-hour forcing label shift leave the warm miss intact. [Evidence and limits](limits.md#ice-01-snowpack-acceptance-and-independent-field-measurements)

Warm-period water equivalent, storm-by-storm layers, microstructure and weak layers, suspension and vapor mass exchange, and original avalanche shots remain open. The row stays REOPENED at four points.

### ICE-03 Iceberg rigid-body dynamics and calving

#### ICE-03 four-point pass

- Point 5 (a71611f852). `packages/physics/tests/coupling/iceberg.test.js` checks coded fix-linked errors, a foreign calving bank with a late invalid entry, and an overflowing derived meltwater flux. Both retain all accepted output bytes. Corrected input reproduces the same snapshot and all five ports keep the live signed origin through a shift and restore.
- Point 6 (a71611f852). `packages/physics/tests/coupling/iceberg-workers.test.js` compares 259 and 385 rows with 1, 2 and 4 participants and signed replay. A real GlacierSolver event and vacant rows exercise admission. `packages/physics/tests/iceberg-workers.browser.mjs` starts three actual helpers. The 259-row case records 234 active bodies, 887 adaptive substeps, 2,008 wrench evaluations and 40,160 paired face dot products. Both grids also match the previous scalar Wasm exactly.
- Point 7 (a71611f852). `packages/water/test/iceberg-film.browser.mjs` draws an accepted cuboid reaching 105.2° of roll at 5 s. Its live signed SeaSource drives a far gauge 11.99 cm above still water. The identical-ice control with wake disconnected stays flat. Independent clipping, zero net source volume and an accepted height read within 2 µm pass. Both renderers repeat full frames and snapshots exactly.
- Point 8 (a71611f852). `packages/physics/scripts/ice03-capsize-measured.mjs` checks Burton's held-out motion after initialization. Modeled and measured 10° to 90° times are 0.636 and 0.998 s, outside the 0.10 s allowance. Observed maximum roll is 96.07° versus 114.28° modeled. The separate Heller comparison retains the guided tank versus free-body difference, with 0.214 m/s observed and 0.403 m/s modeled marker speed. [Evidence and limits](limits.md#ice-03-accepted-calving-and-independent-capsize-measurements)

Measured timing and wave amplitudes, added inertia and radiation damping, two-way water feedback, grounding, irregular shape and fracture, and original shots remain open. The row stays REOPENED at four points.

### ICE-02 Glacier and ice-sheet flow

#### ICE-02 four-point pass

- Point 5 (72e4b4d57b). `packages/physics/tests/coupling/glacier.test.js` rejects an unrepresentable ice inventory, an overflowing trial and a negative paused tick with coded fixes. The rejected step preserves accepted bytes and work state. All six native-backed ports keep the live signed cell across a shift and restore, then replay without drift.
- Point 6 (72e4b4d57b). `packages/physics/tests/coupling/glacier-workers.test.js` compares complete physical banks across 1, 2 and 4 native participants on 437 and 567 cells. Both match the previous plain and shared Wasm in a separate old-asset comparison. `packages/physics/tests/glacier-workers.browser.mjs` starts three actual Chromium helpers. The 437-cell case records 777 conductances, 756 evaluated in paired SIMD lanes, and 380 crevasse roots. The conservative solve and release reductions keep their original order.
- Point 7 (72e4b4d57b). `packages/water/test/glacier-calving-film.browser.mjs` releases 36.450 m³ from accepted grounded ice into the registered iceberg path, closing the ice ledger. The resulting wake raises a gauge 5.5 m away by 16.44 cm after 3 s. The closed marine control stays flat. Water reads back the computed gauge within 20 µm. Both renderers independently reproduce complete snapshots and RGBA through hold, restore, re-advance and rewind.
- Point 8 (72e4b4d57b). `packages/physics/scripts/ice02-glacier-velocity-measured.mjs` runs with separately observed thickness and surface slope, with fixed Glen softness. Athabasca reports 49.6 m/yr depth-mean speed versus 75.99 m/yr modeled. Greenland reports 4.6 m/yr deformation, [0.4, 10.8] m/yr, versus 19.46 m/yr modeled. The solver also misses the 114.8 m/yr observed total surface speed where basal sliding dominates. [Measured comparisons and limits](limits.md#grounded-glacier-and-ice-sheet-flow-ice-02)

Basal sliding, longitudinal and transverse stress, temperature and floating shelves, subcell calving, and the wider physical validation and couplings remain open. The row stays REOPENED at four points.

### LIFE-02 Limbless, insect and small-animal locomotion

#### LIFE-02 four-point pass

- Point 5 (b20d78c528). `packages/physics/tests/coupling/locomotion.test.js` rejects a late invalid terrain sample, reentrant drive write and overflowing native candidate with coded fixes. The accepted snapshot and work record remain exact. It grows real plain memory in a sampler, reads a separate aligned f32 bed bank and replays both live signed publications after an origin shift.
- Point 6 (b20d78c528). `packages/physics/tests/coupling/locomotion-workers.test.js` compares 205 and 275 mixed body rows, spanning all five presets, across 1, 2 and 4 native participants and signed seek. A separate comparison matches the previous plain and shared Wasm. `packages/physics/tests/locomotion-workers.browser.mjs` starts three actual Chromium helpers. The 205-body sample records 2,293 contact rows and 2,147 paired SIMD projections.
- Point 7 (b20d78c528). `packages/environment/tests/slither-film.browser.mjs` connects a real registered cambered TerrainBed to the 32-link tapered snake at an adjacent signed cell. After four identical input waves the directional friction take travels +10.065 cm, against −1.360 cm with equal friction. Both renderers independently reproduce all accepted snapshot bytes and full RGBA through hold, restore, re-advance and rewind.
- Point 8 (b20d78c528). `packages/physics/scripts/life02-slithering-measured.mjs` uses separate friction and gait inputs and holds out tracked flat and uphill speed. The default model reverses between 0° and 1.9°, versus 5°–9° measured, and at +5° predicts −0.241 body lengths per cycle against +0.13 measured. Doubling link resolution does not resolve the sign. [Measurement and limits](limits.md#ground-animal-locomotion-life-02)

The planar snake still needs independent speed accuracy, contact-load redistribution and additional gaits. Legged force validation, overhang and articulated contact, reciprocal terrain wear and full rig bindings remain open. The row stays REOPENED at four points.

### AERO-05 Falling and tumbling light bodies

#### AERO-05 four-point pass

- Point 5 (c33e207d1b). `packages/physics/tests/coupling/falling.test.js` rejects late invalid wind, drag, sweep and reentrant callbacks with coded fixes. It grows plain Wasm memory, shifts the published cell and restores bit-exact accepted poses and work. A late f32 overflow leaves the full caller buffer intact. The existing PA-32 rounded-body wall and platform cases remain covered.
- Point 6 (c33e207d1b). `packages/physics/tests/coupling/falling-workers.test.js` compares all accepted bytes on 303 and 457 mixed APW plate, samara and swept-sphere rows across 1, 2 and 4 participants. `packages/physics/tests/falling-workers.browser.mjs` starts three actual Chromium helpers. In the 303-row case it records 9,012 RK4 evaluations and 252,336 paired SIMD state updates. The Wasm assets match the existing public K23 builds exactly.
- Point 7 (c33e207d1b). `packages/environment/tests/samara-film.browser.mjs` draws two identically released 36.8 mm samaras in calibrated lanes. At 64/240 s the still-air take spins at 25.45 rad/s and sits 12.82 cm above the analytic vacuum control. Both backends independently reproduce full accepted state and RGBA after hold, restore, re-advance and rewind.
- Point 8 (c33e207d1b). `packages/physics/scripts/aero05-samara-measured.mjs` retains published morphology and existing polar parameters for two independent natural maple still-air cohorts. The two predicted descent speeds, 0.776 and 0.723 m/s, lie below observed 1.00 ± 0.10 and 1.10 ± 0.24 m/s. Blade and time refinement change the results negligibly. One observed 12 ± 5° cone exceeds the fixed-axis model. [Comparisons and limits](limits.md#falling-plates-winged-seeds-and-hail-aero-05)

Free-axis coning, full 3D plate tumble, natural shape presets, extended Reynolds drag and multi-regime validation remain open. The row stays REOPENED at four points.

### HYDRO-06 Groundwater and springs

#### HYDRO-06 four-point pass

- Point 5 (507df10bf7). `packages/physics/tests/coupling/groundwater.test.js` rejects a late unrepresentable world-second seepage rate and misaligned recharge while keeping all accepted bytes and work. It reads an f64 recharge bank and f32 terrain bank in separate memories, refuses a late invalid terrain vertex and replays all four signed publications through an origin shift and restore.
- Point 6 (507df10bf7). `packages/physics/tests/coupling/groundwater-workers.test.js` compares 221 and 391 signed anisotropic cells with 1, 2 and 4 native participants. A separate raw Wasm comparison matches the previous public physical bank. `packages/physics/tests/groundwater-workers.browser.mjs` starts three actual Chromium helpers and records 412 conductances, 384 paired SIMD lanes and 97 initial active springs. Ordered pressure iteration and volume closure are retained.
- Point 7 (507df10bf7). `packages/water/test/spring-film.browser.mjs` draws the native groundwater table and real shallow-water basin. The open spring releases 0.308065 m³, equal to accepted pond volume, and draws the front head down 0.4517 m relative to a sealed dry control. Both renderers independently reproduce complete accepted state and full RGBA.
- Point 8 (507df10bf7). `packages/physics/scripts/hydro06-glass-beads-measured.mjs` scores independent reported discharge with measured tank geometry, conductivity and metered rainfall. At 195 s the solver gives 4.69 mL/s, against 7.50 mL/s observed, and its 0.5 mL/s crossing is about 15 s early. The separate outlet-aligned 4 mm measurements also exceed the modeled rise under input and grid sensitivity. [Measured limits](limits.md#groundwater-and-springs-hydro-06)

Unsaturated recharge transit, multilayer and confined transient response, wells and reciprocal spring exchange remain open for the unconfined world solver. The row stays REOPENED at four points.

### ATMO-05 Tropical cyclones and large vortices

#### ATMO-05 four-point pass

- Point 5 (e56545a625). `packages/physics/tests/coupling/vortices.test.js` checks signed cells and exact restore. Invalid late depth, misaligned foreign memory and an invalid extreme-pressure sample preserve the accepted forcing, loads, probes and caller output.
- Point 6 (e56545a625). `packages/physics/tests/coupling/vortex-water-workers.test.js` compares five prescribed profiles and exact signed wet/dry output with the scalar path and 1, 2 and 4 native participants. `packages/physics/tests/vortex-water-workers.browser.mjs` observes three Chromium helpers, 247 rows, 182 wet cells, 728 pressure faces evaluated in SIMD pairs and 182 wind samples.
- Point 7 (e56545a625). `packages/water/test/cyclone-film.browser.mjs` draws a real native storm-driven shallow-water shelf. Pressure and boundary forcing add 0.719 m at the surveyed shore and wind adds another 1.885 m. The inland gauge reaches 1.789 m deep with wind and stays dry in both controls. Each renderer independently reproduces full state and RGBA.
- Point 8 (e56545a625). `packages/physics/scripts/atmo05-storm-measured.mjs` initializes Isabel from NOAA B-deck pressure and track fields and compares independent dropsonde and marine drag measurements. The modeled 1 km tangential speed is 47.757 m/s against 76 ± 6 m/s observed. The four high-wind stress samples exceed the independent Powell intervals. [Measured limits](limits.md#atmo-05-accepted-storm-forcing-and-observations)

Dynamic inflow and eyewall structure, reciprocal air–water feedback, remaining package coupling and the CY-14 film shot remain open. The row stays REOPENED at four points.

### EARTH-05 Terramechanics

#### EARTH-05 four-point pass

- Point 5 (cdefe2ee68). `packages/physics/tests/coupling/terramechanics.test.js` checks signed foreign terrain and load arrays, malformed late rows, memory growth while sampling the floor, and exact preservation of every accepted bank on rejection. `packages/physics/tests/coupling/resistive-soil-workers.test.js` also checks that foreign terrain and rigid rows produce the same accepted resistive wrench as local inputs.
- Point 6 (cdefe2ee68). `packages/physics/tests/coupling/resistive-soil-workers.test.js` compares 545 and 746 physical samples across one, two and four native participants and exact signed replay. `packages/physics/tests/resistive-soil-workers.browser.mjs` observes three Chromium helpers and 273 SIMD sample pairs spread across all four participants for one body. Ordered deposition and wrench summation are retained. The new native path also matches the previous binaries on both fixtures.
- Point 7 (cdefe2ee68). `packages/physics/tests/terramechanics-film.browser.mjs` draws a native single-wheel soil bin. The driven rut is 126.60 mm versus 31.59 mm braked, and ATMO-06 receives 3.681 g versus 0.829 g. Each renderer independently reproduces all accepted state and raw RGBA through hold, immediate snapshot restore, re-advance and rewind using the accepted wheel pose port.
- Point 8 (cdefe2ee68). `packages/physics/scripts/earth05-plates-measured.mjs` compares independent slender plates and repeated loading. The resolved tier predicts 27.89 and 29.38 mm versus 36.90 and 39.49 mm observed for the 1:5 and 1:7 plates at 48 kPa. The normalized tenth-cycle sinkage remains 1.0 versus 1.719 observed. [Measured limits](limits.md#independent-plate-shape-and-repeated-pressure)

Slender footprint pressure, cumulative same-peak compaction, remaining belt and animal coupling, and the original film takes remain open. The row stays REOPENED at four points.

### EARTH-08 Seismic waves and ground shaking

#### EARTH-08 four-point pass

- Point 5 (27eeda9cac). `packages/physics/tests/coupling/seismic.test.js` checks that a rejected wave pulse and rejected late support load preserve all accepted bytes and the last native work, including independent memory ownership. The matrix build tolerates plain-memory growth during a material callback and both ground outputs replay their signed origins.
- Point 6 (27eeda9cac). `packages/physics/tests/coupling/seismic-workers.test.js` compares 31 × 27 and 37 × 31 sections byte for byte with one, two and four participants and signed restore. `packages/physics/tests/seismic-workers.browser.mjs` observes real helpers and 837 interior cells, including 810 live paired SIMD cells, in each velocity and stress phase plus 31 caller surface points. The joined phases also match the previous Wasm on three shapes in both memory modes.
- Point 7 (27eeda9cac). `packages/physics/tests/seismic-film.browser.mjs` couples a natural P–SV section, a single Newmark instrument and a real rigid witness, against a silent control. Station peak acceleration is 1.816 m/s² and the two readouts reach 3.461 and 6.584 mm at frame 68. Each renderer independently reproduces the complete accepted state and RGBA through hold, immediate restore, re-advance and rewind.
- Point 8 (27eeda9cac). `packages/physics/scripts/earth08-mashiki-measured.mjs` uses the original NIED P/S logging profile and an independent density estimate. The production transit is 0.33187–0.33609 s, versus a measured weak-motion reference of 0.377 s. The separately calculated continuum ratio peaks at 4.025 Hz versus the observed 3.4 Hz feature. [Measured limits](limits.md#earth-08-elastic-site-response-at-mashiki)

Three-dimensional and nonlinear site response, evolving pore pressure, richer rupture geometry and a wider range of measured events remain open. The row stays REOPENED at four points.

### ICE-05 Ice thermodynamics

#### ICE-05 four-point pass

- Point 5 (539f1f526a). `packages/physics/tests/ice.test.js` checks that equal warm face flux ablates equal depths on thin and thick sheets, independently of the old backward growth law. `packages/physics/tests/coupling/ice.test.js` checks signed replay, separate field ownership, late invalid frost forcing and preservation of the entire accepted state.
- Point 6 (539f1f526a). `packages/physics/tests/coupling/ice-thermal-workers.test.js` compares 257 and 341 mixed sites between scalar and native one, two and four participants, including the odd tail, exact signed replay and phase budgets. `packages/physics/tests/ice-thermal-workers.browser.mjs` observes real Chromium helpers and 256 live SIMD-paired sites out of 257.
- Point 7 (539f1f526a). `packages/physics/tests/ice-thermodynamics-film.browser.mjs` melts six 17 mm ice sheets from live natural lava. It returns 1.2485 MJ of absorbed heat, 3.741224 kg of liquid in the shallow basin and 0.1358 g of steam. The insulated control stays frozen and dry. Each renderer independently repeats complete accepted state and full RGBA.
- Point 8 (539f1f526a). `packages/physics/scripts/ice05-channel-freezing-measured.mjs` uses measured plate temperatures and compares held-out optical thicknesses. At 120 minutes the slab predicts 27.57 and 27.48 mm at both stations. The observed ranges are 13.47–20.69 and 9.68–19.08 mm, respectively. It misses all 16 samples. The separately forced bulk-water sensitivity misses 15 of 16. [Measured limits](limits.md#ice-05-freshwater-flow-over-a-cold-plate)

Distributed heat storage, brine and surface snow evolution, local water-flow feedback and inferred wind-dependent icicle transfer remain open. The row stays REOPENED at four points.

### FIRE-06 Heat conduction and phase change

#### FIRE-06 four-point pass

- Point 5 (127472895c). `packages/physics/tests/coupling/thermal-stress.test.js` checks coded material and restraint errors, live signed heat and solid publications, byte-exact registered rewind, separate input memories and rejection of a late liquid cell or misaligned lease before replacing the mechanical solution. `packages/physics/tests/coupling/thermal-workers.test.js` checks that an invalid extraction in a remote range retains all accepted heat banks and the prior work receipt.
- Point 6 (127472895c). `packages/physics/tests/coupling/thermal-workers.test.js` compares explicit native 1, 2 and 4 participants byte for byte on odd grids and through subdivision and replay. `packages/physics/tests/thermal-workers.browser.mjs` observes three simultaneous helpers and 560 paired stencil cells out of 665, plus 1,328 paired decodes out of 1,330. Radiation stays caller-ordered and the implicit solver stays single-participant.
- Point 7 (127472895c). `packages/physics/tests/thermal-film.browser.mjs` renders live heat-to-emission and heat-to-stress coupling. Its exposed kiln specimen loses 66,113 J and bows 0.587 mm in 24 s, with an exactly unchanged insulated control. WebGPU and WebGL2 each repeat complete accepted state and RGBA at held frames, restore, advance and rewind.
- Point 8 (127472895c). `packages/physics/scripts/fire06-gallium-measured.mjs` compares independent measured fronts and tests grid and boundary sensitivity. At 17 min the solver predicts a flat 30.67 mm front and the measured span is 23.7–70.3 mm. Only one of nine samples overlaps the estimated figure and sensitivity range. [Measured limits](limits.md#fire-06-gallium-melting-across-a-heated-vertical-plate)

Mushy melting, temperature-dependent materials, melt convection, a scalable implicit solve and installation in the original kiln and turbofan shots remain open. The row stays REOPENED at four points.

### SOUND-04 Contact and modal sound

#### SOUND-04 four-point pass

- Point 5 (b23fdc911c). `packages/physics/tests/coupling/modal-sound.test.js` checks a real joint rupture through a signed-origin shift and exact rewind. It reads separately owned contact memory and rejects a late malformed load, an unaligned region and a wrong origin before any accepted sound state changes. `packages/physics/tests/coupling/modal-sound-workers.test.js` checks rejection of individually nonfinite PCM, oscillator and roughness trials with retained prior work.
- Point 6 (b23fdc911c). `packages/physics/tests/coupling/modal-sound-workers.test.js` verifies exact accepted history and audio for 1, 2 and 4 participants on 7 and 11 tracks. `packages/physics/tests/modal-sound-workers.browser.mjs` verifies three simultaneous actual Chromium helpers, 7 tracks, 2,569 PCM samples and 6,606 paired complex recurrence updates among the 367-sample block.
- Point 7 (b23fdc911c). `packages/physics/tests/modal-sound-film.browser.mjs` generates the steel bar's 431.86 Hz ring from an accepted 0.6867 N·s hit, with a gravity-released control striker caught above the bar. All 28,800 samples follow the analytic response to within 1.49 × 10⁻⁸. Both renderers independently repeat complete state, PCM and RGBA through held frames, pre-contact and mid-ring restore, re-advance and rewind.
- Point 8 (b23fdc911c). `packages/physics/scripts/sound04-modes-measured.mjs` evaluates independent thin-plate predictions using nominal geometry and material and reads the frequencies from the production PCM. The 24 independent measurements differ by up to 14.19 Hz and 6.31%, with five falling inside the published rounding and readout interval. The solver still requires supplied modes. [Measured limits](limits.md#sound-04-simply-supported-aluminum-plates)

Geometry-derived modes, contact-point mode shapes, acoustic radiation and the other mapped source couplings remain open. The row stays REOPENED at four points.

### BIO-02 Plant growth and morphogenesis

#### BIO-02 four-point pass

- Point 5 (ba3941ca5d). `packages/biomes/tests/coupling/growth.test.js` checks signed HYDRO-02 and branch replay, independently owned offset soil banks, and byte-exact retention on an invalid last root or an unrepresentable late candidate shoot. The season counter and native work receipt advance only on acceptance.
- Point 6 (ba3941ca5d). `packages/biomes/tests/coupling/growth-workers.test.js` verifies 1, 2 and 4 native participants on odd grids, clipped edges, singleton depth, and byte-exact branch and snapshot replay. `packages/biomes/tests/growth-workers.browser.mjs` starts three simultaneous helpers and records 143 sources, 1,404 clipped rows, 6,577 additions and 5,346 paired SIMD additions in one accepted season.
- Point 7 (ba3941ca5d). `packages/biomes/tests/growth-film.browser.mjs` drives growth and Procedural tube geometry from live HYDRO-02. An 8 mm surface application produces 59 internodes and a 1.035 m crown after eight modeled seasons versus 24 and 0.403 m in the matched control. The water budget closes, and accepted state and RGBA replay exactly on each renderer.
- Point 8 (ba3941ca5d). `packages/biomes/scripts/bio02-growth-measured.mjs` compares 16 independent field red maple means. At two years the solver gives 38.4 and 80.0 cm against 9.3 and 33.7 cm for 8% and 57% light. The generic parameters overestimate all means by up to 57.3 cm. Halving the voxel side preserves the result and reduced water still overpredicts. [Measured limits](limits.md#bio-02-red-maple-growth-under-field-shade)

Species-specific physiology, sustained multi-internode extension, crown shedding, a spatial colonisation tier and existing branch bending remain open. The row stays REOPENED at four points.

### BIO-03 Forest ecosystem dynamics

#### BIO-03 four-point pass

- Point 5 (1476595e04). `packages/biomes/tests/coupling/forest.test.js` checks borrowed f64 exposure and live signed publication, rejecting a late patch or a failed recruitment callback before replacing accepted exposure, trees or native work. `packages/biomes/tests/coupling/forest-workers.test.js` restores the physical 65,536 Q16 cover for a 1 mm crown beneath two 40 m crowns, where the previous i32 sum turned negative.
- Point 6 (1476595e04). `packages/biomes/tests/coupling/forest-workers.test.js` exercises exact 1/2/4 signed stand histories and rewind. `packages/biomes/tests/forest-workers.browser.mjs` starts three simultaneous Chromium helpers on 62 rows, with 55 live queries, 2,005 candidates and 106 SIMD-paired overlaps out of 113. Existing BIO-02 helper replay is also checked.
- Point 7 (1476595e04). `packages/biomes/tests/forest-film.browser.mjs` renders pair-matched exposed and sheltered crowns from real annual state. A calm year leaves leeward crown axes at 12.48–12.73 degrees while the sheltered control stays upright. WebGPU and WebGL2 each repeat entire accepted snapshots and RGBA through hold, two restores, re-advance and rewind.
- Point 8 (1476595e04). `packages/biomes/scripts/bio03-forest-measured.mjs` compares 12 independent Douglas-fir survival values. The generic stand reproduces the final spacing rank, misses three of four year-40 reported intervals and overpredicts by up to 17.81 percentage points. A 5 to 10 cm initial-crown change moves the two-metre year-32 result by more than 24 percentage points. [Measured limits](limits.md#bio-03-douglas-fir-survival-in-the-wind-river-spacing-trial)

Layered light, surveyed allometry, species-specific growth and mortality calibration, and the original TREE-3 shot remain open. The row stays REOPENED at four points.

### BIO-04 Material ageing

#### BIO-04 four-point pass

- Point 5 (a9332e0abb). `packages/physics/tests/coupling/ageing.test.js` checks registered signed replay, foreign-memory exposure, invalid late rows, alignment and overflow with exact accepted history and surface. `packages/physics/tests/coupling/ageing-workers.test.js` rejects elapsed overflow on the remote odd tail without changing the accepted state or work receipt.
- Point 6 (a9332e0abb). `packages/physics/tests/coupling/ageing-workers.test.js` checks exact scalar and native 1/2/4 results across 129 and 173 mixed patches with snapshots and replay. `packages/physics/tests/ageing-workers.browser.mjs` exercises three concurrent Chromium helpers and records 128 SIMD-paired patches out of 129.
- Point 7 (a9332e0abb). `packages/physics/tests/ageing-film.browser.mjs` drives eight exposure bands from accepted HYDRO-01. A 118.08 mm gauge peak consumes 29.11 µm of steel at the base and leaves 42.51 µm retained oxide after drainage. The dry control stays unchanged and both renderers repeat complete accepted state and RGBA.
- Point 8 (a9332e0abb). `packages/physics/scripts/bio04-ageing-measured.mjs` compares independent Rapa Nui copper and Milan carbon-steel coupon losses. At years one and three, predicted copper losses are 1.26 and 2.83 µm against 2.10 and 3.75 µm measured. Milan predicts 5.28 µm against 6.92 µm at ten months, with first-year weather as a proxy. [Measured limits](limits.md#bio-04-measured-copper-and-carbon-steel-coupon-losses)

Spatial pitting and runoff streaks, laboratory appearance calibration, predictive site immersion current and biological supply remain open. The row stays REOPENED at four points.

### SPACE-02 Celestial ephemeris and rotation

#### SPACE-02 four-point pass

- Point 5 (bb86ef47c6). `packages/physics/tests/coupling/celestial.test.js` checks signed cells across restore, foreign aligned f64 fields, invalid layout, rejected epoch and nonfinite ephemeris. It compares the full accepted snapshot and native work receipt before and after rejection.
- Point 6 (bb86ef47c6). `packages/physics/tests/coupling/celestial-workers.test.js` checks eight Table 1 rows against the scalar formula at 100 epochs and exact world replay with 1, 2 and 4 participants. `packages/physics/tests/celestial-workers.browser.mjs` checks three concurrent Chromium helpers, with eight paired planet rows and 48 Newton updates per accepted analytic epoch.
- Point 7 (bb86ef47c6). `packages/physics/tests/celestial-film.browser.mjs` drives slope-aware collectors from registered native solar insolation. At 14.20° Sun elevation the true-tracking aperture is 69.00% shaded and the corrected aperture is clear, confirmed by independent rays and actual shadow-map pixels. Both renderers repeat the whole accepted snapshot and raw RGBA through seek.
- Point 8 (bb86ef47c6). `packages/physics/scripts/space02-celestial-measured.mjs` compares independently surveyed grazing eclipses with no fitted parameters. The model gives 65.75 s against 18.1 s at Cape Range and 168 s against 13.7 s at Stephenville. Both Stephenville contacts miss camera brackets. [Measured limits](limits.md#space-02-measured-eclipse-contacts-near-the-edge-of-totality)

High-precision apparent limbs and eclipse contact times, full Earth-orientation terms, two-way sea coupling and the original SOLARFIELD shots remain open. The row stays REOPENED at four points.

### SPACE-03 Accretion disks and compact objects

#### SPACE-03 four-point pass

- Point 5 (58d338d44e). `packages/physics/tests/coupling/accretion.test.js` checks signed foreign f64 supply, coded layout and range errors, accepted disk snapshots and receipts after rejected trials, and exact Kerr replay after rejecting an unresolved observer step.
- Point 6 (58d338d44e). `packages/physics/tests/coupling/accretion-workers.test.js` checks exact shared, plain and 1/2/4 native annulus runs and keeps the accepted bank and receipt during native phase overflow. `packages/physics/tests/accretion-workers.browser.mjs` measures 65 annuli, 64 paired rows and three concurrent Chromium helpers. Thomas, face and luminosity sums retain radial order.
- Point 7 (58d338d44e). `packages/physics/tests/accretion-film.browser.mjs` drives heat, density, differential winding and a Kerr tracer from actual published fields. The viscous disk accretes 2.013% and winds 2.888 rad relative to the outer ring at the winding probe. Each renderer repeats complete accepted snapshots and raw RGBA.
- Point 8 (58d338d44e). `packages/physics/scripts/space03-accretion-measured.mjs` uses separately measured stellar mass and distance to project traced vacuum widths, 52.080, 51.288 and 48.494 µas at spins 0, 0.5 and 0.9. The independent EHT emission diameter is 51.8 ± 2.3 µas. Comparing the two observables leaves emission validation open. [Observed limits](limits.md#space-03-observed-sagittarius-a-emission-and-exterior-geodesic-widths)

A relativistic disk heat and stress closure, emission and light transfer, the original Event Horizon binding and measured transport validation remain open. The row stays REOPENED at four points.

### LIFE-01 Legged locomotion

#### LIFE-01 four-point pass

- Point 5 (5123bed666). `packages/physics/tests/coupling/legged.test.js` covers signed stage contacts and deck impulses. It rejects a bad rigid offset, a later invalid or reentrant bed callback and misaligned borrowed controls. Rejection retains exact accepted drive, pose, anchors, contacts, gait and work; valid foreign rows replay byte-for-byte.
- Point 6 (5123bed666). `packages/physics/tests/coupling/legged-workers.test.js` and `packages/physics/tests/legged-workers.browser.mjs` exercise mixed batches of 73 and 117 bipeds and quadrupeds with signed live terrain and applied loads. Existing native SIMD computes 291 and 467 contact rows with 127 and 204 paired stance dots. Complete snapshots and reactions agree at 1, 2 and 4 participants, including three concurrent Chromium helpers.
- Point 7 (5123bed666). `packages/physics/tests/legged-film.browser.mjs` places the weighted horse from actual accepted body and contact ports. The same drive produces a level trot and a walk on a 13% uphill slope, with loaded hoof pads fixed to accepted contact points. Both renderers replay the complete solver state and raw RGBA.
- Point 8 (5123bed666). `packages/physics/scripts/life01-legged-measured.mjs` compares measured walk and trot from 62 instrumented horses. Using cohort mass and mean speed only, the default representative bodies cycle 7.6–12.7 strides/min faster and put 13.1–15.6 percentage points less vertical impulse on the forelimbs. The gap persists over speed and leg-length sensitivity. [Measured limits](limits.md#life-01-measured-treadmill-gait-and-forelimb-loading)

Articulated gait, measured conformations and fore-hind load distribution, original films, rider and water exchanges remain open. The row stays REOPENED at four points.

### LIFE-05 Pedestrian dynamics

#### LIFE-05 four-point pass

- Point 5 (8bdf2ce5cf). `packages/physics/tests/coupling/pedestrians.test.js` checks signed borrowed input, an invalid late ground sample, reentrant target refusal, and exact replay after plain memory growth. Invalid candidates preserve accepted contacts, poses, route and native work.
- Point 6 (8bdf2ce5cf). `packages/physics/tests/coupling/pedestrian-workers.test.js` and `packages/physics/tests/pedestrian-workers.browser.mjs` exercise the exact native drive and wall integration at 1, 2 and 4 participants. The 79-walker example does 158 wall checks and 1,461 SIMD dots. Neighbour reductions and pair impulses retain their order. Complete snapshots repeat across memory modes and three concurrent Chromium helpers.
- Point 7 (8bdf2ce5cf). `packages/physics/tests/pedestrian-film.browser.mjs` drives articulated walkers from signed accepted NavMesh poses and walking distance. In the matched day-to-day crossing, the approach check gives its analytic 1.765 s to contact and 0.4838 N equal and opposite force. Both renderers replay accepted state and raw RGBA exactly.
- Point 8 (8bdf2ce5cf). `packages/physics/scripts/life05-pedestrian-measured.mjs` compares independent single-file timings from Seyfried et al. The solver holds 1.318 m/s in both 15- and 20-person cases. Their measured speeds fall to 0.90 and 0.56 m/s. The station count and reconstructed-bend sensitivity are recorded. [Measured limits](limits.md#life-05-measured-single-file-walking)

Steady headway-speed response, original film bindings and the remaining audit items stay open. The row stays REOPENED at four points.
