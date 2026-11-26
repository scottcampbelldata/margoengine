# Physics solver audit

Each landed physics solver is judged against its catalog row in [physics-solvers.md](physics-solvers.md), the floor in
[physics-work-queue.md](physics-work-queue.md#what-every-solver-must-do) ("What every solver must do") and the
eight-point standard in the same file, "The standard: the best solver we can build". A solver that falls short is
REOPENED in the work queue, with its owner unchanged, and the missing pieces named here are its work list.

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
  single load on a shared flat edge or vertex. Arbitrary rigid shapes, automatic tearing,
  full-scale vessel response and broader vehicle coverage remain open.
  [Model-ship evidence](whitepaper/reproduce.md#break-03-held-out-model-ship-contacts) ·
  [Folded-shell evidence](whitepaper/reproduce.md#break-03-folded-shell-contact)
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
| DYN-04 wheeled vehicles on roads (`physics` tyres, vehicle, drivetrain, motorcycle, tracked; `road/driving`) | THIN | 1, 2, 3, 4, 5, 6, 8 | Analytic and tight for the driver: `road/tests/coupling/road-driver.test.js` "Coulter goal curvature" (steer = atan(L/R) to 2⁻²⁹, target speed √(μgR) to 1e-9) and "favourable bank" (FHWA 2010 force balance, 1e-10); `road/test/driving.test.js` analytic Bekker sinkage (1e-4). Vehicle tests use arbitrary bands: braking 14-24 m against v²/2μg ≈ 17.5 m, cornering 4-13 m/s², launch 1.0-3.5 m/s. No measured tyre or vehicle data. | The tyre is the 1992 sine Magic Formula with a friction-ellipse rescale (`tyres.ts:4-7, 66-112`); MF 6.x combined-slip weighting, dfz and pressure terms, camber, aligning moment and pneumatic trail, relaxation length, rolling resistance and turn slip are absent. Horse-drawn carts absent; per-surface grip (asphalt, gravel, dirt, cobbles) is caller-supplied with no data behind "measured"; no test near the grip limit; Hoffmann/Stanley controller cited, not built; no suspension kinematics; no EARTH-05 or LIFE coupling. | Suspension stiffness is per kg of chassis, not N/m (`vehicle.ts:770`, default 5.88 at `:393`); `inverse = 10` fudge for steep normals (`vehicle.ts:762`); 6000 N force cap and 5 m travel default (`:396-397`); silent 0.2 floor on load sensitivity (`tyres.ts:98`); uncited default coefficients (`tyres.ts:48-50`); host `Math` transcendentals in state-feeding code (`tyres.ts:64-65`, `vehicle.ts:597-600`, `motorcycle.ts:160-180`, `tracked.ts:86`) that `check:pinned-math` does not scan. | MF 6.2 (Pacejka 2012, ch. 4 and 7; Besselink, Schmeitz and Pacejka 2010, Vehicle System Dynamics 48) with the current models as the fast tier; TMeasy-class handling; kinematic suspension. Validate against Pacejka 2012's published MF sample coefficient set and ISO 4138, ISO 7401 and ISO 3888 manoeuvres. Rivals: MF-Tyre/Delft-Tyre, Chrono::Vehicle (TMeasy, SCM soil), Havok/Babylon and cannon raycast vehicles. |
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

### SEA-09 Ships under way, manoeuvring (`@margoengine/physics/ship`, commits ebfc65dbb, 3c2f57931, 7fc896c99, 663671e17, f4c07368e), owner Codex: REOPENED

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

### SEA-15 Tracers and slicks in water (`@margoengine/physics/tracers`, commits ccbc86285 to 03332d94c, 28 SEA-15 commits since 2026-11-25), owner Codex: not VERIFIED, status left BUILDING

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

### FLUID-07 Thin films and droplets (`physics/thin-film`, commits 75f931cd2 through 3cb9cb3eb, 25 commits tagged FLUID-07), owner Codex: not VERIFIED, status left BUILDING

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

### BREAK-03 Ductile crushing: hulls, car bodies, rail cars (`physics/crush`, commits 25759ed00 9ef07dff9 28668a645 b7472cd5b da07f5d54 f1e1145da dc0dfa8ef a0325f916 116d3054e 408e506ac 64367a884 168006e3c 1b1a25c61 0fc03c638 24e67d6ff e5a8d911a f39137bee 6fbbf8e86 fa058693d dd6d4b7f2 f82be85af 8300fcbe0 3701ff631 ecd6f501f cf8fb2938), owner Codex: not VERIFIED, status left BUILDING

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
