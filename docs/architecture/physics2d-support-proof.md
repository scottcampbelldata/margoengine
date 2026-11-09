# Own 2D sustained support

This note derives the correction to the contact support ceiling found on
`47f81f909`. It concerns the owned Rust/Wasm kernel, not the Rapier facade.
The recovery speed, spring settings, substeps, iteration count, sleep settings
and all physical acceptance predicates are retained. Owned-2D CCD is separate
T-11 / 127.y work.

## A recovery cap must not cap elastic support

For normal impulses `l`, let `K = J M^-1 J^T`, `v` be current relative normal
velocity, and `l0` the accumulated impulse already included in `v`. The current
point compliance is `Cii = Kii * impulse_scale / mass_scale`; signed gap is `s`
and bias rate is `beta`. The old closed-row residual is

```text
F(l) = v + K(l-l0) + max(beta*s, -P) + C*l.
```

At stationary positive support this requires `C*l <= P`. With default
`P = 3 m/s`, four substeps and the existing damping, an internal point cannot
support the 1002 kg column load: it needs 3.021895 m/s of elastic bias. The
ceiling is approximately 994.74 kg. More visits cannot remove this equilibrium
defect. Raising P only moves it.

The corrected recovery-capped complementarity law is

```text
F(l) = v + K(l-l0) + max(beta*s + C*l, -P),
l >= 0, F >= 0, l_i*F_i = 0.
```

For `P > 0`, stationary positive support has `max(beta*s+C*l,-P)=0`, hence
`beta*s+C*l=0`. There is no cap-imposed maximum elastic load. This statement
is about feasible contact geometry and representable derived state; it cannot
promise unbounded binary32 magnitudes or lateral stability of any geometry.
Zero recovery speed is supported as an explicit user setting, without the
strict-positive-P uniqueness implication.

Each max is continuous and monotone. For fixed geometry the system is the KKT
condition of a convex quadratic plus the integral of those max functions.
Positive-definite K gives a unique impulse; redundant rows need not do so.

For a scalar row, the exact real root is

```text
lsoft = (K*l0-v-beta*s)/(K+C)
lcap  = l0+(P-v)/K
lnew  = max(0, min(lsoft,lcap)).
```

For two coupled points, a componentwise minimum is incorrect. Enumerate the
zero, soft and capped state of each row (nine cases), solve its principal
system, then certify nonnegativity, residual and branch membership. The common
uncapped f32 solve is usable only with finite intermediate arithmetic and a
cap certificate. Exceptional coupled roots use f64 arithmetic and forward-error
and output-rounding certificates. Unrepresentable results return the checked
arithmetic error; NaN is never converted into a zero impulse. Open speculative
rows and unbiased relaxation retain their hard equations.

## Removing the ceiling does not remove slow equilibrium modes

Even exact biased and hard-relaxing solves can retain slow compliant settling.
For a fixed supported active set, let `B=diag(beta)`, and assume the normal
subspace was relaxed to zero velocity. With substep h and gap error e from the
original compliant root, the split map is

```text
e_next = [I - h*K*(K+C)^-1*B] e.
```

For constant beta, a generalized eigenmode `K*z=kappa*C*z` contracts by
`1-h*beta*kappa/(1+kappa)`. An increasingly heavy payload can make kappa small.
An exact local cap or exact hard relaxation therefore does not establish the
unchanged one-second creep bar. Raising damping or fitting a mass threshold
would not address this argument.

The implementation corrects this equilibrium mode on a certified supported
contact path. Eligibility is structural: one static terminal, dynamic path,
no joint, no branch/cycle/multiple anchor or kinematic/sleeping terminal.
Graph ownership, joint membership, mass weights, immutable original approach
and nonzero restitution exclusions are planned once each frame. Nonzero
restitution retains the general NCP; a coupled impact solve is not claimed.
Changing geometric, rank, closure, force/torque and cone conditions are
certified again at each substep. Other components retain the general capped
dynamics. Frames with no eligible path skip the extra substep snapshots and
path synchronization entirely.

Working leaf to root, balance external gravity and transmitted force/torque
to obtain nonnegative normal support impulses `lg`. This calculation includes
gravity_scale and does not treat impact-containing cached impulses as load.
Use the existing spring root `s* = -C*lg/beta`, with `lg = h*force`.
The current geometric Jacobian gives the physical-mass least-norm correction

```text
K*mu = s*-s
dx = M^-1*J^T*mu.
```

A banded factorization exploits only the certified path topology. An exact
parallel two-point recurrence is an algebraic specialization, preserving
symmetry without snapping small values to zero. It is not a claimed work
reduction: the current implementation still computes the general banded
systems. For frozen geometry and an
accepted common fraction alpha, the error becomes `(1-alpha)*e`, independent
of payload mass. Alpha limits geometric recovery to the existing `P*h` point
displacement budget. This is a local linear statement; it is not a global
nonlinear convergence guarantee.

Physical velocity/cache projection uses the step-start Jacobian matching the
original applied impulses. The current-pose Jacobian is used for geometry.
The staged proposal must preserve unilateral feasibility, finite rotation and
cast bounds, retained nullspace motion, friction and residual certificates.
Restitution remains last. Immutable pre-step approach evidence prevents other
islands' joints from changing the separation decision. No partial proposal is
published if a certificate fails. Zero recovery speed declines correction.

Sleep observes the maximum actual substep pose rate, including correction and
extent times rotation, as well as the final relaxed speed. Hard relaxation
cannot conceal continuing movement. Existing island sleep/wake propagation,
threshold and sleep time are unchanged.

## Axial support and lateral stability are different properties

The preserved point law has stiffness `k(q)=omega^2/Kii(q)`, dependent on
geometry. Its loaded force tangent includes the derivative of Kii and of the
force directions. The exactly centered 1:1000 column has a negative sticking
bending direction under that law. A separate own-manifold finite-difference
probe checks this derivative for both retained face histories. It also checks
the stable 1:100 control. This is a constitutive stability limit, not evidence
that every discrete terminal fall follows an exact physical trajectory.
No additional angular stiffness, mass cutoff or damping was introduced to hide
it. Centered axial sag/creep/sleep tests do not establish arbitrary lateral
stack stability. See [the full derivation and static-force probe](physics2d-support-bending.md).

## Work and acceptance boundaries

Ordinary contacts retain SIMD uncapped arithmetic when finite-domain and cap
certificates hold; exceptional lanes alone use scalar/f64 active-set work.
Private per-visit shadow tests compare every live lane with that reference,
including intermediate motion, caches, pushed flags and work counts. In the
unchanged pyramid's frames 60 through 99, the combined diagnostic records
2,392,000 common biased visits and zero exceptional visits, with the same
counts for relaxation. This avoids the earlier correctness reference's
per-lane scalar record materialization, not a proof of browser speed.

The path planner is once per frame and linear in bodies, contacts and joints.
Accepted components still use temporary local buffers, two banded
factorizations and staged geometric/friction certificates each substep.
The audit counted at least 27 nonempty vector buffers per accepted component
per substep. There is no allocation-free or speed-parity claim. The general
branching pyramid does not perform these path substep solves.

The native mandatory 1:1000 regression is the existing 1:100 fixture with only
payload/load terms, name and output label changed. Sag, top drift, creep and
sleep predicates are unchanged. Wasm `check(0)` also runs those two stack bars
with the identical 599-step truncation and before-step-60 sample. Native
scalar/SIMD and shipped Wasm SIMD produce identical metrics. The archived
input-fixed main `147c6d33a`, given only that new checker/helper, fails this
check with code 4 while retaining its three original scene hashes. The support
correction deliberately re-pins only the mixed scene; other physical bars and
the retained manifold reference remain required.

## Sources and boundaries

These sources were read as papers, theses, talks and author prose before
design. No other engine's source or implementation snippets were used.

- [Catto, Soft Constraints, GDC 2011](https://box2d.org/files/ErinCatto_SoftConstraints_GDC2011.pdf)
  defines the local spring/damper model. [Understanding Constraints, GDC 2014](https://box2d.org/files/ErinCatto_UnderstandingConstraints_GDC2014.pdf)
  treats mass-ratio propagation. [Solver2D, 2024](https://box2d.org/posts/2024/02/solver2d/)
  distinguishes softness, retained-anchor substeps and relaxation. None proves
  the new capped law or Margo's transient acceptance.
- [Macklin et al., Small Steps, SCA 2019](https://mmacklin.com/smallsteps.pdf)
  distinguishes small-step numerical damping and recovery effects.
  [XPBD, 2016](https://mmacklin.com/xpbd.pdf) motivates an explicit compliance
  and force law, not an automatic equivalence with this impulse solver.
- [Macklin et al., Primal/Dual Descent, 2020](https://mmacklin.com/primaldual.pdf)
  and [Non-Smooth Newton Methods, 2019](https://arxiv.org/abs/1907.04587)
  discuss conditioning and coupled complementarity. [Preclik's 2008 thesis](https://www10.cs.fau.de/publications/theses/2008/Preclik_DA_2008.pdf)
  distinguishes residual, active-set and velocity convergence.
- [Baraff, SIGGRAPH 1996](https://publications.ri.cmu.edu/storage/publications/pub_files/pub2/baraff_david_1996_1/baraff_david_1996_1.pdf)
  supports exploiting acyclic structure; it does not give a linear-time direct
  solve for general contact graphs. [Guendelman et al., SIGGRAPH 2003](https://physbam.stanford.edu/papers/stanford2003-01.pdf)
  illustrates the feedback risks of freezing support bodies. Physical masses
  are retained here.
- [Andrews, Teichmann and Kry, 2017](https://www.cs.mcgill.ca/~kry/pubs/eg17/eg17.pdf)
  identifies geometric force derivatives. Its adaptive numerical damping does
  not prove that the preserved compressed-column model is laterally stable.

The cap, split-map and certified-path conclusions above are Margo derivations
with stated assumptions, rather than claims attributed to those sources.
