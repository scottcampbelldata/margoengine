# 2D solver study, 2026-11-08

**Decision: stop solver microtrials. No solver candidate was accepted, and zero result-changing hash re-pins were accepted.** Production pins and solver source remain unchanged. All timings below are loaded-machine diagnostics, not release speed claims. The separately accepted exact narrow-phase change is described in perf history entry 101; it retains the original block solver and all production pins.

Research and the sourced design note preceded implementation. It surveyed public papers, theses, GDC/SIGGRAPH talks and prose only: Catto 2006/2009/2011/2014/2024, Small Steps, rigid XPBD, shock propagation, complementarity/conditioning, Primal/Dual, Newton and VBD/AVBD. No engine source was used. The relevant conclusion was to test point constraints while retaining all accuracy bars; Catto's prose explicitly trades block-solver stacking strength for cheaper point constraints. Persistent colouring, load conditioning and Jacobian reassociation are separate hypotheses, not automatic consequences of that literature.

## Acceptance baseline and gaps

- The immutable `7fd5a9547` **block control passes all 28 original legacy cases**. The additional 1:1000 **contact** fixture is a new extension of the existing 1:100 contact fixture, not an old passing bar. It retains the same 3% closed-form sag, 0.1 mm x drift, 10 mm post-1-second creep and sleep predicates. Baseline fails sag (1.186208 m versus 0.518551 m) and creep (92.105 mm). See `solver-bars/control-block/results.json`.
- The existing 1000:1 **joint chain** is a different, passing legacy case. No owned-2D CCD API/implementation/acceptance fixture was established; speculative contacts do not establish CCD. Neither gap was waived, newly declared passing, or used to justify a re-pin.
- The contact bias clamp also caps sustained spring support: at default settings a middle row needs 3.021895 m/s bias for its 1002 kg load, above `max_push=3`; theoretical support ceiling is about 994.74 kg. Raising the cap to 3.1 diagnoses capacity but fails creep (555.621 mm). A derived support-residual cap removes the ceiling and passes all 28 legacy cases, but still fails the new 1:1000 creep bar (109.298 mm). Removing the cap gives the same output. Damping/iteration probes did not provide a valid fix; no impossibility claim was made. Exact capped complementarity math and evidence are in `support-study/findings.md`.

Rejected candidate sources and logs are retained in Lane P, with the paths below relative to `.lane/p/`; they are not shipped solver options. The [committed diagnostic record](../whitepaper/results/physics2d-certified-faces-20261108.json) contains the raw paired rounds, phase results, complete block/point accuracy comparison and browser results. Paired rows use one process, fresh 100-row worlds, 60 settling steps, minima of 40 sampled steps and 24 balanced/alternating rounds, unless explicitly marked “not timed.” Values `old → new; wins` are minimum milliseconds and candidate wins out of 24, not differences of paired medians. Compare only within a recorded session.

## Experiments and disposition

| Variant / source | Accuracy and output status | Paired result / primary evidence | Decision |
|---|---|---|---|
| Exact direct rows + four-state determinant cache, A1/A2 (`rejected-live-setup`, then isolated setup sources) | Original native/Wasm pins unchanged; kept-row, matrix-state, mixed-tail/overflow/restition tests pass | 2.978→3.122, 9 wins (`setup-ab.log`); final A2 3.084→3.276, 7 (`setup-a2-ab.log`) | Reject slowdown. Reciprocal multiplication was correctly excluded from this exact phase. |
| Exact rows-only / matrix-only / combined (`setup-variants/{rows,matrix}`) | Original three pins pass | Same-session baseline 2.8759; rows 2.9254, 8 wins; matrix 2.9538, 6; combined 3.0046, 7 (`setup-ab-variants.log`) | Reject all. |
| SIMD row setup and optional setup inlining (`setup-variants/{simd-rows,inline-rows}`) | Original scalar/SIMD/Wasm pins pass; independent row-field/mask/tail tests pass | SIMD rows 3.015→2.986, 9 wins (`simd-rows-ab.log`); inlining built/checked, not separately timed | No convincing gain. Profile moved cost from row setup into scattered wide construction. |
| Exact coherent-order colour reuse (`coherent-colour`) | Original Wasm pins and eight common tests pass | No cache hits through step 210; target measured steps 60..99 save no work (`coherent-colour-count.log`) | Stop before timing. |
| Exact per-body incidence certificate (`exact-colour-incidence`) | Certificate unit passes; no Wasm/pin claim | Stable graph in all 40 target frames, but zero certificate hits and 598,000 rebuilt rows (`rejection.json`) | Stop: no work avoided. |
| Original per-point solve (`solver-control`, point mode) | Fails existing 1:100 creep: 35.597 mm >10; seam box vertical speed 8.518784e-5 >7.44e-5 m/s. New 1:1000 collapses about 3 m | `solver-bars/control-both-v2/results.json`; not timed for acceptance | Reject accuracy. |
| Reversed point order (`point-reverse`) | Still fails 1:100 creep 34.864 mm and seam vertical speed 2.3164874e-4 m/s; new 1:1000 collapses | `solver-bars/point-reverse-v1/results.json`; not timed | Reject accuracy. |
| Load/eighth-spring hybrid (`hybrid`) | Fails existing 1:100 x drift: 6.547 mm >0.1; creep itself is 3.030 mm. Also violates force-block count contract; new 1:1000 fails | 2.8859→2.8765, 12 wins (`hybrid-ab.log`) | Reject accuracy and no robust gain. |
| Island-mass conditioned point/block hybrid (`hybrid-islands`) | All 27 legacy physical cases pass; the 28th case's unchanged force-block count assertion fails. New 1:1000 still fails. Native scalar/SIMD/Wasm H hashes agree | 3.0006→3.1120, 12 wins (`islands-ab.log`) | Not accepted: API/count contract unresolved, speed unconvincing. |
| Point-major interleaving across independent blocks (`hybrid-interleave`) | Bit-identical to island hybrid H; 12,288 directed samples, counts and native/Wasm hashes agree | Trio: block 3.4054, island 3.2925 (9 wins vs block), interleaved 3.0357 (15 vs block and parent), `interleave-trio.log` | Interesting minimum, insufficient paired/browser evidence; inherited acceptance gaps remain. |
| Persistent graph colouring (`hybrid-persistent`) | Adds a legacy failure: sleep-off 20-row sag 29.450387 mm >29.11. Also inherits force-block and new 1:1000 failures | Graph-independence unit passes; no Wasm/hash/timing after quality failure (`rejection.json`) | Reject immediately; independence alone does not preserve propagation quality. |
| Grouped normal Jacobian, block solver (`normal-jacobian`) | All 28 legacy cases pass; new 1:1000 fails as control. J hashes agree native scalar/SIMD/Wasm | 3.1947→3.1982, 13 wins (`jacobian-ab.log`) | No convincing gain. |
| Same Jacobian with SIMD row construction (`jacobian-simd`) | All 28 legacy cases pass; J hashes unchanged from Jacobian control; eight tests include every LCP active set, mixed masks and forced unanswered-case fallback | 2.9124→2.8366, 16 wins (`jacobian-simd-ab.log`) | Modest diagnostic advantage, not accepted as a robust browser win. |
| Two-state reciprocal cache over Jacobian (`normal-jacobian/reciprocal`) | All 28 legacy cases pass; R hashes agree. Guard retains original division for zero/nonfinite reciprocals; tiny-determinant finite-impulse regression and 6,912 state selections pass | 3.0267→3.1217, 13 wins (`reciprocal-ab.log`) | Reject. Four-state storage and a single fixed inverse were not assumed free. |
| Point-pair Jacobian / K12 update / grouped application (`hybrid-jacobian`) | All 27 legacy physical cases pass; force-block and new 1:1000 failures inherited. Q hashes agree; 7,680 directed cases and 40-frame complete contact/visit count regression pass | Trio: block 3.7408, exact axis-SAT control 3.4597 (14 wins), hybrid Jacobian 3.7071 (11 vs block), `latest-trio.log` | No compelling gain; stop math reassociation trials. Axis SAT is a separate exact narrow experiment, not a solver acceptance. |
| Outline coupled `wide::normal` on original block (`block-outlined`) | Sole inline annotation changes; old native scalar/SIMD/Wasm pins pass; source audit proves no other change | 3.2332→3.2364, 6 wins; paired median delta **+0.2007 ms** (`outlining-ab.log`) | Reject despite hot function shrinking 20,579→10,597 bytes. |
| Same outlining on interleaved hybrid (`hybrid-outlined`) | H hashes exact; 12,288 directed samples pass; source audit proves sole annotation change | Parent minimum 3.5287→3.1612, only 11 wins vs parent, 8 vs block; paired median delta vs block **+0.09725 ms** (`outlining-ab.log`) | No convincing gain despite hot function shrinking 26,177→15,128 bytes. ABI/spill overhead is plausible, not a measured root cause. |

## Paired phase result: forecast 0.5 ms was not established

`hybrid-probes/results.json` / `findings.md` instrument block, island hybrid and interleaved hybrid at identical boundaries. All explicit unsigned hashes pass. All sampled steps retain 5,050 awake bodies, 14,950 contacts/manifolds, eight colours, no overflow and 119,600 two-point normal visits. The hybrid replaces 118,800 visits (99.3311%) with point constraints; it removes no contact or row. Each module has the same 55 clock imports per default step, including whole warm/biased/relax calls and integration loops; no row clocks.

Hybrid-minus-block paired median: biased wide **−17.151 µs** (17/24 wins, IQR −40.524..+0.674); relaxing wide **−19.700 µs** (21/24, IQR −65.900..−11.650). Thus only about **37 µs** is observed across those wide phases, versus the forecast 500 µs. Total substeps save 34.600 µs (19/24), while conditioning/body-placement adds 8.900 µs (0/24 wins) and row build/policy adds 18.201 µs (6/24). Overall solver paired median is −10.200 µs with IQR −104.125..+72.550: inside spread. Interleaving adds no reliable gain in the matched phase run (biased 12/24 wins, relax 9/24). Independent per-phase minima/medians must not be summed as an exact step accounting identity.

Point constraints retain gather/scatter, gap updates, both friction rows, warm start and both normal impulses, and point 1 depends on point 0's update. These are source-supported explanations for non-proportional savings, not separately timed instruction costs. The original hybrid also computes block K before disabling block mode. Smaller code and fewer source operations alone did not prove speed.

## Browser outcome and diagnostic hashes

Interleaved hybrid, 12 rounds, unchanged scene (`browser-candidate.log`): Edge 157 WebGPU Margo **3.06 ms**, Box2D v3 Wasm **1.66**, Rapier 0.21 **12.13**; Firefox 157 WebGL2 Margo **3.26**, Box2D **1.48**, Rapier **10.92**. Margo beats Box2D in **0/12 rounds** in each browser. Edge WebGPU/WebGL2 and Firefox WebGL2 diagnostic hashes pass; Firefox WebGPU has no adapter and is **NOT RUN**. Browser goal remains unmet. Separate sessions have different load and are not a controlled before/after speed claim.

All named values below are **experimental evidence only**; native scalar/SIMD and Wasm agree for J/R/H/Q. Production manifest retains B. Early logs sometimes printed signed i64 hexadecimal; comparisons and the values here use unsigned 64-bit values.

| Label | Pyramid / joint grid / mixed |
|---|---|
| B — original pins | `9ffefc83c3a99be4 /95a47530df180011 /9acb68471fbe6ba0` |
| J — block Jacobian and SIMD-setup Jacobian | `8204df63f73d17a5 /95a47530df180011 /dffd3c3c2ccb9696` |
| R — guarded reciprocal | `23cbd73a957d3e5e /95a47530df180011 /9a25cfdedfa2188c` |
| H — island hybrid, interleaving and its outlining | `e5bfda97b67d1775 /95a47530df180011 /db8ed688217cdf1f` |
| Q — hybrid point-pair Jacobian | `e8c7f652f1d1257e /95a47530df180011 /6536ce899e2efaeb` |

Original `check()` failures for changed diagnostics were recorded rather than silently re-pinned. Every full accuracy collector retained its nonzero status on failure; no assertion, tolerance, budget or scene was weakened. Exact variants keep B or their explicitly identified H parent. **No diagnostic hash became an accepted production re-pin.** Sources, test logs, raw paired rounds and rejection files remain in the named isolated directories. The initial partial scalar-only residual-cap run is invalid candidate evidence; use `support-residual-cap-v2`. The initial unguarded reciprocal artifact is superseded by the positive-finite guard/setup-proof version. No further solver experiments are planned in this round.

## Literature used before the designs

1. [Catto, Releasing Box2D 3.0 (2024)](https://box2d.org/posts/2024/08/releasing-box2d-3.0/): Soft Step combines
   substeps and soft constraints. The author accepts weaker vertical stacking than the former NGS block solver
   in exchange for cheaper contacts. That supports a point-contact experiment, not a prediction that our severe
   vertical-stack bars will hold. [Solver2D (2024)](https://box2d.org/posts/2024/02/solver2d/) distinguishes point
   and two-point block methods, relaxation and persistent friction-anchor variants. Keep these variables separate.
2. [Catto, SIMD Matters (2024)](https://box2d.org/posts/2024/08/simd-matters/): independent graph colours allow
   wide constraint processing; its pyramid has the same 5,050 bodies and 14,950 two-point pairs. Persistent
   colouring removes repeated graph work, but would alter our gravity-sorted visit order. Treat it as a separate
   result-changing experiment, not part of the bit-identical setup trim. Published native timings do not prove a
   browser Wasm result or establish that point constraints alone close our loss.
3. [Catto, Sequential Impulses, GDC 2006](https://box2d.org/files/ErinCatto_SequentialImpulses_GDC2006.pdf),
   [Modeling and Solving Constraints, GDC 2009](https://box2d.org/files/ErinCatto_ModelingAndSolvingConstraints_GDC2009.pdf)
   and [Soft Constraints, GDC 2011](https://box2d.org/files/ErinCatto_SoftConstraints_GDC2011.pdf): preserve contact
   identity, accumulated-impulse clamping, corrective negative increments, warm starts and Coulomb load bounds.
   Effective mass includes rotation and contact location. Frequency/damping are meaningful spring parameters;
   stability alone is not sag accuracy. [Understanding Constraints, GDC 2014, slides 27–33](https://box2d.org/files/ErinCatto_UnderstandingConstraints_GDC2014.pdf)
   demonstrates mass-ratio and propagation limits of SI, making long stacks essential evidence.
4. [Macklin et al., Small Steps, SCA 2019](https://mmacklin.com/smallsteps.pdf): more substeps with one XPBD
   iteration can outperform the same iterations in one large step, including a 1:1000 chain and loaded stacks.
   Velocity-dependent effects benefit differently; order and floating-point resolution still matter. We already
   use substeps. Do not reduce their count or infer impulse-solver equivalence from XPBD's examples.
5. [Müller et al., Detailed Rigid Body Simulation with XPBD, 2020](https://diglib.eg.org/items/114b20b0-8543-4c54-bd04-42ee60c71946)
   updates nonlinear constraint directions in local projections. It motivates a positional alternative if needed,
   but small steps do not replace CCD and a rewrite must re-establish restitution, joints and friction.
6. [Guendelman, Bridson and Fedkiw, SIGGRAPH 2003, section 8](https://physbam.stanford.edu/papers/stanford2003-01.pdf)
   uses contact graphs and shock propagation for stacking, while warning that freezing support bodies too early
   removes load feedback (the seesaw case). Mass freezing is not an acceptable unmeasured sag patch.
7. [Erleben, PhD thesis 2005, author's abstract](https://researchprofiles.ku.dk/en/publications/stable-robust-and-versatile-multibody-dynamics-animation/)
   covers contact graphs, iterative complementarity and sleep. [Preclik, Iterative Rigid Multibody Dynamics,
   thesis 2008, sections 4–6](https://www10.cs.fau.de/publications/theses/2008/Preclik_DA_2008.pdf) finds block
   variants can reduce iterations at additional local cost; convergence, velocity error and active-set behaviour
   are distinct measurements. [Andrews, Erleben and Ferguson, SIGGRAPH course 2022](https://erleben.github.io/pubs/2022/andrews.ea22/andrews.ea22.pdf)
   similarly identifies PGS ordering and large mass ratios as convergence risks.
8. [Baraff, SIGGRAPH 1996](https://publications.ri.cmu.edu/storage/publications/pub_files/pub2/baraff_david_1996_1/baraff_david_1996_1.pdf)
   gives a linear-time direct method for acyclic equality constraints; contact/loop auxiliaries add a reduced
   problem. It does not establish a general linear-time solve for a densely contacting pyramid.
9. [Macklin et al., Primal/Dual Descent, 2020](https://mmacklin.com/primaldual.pdf) demonstrates complementary
   mass- and stiffness-conditioning failures, including a 4096:1 contact stack. [Non-Smooth Newton Methods,
   2019](https://arxiv.org/abs/1907.04587) adds global linear solves and complementarity preconditioning.
   These are alternatives if local constraints cannot meet the bars, not free substitutes for point rows.
10. [Chen et al., Vertex Block Descent, SIGGRAPH 2024](https://graphics.cs.utah.edu/research/projects/vbd/vbd-siggraph2024.pdf)
    and [Giles, Diaz and Yuksel, Augmented VBD, SIGGRAPH 2025](https://graphics.cs.utah.edu/research/projects/avbd/Augmented_VBD-SIGGRAPH25.pdf)
    address robust positional solves and harder constraints. Their GPU evidence does not predict CPU/Wasm speed.
    Persistent tangential anchors are relevant to creep, but would require an independently measured change.

## Correctness follow-up after the study

The manager made the 1:1000 contact extension mandatory and kept CCD in T-11 / 127.y. The subsequent
[sustained-support correction](physics2d-support-proof.md) fixes the recovery-cap force ceiling and the slow
supported-path equilibrium mode while preserving the original spring root and every physical predicate.
The mandatory native regression is red on 47f81f909 and passes with the correction; all 29 physical cases pass.
This result-changing fix intentionally changes only the mixed-scene pin. The earlier experiment rejections
and measurements above remain historical evidence, not accepted production variants or current speed claims.
The [bending analysis](physics2d-support-bending.md) distinguishes constitutive lateral instability from axial
support and from discrete solver defects. Browser Box2D parity remains unproven.
