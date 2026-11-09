# Bending tangent of the supported four-box column

The centered 1:1000 column has a negative bending direction under Margo's
existing steady contact force law. The calculation includes the derivative of
the geometry-dependent inverse effective mass, as well as the change in force
direction and moment arms. Direct evaluations through Margo's public collision
API reproduce that sign. This establishes a local constitutive tangent; it
does not establish the discrete solver's amplification, growth rate or terminal
collapse trajectory.

The centered 1:1000 sag, drift, creep and sleep bars remain required. This note
adds neither a passing instability condition nor permission to loosen any bar.
An axial support root and its lateral bending stability are different questions.

## Model and method

The derivation uses Margo's current clipped contact geometry and steady soft
constraint law. All boxes have half-width `a=0.5 m`, half-height `b=0.5 m`,
zero radius and inertia `I=m/6 kg m^2`. Bottom to top, their masses are
`(1,1,1,1000) kg`. The ground is static and wider than the column; its side
planes do not clip the bottom box's vertices in this neighborhood. Gravity is
`(0,-9.81) m/s^2`, friction is `0.6`, restitution is zero, and there are no joints.
The step settings are four substeps at 60 Hz and one pass.

At sustained 1:1000 support, every dynamic pair exceeds the existing
50-weight spring-policy boundary and uses the 60-Hz spring. This note concerns
that steady branch. It does not replace the actual cold-start spring policy.

For a point with penetration `s<0`, substep length `h`, impulse `lambda`,
bias rate `beta`, and soft scales `mass_scale` and `impulse_scale`, the root is

```text
beta*s + C*lambda = 0,
C = Kii * impulse_scale/mass_scale,
beta/(h*C) = omega^2/Kii,
f = lambda/h = -k(q)*s,          k(q) = omega^2/Kii(q).
```

Here `omega=2*pi*60 rad/s`. The displayed analytical numbers use that frequency;
the executable evaluates the actual nearby f32 coefficients. A residual
recovery cap is inactive at this root and cannot change its static tangent.

Because `k` depends on geometry, the force `f=-k*s` must not be replaced by
the gradient of `sum(k*s^2/2)`: that gradient would add a different `dk/dq`
force. We differentiate the actual force law. The restricted bending block
below is symmetric; no global conservative-energy claim is made for the full
contact model.

[Andrews, Teichmann and Kry, *Geometric Stiffness for Real-time Constrained
Multibody Dynamics* (2017), section 1.2](https://www.cs.mcgill.ca/~kry/pubs/eg17/eg17.pdf)
describes the force-direction derivative `(d J^T/dq)*lambda`. Its section 4
adds numerical damping; it does not prove this compressed column stable.
[Macklin et al., *Non-Smooth Newton Methods for Deformable Multi-Body Dynamics*
(2019)](https://arxiv.org/abs/1907.04587) gives background on coupled contact and
friction complementarity and geometric stiffness.
[Catto, *Solver2D* (2024)](https://box2d.org/posts/2024/02/solver2d/) describes
soft constraints, retained anchors, substeps and relaxation. The column
equations and values here are derived from Margo, independently of those
papers' simulation results.

## Centered steady geometry

Number the ground interface `j=0` and the internal interfaces `j=1,2,3`.
Each interface's load `N_j` is split equally between two points:

```text
N = 9.81*(1003,1002,1001,1000),
Kii = (2.5,5,5,2.5025),
k_j = omega^2/Kii_j,
delta_j = N_j/(2*k_j).
```

| j | Load N (N) | Kii (1/kg) | Point stiffness k (N/m) | Penetration delta (m) |
|---|---:|---:|---:|---:|
| 0 | 9839.43 | 2.5 | 56848.921350 | 0.086540164407 |
| 1 | 9829.62 | 5 | 28424.460675 | 0.172907766173 |
| 2 | 9819.81 | 5 | 28424.460675 | 0.172735203532 |
| 3 | 9810 | 2.5025 | 56792.129221 | 0.086367601766 |

The sum is the existing closed-form top sag, `0.518550735877 m`. Body 1 has
height `b-delta_0`; successive body heights increase by `2*b-delta_j`.

## Infinitesimal sticking motion and clipped geometry

Let `theta_i` be each body's absolute small rotation, bottom to top, with
`theta_0=0` for ground. Margo places each contact point halfway between the
surfaces. Define

```text
A_j = b-delta_j/2,
B_j = b-delta_j/4.
```

For a lower body L and upper body U, the two tangent rows have the same
first-order sticking condition:

```text
dx_U-dx_L = -A_j*(theta_U+theta_L).                         (1)
```

At ground, `dx_1=-A_0*theta_1`. Choose no first-order vertical displacement.
These conditions define a four-dimensional bending subspace `Z`. Its reduced
physical mass `Z^T*M*Z` is positive definite. Normal forces are strictly
positive and tangential preload is zero. The required small sticking reactions
are `O(theta)`, inside a positive friction bound for sufficiently small motion.
This is an infinitesimal statement: finite-angle sliding or contact changes
require the full nonlinear problem.

First choose the lower face as reference and set `phi=theta_U-theta_L`.
Equation (1) gives relative center coordinate `d_x'=-A*phi` in its frame.
The incident endpoints before side clipping are

```text
x_minus = -a + delta*phi/2,
x_plus  =  a + delta*phi/2.
```

Clipping to `[-a,a]` moves one endpoint. For either sign of `phi`, their mean
first-order shift is `delta*phi/4`. Consequently,

```text
mean(r_L cross n) = delta*phi/4,
mean(r_U cross n) = B*phi,
s_plus/minus = -delta +/- a*phi + O(phi^2).
```

The individual endpoint derivatives are one-sided at centering. The
force-difference derivative used below is the same from either side. With
`u_L=1/I_L` and `u_U=1/I_U`,

```text
Kii = 1/m_L + 1/m_U + u_L*(r_L cross n)^2 + u_U*(r_U cross n)^2,
dK_plus-dK_minus = 2*a*[u_L*delta/2 + u_U*(2*b-delta/2)]*phi,
df = -k*ds - (f/Kii)*dKii.
```

The point-force difference therefore has restoring moment coefficient

```text
kappa_j = 2*k_j*a^2
        + (a^2*N_j/Kii_j)*[u_L*delta_j/2
                           + u_U*(2*b-delta_j/2)].         (2)
```

For upper reference, swap `u_L` and `u_U` in the bracket. Both choices are
evaluated at the unequal-mass top interface; the light/light values coincide.

At ground, the wide reference clips neither endpoint. Its normal arms are
`+/-a+b*theta_1`, giving

```text
kappa_0 = 2*k_0*a^2 + 2*a^2*N_0*u_U*b/Kii_0.               (3)
```

The extra preload term is `5903.658 N m/rad`. Freezing point stiffness omits
this stabilizing term and gives an insufficient rigid-column comparison.

## Reduced force tangent

At an internal interface, the mean world-frame arms are

```text
mean(r_U.x) = B*theta_U - (delta/4)*theta_L,
mean(r_L.x) = (delta/4)*theta_U - B*theta_L,
r_U.y = -A,                 r_L.y = A.
```

For lower reference, the horizontal normal force on U is `-N*theta_L`.
Substitute these arms and (2), and eliminate tangent reactions by virtual
displacements satisfying (1). Write the generalized force as `Q=-S*theta`.
Each internal interface contributes, in order `(theta_L,theta_U)`,

```text
S_j = kappa_j * [ 1 -1 ] - N_j * [ B_j       -delta_j/4 ]. (4)
                [-1  1 ]         [-delta_j/4 B_j        ]
S_ground = kappa_0-N_0*b.                                 (5)
```

Upper reference gives the same geometric matrix and the swapped-inertia
`kappa_j`. If the bottom box is the ground reference, its fixed local normal
arms instead give `S_ground=2*k_0*a^2-N_0*A_0`, approximately `23930 N m/rad`.
The static-ground-reference value is approximately `29408 N m/rad`, the
stiffer alternative used below. Gravity is already represented by the
equilibrium loads N; adding a separate gravity stiffness would count it twice.

For lower references, the four kappas are
`(34328.118675,17161.116338,17158.173338,28655.616731) N m/rad`, and

```text
S = [ 42079.614422  -16736.211928       0              0          ]
    [-16736.211928   25343.535804  -16734.116618       0          ]
    [     0         -16734.116618   36634.758331  -28443.800187   ]
    [     0              0        -28443.800187   23962.433274   ].
```

The trial `t=(1/4,1/2,3/4,1)` gives

```text
t^T*S*t = -5864.996039 N m/rad,
t^T*(Z^T*M*Z)*t = 3198.314441 kg m^2.
```

S has smallest ordinary eigenvalue approximately `-4128.382 N m/rad`.
Using upper reference at the top raises its kappa to `34022.512491`, but the
same trial still gives `-5529.565054 N m/rad`. Neither reference choice removes
this negative direction. The quotient of stiffness and mass is not a
prediction of the discrete split solver's growth rate.

At 1:100, the same calculation gives sag `0.052631605472 m`, trial quadratic
`+4046.670648`, and positive LDL pivots
`(42542.0131,23087.2577,32568.1618,3333.1307)`. Those pivots establish the sign
of this restricted bending block. A positive single-direction probe alone
would not establish full stability.

## Direct public-API force evaluation

The runnable example is
[support_bending.rs](../../packages/physics2d/kernel/examples/support_bending.rs).
It obtains actual mass properties through checked creation, builds the sagged
geometry directly, and calls checked `collide_coherent` at both signs of each
perturbation. It never calls `World::step`. It recomputes Kii using current f32
points, normals, inverse metrics and soft coefficients. Force and moment
accumulation then promote those actual values to f64:

```text
f = -beta*s / (h*(Kii*(impulse_scale/mass_scale))),
R = -(Q(+epsilon)-Q(-epsilon))/(2*epsilon).
```

Rotations are `epsilon*t`. The x-displacements are computed from the actual
baseline tangent Jacobian, so `Jt*Z=0`; y-displacements are zero. Baseline
generalized force is reported as zero. The largest absolute moving-body
vertical residual from f32 geometry/coefficient rounding is about `0.003295 N`
for payload 100 and `0.001142 N` for payload 1000. No nonzero baseline torque
or friction preload was discarded.

These recorded values were measured on 2026-11-08 against Margo commit
`f8d812a6330c4cf05fb1153e21246cccc670dd71`. All values below are N m/rad.
They are measurements, with no fitted passing tolerance.

| Payload | Kept reference history | Analytic R | epsilon .001 | epsilon .0003 | epsilon .0001 |
|---|---|---:|---:|---:|---:|
| 100 | All lower | 4046.670648 | 4046.739031 | 4045.442807 | 4047.345323 |
| 100 | Top upper | 4082.415449 | 4082.609631 | 4081.697066 | 4082.760884 |
| 100 | Ground upper | 4009.060138 | 4009.062428 | 4008.236381 | 4009.545614 |
| 100 | Ground and top upper | 4044.804939 | 4044.933028 | 4044.490640 | 4044.961175 |
| 1000 | All lower | -5864.996039 | -5864.954474 | -5866.403091 | -5862.342606 |
| 1000 | Top upper | -5529.565054 | -5529.498380 | -5530.377960 | -5527.635592 |
| 1000 | Ground upper | -6207.365105 | -6207.496851 | -6208.628072 | -6203.590333 |
| 1000 | Ground and top upper | -5871.934120 | -5872.040757 | -5872.602941 | -5868.883319 |

Both signs retain every requested face history and two-point manifold. All
normal forces remain positive: the smallest sampled values are about
`483.303 N` for payload 100 and `4896.543 N` for payload 1000. The example
returns an error if a requested history or point count changes, normal support
becomes nonpositive, or a required metric/force becomes nonfinite. It prints
the one-sided derivatives to expose asymmetry and f32 derivative noise.
Across this table, the largest absolute analytic/central difference is about
`3.775 N m/rad`, at amplitude `.0001` for ground-upper payload 1000.

From the repository root, run with a hard **180-second process-tree deadline**:

```sh
cargo run --locked --manifest-path packages/physics2d/kernel/Cargo.toml --example support_bending
```

The existing repository runner can impose that deadline:

```sh
node --input-type=module -e "import {runLimited} from './scripts/support/run-limited.mjs'; const r=await runLimited('cargo run --locked --manifest-path packages/physics2d/kernel/Cargo.toml --example support_bending',{cwd:process.cwd(),limitMs:180000,label:'2D support bending'}); if(!r.ok)throw new Error(JSON.stringify(r));"
```

A deadline violation is a failure; terminate the process tree and report it.
Exit zero means the specified evaluation domain held and measurements were
produced. The example does not accept or reject a solver using the derivative's
sign.

## Limits of this evidence

This is a local real-arithmetic force tangent checked against finite-f32
geometry evaluations. It is not an interval-certified finite-f32 trajectory
proof. Hysteresis can change reference branches over time; finite offsets can
activate sliding, shorten clipped spans or change point count. Tangential
reaction virtual work vanishes here to first order because baseline `Jt*Z=0`
and tangent preload is zero. This does not remove those nonlinear effects.

The negative margin remains after both reference alternatives are included.
For scale, an elementwise stiffness perturbation below `884 N m/rad` could
not change the worst-reference trial sign: `sum(abs(t_i*t_j))=6.25` and the
margin exceeds `5529 N m/rad`. This conditional bound does not establish that
every omitted modeling or active-set effect is below 884.

The S above is a constitutive/geometric tangent, not the contact mass matrix
`J*M^-1*J^T`. A negative bending direction need not produce a negative pivot
in an independent-row contact factorization. Conversely, a valid contact
factorization or small static residual does not establish bending stability.
Margo's biased integration and hard relaxation form a discrete split scheme;
its actual amplification, damping, energy error and terminal motion require
separate evidence. None is inferred here from a negative derivative or from
the fact that an offset column eventually falls.
