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
  flooding. General shell contact, automatic tearing, and measured full-scale vessel and vehicle response remain open.
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
An offset swimming origin now produces identical parcels and packed-bed debit when translated along all three
cell axes. The same test restores the snapshot and repeats the following ticks exactly.
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
A fixed-volume waxy film now reports its thickness and follows the Brönner Bingham yield force. Nine independent
tank terminal radii lower the RMS log radius error from 1.056 to 0.480 compared with Fay's unyielded radius at the
reported 180 s measurement time. The simulated 30% blend under-spreads by a factor of 3.59 against the run that
fractured. The constant-rate gravity-driven patch now covers the unyielded MGO tank release through shutoff. Its
six independent radii give 0.134 m RMS error, compared with 1.081 m for the same oil released instantly. Waxy
continuous flow, fracture, field extent and independent evaporation validation remain open.

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
is a 5.01-fold underprediction in the fall profile. Aggregate-size growth and the fall transport remain open.

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
1. **The cross-scale refusal misses the tide.** `CelestialSolver` takes a `timeScale` parameter (`space/solver.ts:83`, used at line 264) but does not declare `timeScale()` in its description, so the world cannot see its scale. A sped-up water reading the world's tide through the surge is not refused when the celestial solver runs at another scale. `tests/coupling/surge.test.js` builds that very world without an error: the celestial solver at 3600, the water and the surge at 1. Declare the celestial scale, refuse the mismatch with a test, and fix the coupling test's world.
2. **The surge's pressure and wind run on two clocks.** The surge's `pressure` function gets the water's time, but the water's `wind` is read at the world's time. One storm's pressure and wind therefore drift apart by the time scale unless the caller converts the wind by hand, as `windOf` does in `surge.test.js`. A wind field with no `timeScale` property is accepted silently by a sped-up water. Put both on one clock, or refuse a scaled water given an undeclared wind or rain, with a test.
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
