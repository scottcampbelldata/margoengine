# Exact rectangle SAT and certified face-distance decision

This note proves two restricted replacements in the physics2d four-quad narrow
phase. The first evaluates the same eight SAT axes with fewer vertex projections.
The second proves that the original decision must accept its first preferred
clipped face, so its complete 32-candidate distance calculation has no effect on
the returned manifold. Neither replacement estimates a distance used in output.
Failure to prove either replacement retains the original complete path.

The proof concerns the current placed vertices, normals and SAT results in A's
frame. It is not a promise about data produced by a particular constructor.
`Core` arrays are publicly mutable. No constructor flag, persistent shape cache,
probabilistic hash, or assertion that public data is well formed can authorize
these replacements.

## Arithmetic model and primary references

Write `RN(z)` for binary32 round to nearest, ties to even. Each written operation
is rounded in its existing order; expressions are not reassociated or fused.
Square root is correctly rounded, as in the native and Wasm math paths. Gradual
underflow is part of the model. Define

```text
u = 2^-24                     binary32 unit roundoff
η = 2^-149                    smallest positive binary32 subnormal
δ = η / 2 = 2^-150            a real error bound, not an f32 constant
```

For a finite real operation result whose rounding does not overflow,

```text
|RN(z) - z| <= u |z| + δ.                                      (1)
```

RN, correctly rounded square root, and addition with a fixed finite operand are
numerically monotone. Multiplication by a fixed nonnegative finite operand is
monotone increasing; multiplication by a negative operand is monotone decreasing.
Signed zeros are equal in these numerical statements. NaN is excluded by the
certificates, not ordered by this argument.

[Jeannerod and Rump, *Improved Error Bounds for Inner Products* (2013)](https://www.tuhh.de/ti3/paper/rump/JeaRu13.pdf)
is a primary reference for analysis of ordered floating-point inner products
under round to nearest; its inner-product theorem assumes no underflow or
overflow. The geometric constants, absolute underflow allowance, and logical
certificate below are our own derivation using (1). The paper does not establish
the underflow part of this proof. The [publisher record](https://epubs.siam.org/doi/abs/10.1137/120894488)
identifies the published paper.

[Catto, *Sequential Impulses*, GDC 2006](https://box2d.org/files/ErinCatto_SequentialImpulses_GDC2006.pdf)
describes face-axis SAT, reference and incident faces, and clipping.
[Ericson, *Real-Time Collision Detection* (2005), author companion](https://realtimecollisiondetection.net/)
provides the support-geometry and distance background. These are mathematical and
prose references. No implementation or source from another engine is used.

## 1. Current rectangle certificate

The current A vertices must have this numerical corner grid, in this order:

```text
A0 = (loX, loY)       A1 = (hiX, loY)
A3 = (loX, hiY)       A2 = (hiX, hiY)
loX < hiX             loY < hiY
```

The implementation checks all four matching-coordinate equalities and both
strict inequalities on the placed values. It also checks every current A normal
against the corresponding exact unit axis:

```text
n0 = (0,-1)   n1 = (1,0)   n2 = (0,1)   n3 = (-1,0).           (2)
```

Numeric equality intentionally accepts either sign of zero. It rejects NaN;
the separate range check rejects infinities. In particular, an axis-aligned
normal with magnitude 0.75 does not pass (2). A mutated vertex or normal is
checked again on the next call.

The SAT range certificate evaluates the original ordered squared norms

```text
S(x,y) = RN(RN(x*x) + RN(y*y)).                                (3)
```

It requires `S <= 2^120` for A0, A2, and every B vertex, and `S <= 4` for every B
normal. Grid equality means A0 and A2 include all A coordinate extremes. A's
normals already satisfy (2). These comparisons reject NaN, infinity, and
overflowed squared norms.

For binary32 inputs, the coordinate check implies `|coordinate| <= 2^60` and the
normal check implies `|normal component| <= 2`. For example, the next binary32
number above `2^60` has a rounded square strictly above `2^120`; subsequent
nonnegative addition cannot lower that square. The same argument applies at 2.
Consequently all original SAT coordinate differences, products, and two-term
sums are finite: they are bounded respectively by `2^61`, `2^62`, and `2^63`.
These power-of-two bounds also bound the rounded operations by monotonicity.
No `0 * infinity` or overflowing subtraction can invalidate the support proof.

## 2. Restricted support SAT equals the original ordered scan

For one face, the original value at a tested vertex is

```text
P(v) = RN(RN(nx * RN(vx-ox)) + RN(ny * RN(vy-oy))).              (4)
```

For a B face testing A's grid, select

```text
vx = loX if nx >= 0, else hiX
vy = loY if ny >= 0, else hiY.                                 (5)
```

Each selection minimizes its rounded product in (4): rounded subtraction is
monotone, and the fixed multiplier either preserves or reverses that order.
All combinations of the grid extremes are numerical A corners. Both component
minima therefore occur together at a corner. Monotonicity of the final rounded
addition proves that evaluating (4) at (5) gives the same numerical minimum as
evaluating (4) at all four original vertices. The expression itself is unchanged;
there is no center/extent formula or changed dot-product order.

For an A face testing B, (2) makes only one component contribute numerically.
Take the minimum or maximum of that coordinate over the four B vertices in the
direction dictated by the axis normal. The other coordinate is multiplied by
zero. A point assembled from the two B coordinate extrema need not be an actual
B vertex, but its contributing coordinate is that of an actual minimizer, and
its finite unused coordinate contributes only signed zero. Evaluating (4) thus
gives the same numerical minimum. In face order 0,1,2,3, the coordinate choices
used by the restricted path are

```text
(loX_B, hiY_B), (loX_B, loY_B),
(loX_B, loY_B), (hiX_B, loY_B).
```

All four A axes and all four B axes are still evaluated. The outer face scan
retains its strict `>` update in its original face order, so equal minima keep
the identical first face index.

Coordinate equality can conceal a difference in zero sign between otherwise
identical corners. Consequently a SAT separation of numerical zero may acquire
the other zero sign. Face separations are used for comparisons and reference
selection, never as output point or normal coordinates. Their subsequent
threshold and hysteresis comparisons have identical truth values for either
zero sign. Face indices, placed geometry, clipping arithmetic, and final
transform arithmetic are unchanged. This argument does not license replacing
signed zeros elsewhere in the manifold calculation.

Each SIMD lane has its own certificate. An uncertified lane selects the original
`best(a,b)` and `best(b,a)` results, and no certified lane depends on another
lane's values. If no lane is certified, the original scans run directly. Mixed
lanes, nonquads, short world queues and invalid public mutations keep their
existing complete fallbacks.

## 3. Preconditions for a face-distance interval

The interval proof uses a stronger range restriction than SAT:

```text
1 <= M <= 2^20, and every current placed coordinate has |x| <= M. (6)
```

A must satisfy the current canonical rectangle certificate above. Its current
best face `f = faceA.separation` must be finite and strictly positive, and its
index must be in 0..4. The original face scan must have supplied that face from
the same placed values. The complete scalar eligibility scan also requires
finite B normals with component magnitudes at most 2; private SAT metadata
already supplies the stronger squared-norm guard. B vertices need not form a
canonical grid for this proof: each B edge is still in the convex hull of its
endpoints.

The radii must be finite and nonnegative, their original rounded sum finite,
and the speculative threshold and B face separation finite. The original first
SAT/radius rejection is performed before attempting the certificate. A valid
preferred reference index and the unchanged clipping/result guards remain
required later. A failed precondition invokes the complete original decision.

Let `ε = u M`. The very conservative inequality

```text
δ <= u ε,                                                      (7)
```

holds because `M >= 1`. It lets the following bounds include subnormal results
explicitly without assuming relative error at zero.

## 4. Every old rounded edge point lies within 8ε of its edge hull

For any of the old 32 point/edge candidates, let p,r be the binary32 edge
endpoints and z the vertex. The original distance arithmetic is, componentwise,

```text
e       = RN(r-p)
span    = RN(RN(ex*ex) + RN(ey*ey))
numer   = RN(RN(RN(zx-px)*ex) + RN(RN(zy-py)*ey))
t0      = RN(numer / span)
t1      = pmin(pmax(t0,0),1)
t       = select(span > 0, t1, 0)
m       = RN(e*t)
qhat    = RN(p+m).                                             (8)
```

The `pmax`/`pmin` are the old compare/select semantics, in that order. The final
zero-span select is essential even for distinct endpoints whose squared length
underflows to zero. It must not be replaced by an unproved division rewrite.

Under (6), the edge components, span and numerator are finite. If `span > 0`,
division may overflow to an infinity, which the old clamp maps to an endpoint;
finite numerator and positive finite span cannot produce NaN. If `span == 0`,
the final select makes `t = 0`, including a preceding `0/0` or infinite quotient.
Thus the selected t is always finite and in [0,1]. Underflow during division
also leaves it in that interval.

Use that exact selected binary32 t to define the real point

```text
q* = p + (r-p)t.
```

It belongs to the true endpoint segment. No accuracy bound on the quotient t
is necessary. From (1), (6), and (7), per coordinate:

| Error | Bound in units of ε |
| --- | --- |
| `e - (r-p)` | `2 + u` |
| `m - et` | `2 + 3u + u²` |
| `qhat - (p+m)` | `3 + 5u + 4u² + u³` |

For example, `|e| <= 2M + (2+u)ε`; the next line follows by multiplying by
`0 <= t <= 1` and applying (1). Then
`|m| <= 2M + (4+4u+u²)ε`, giving the final line. Adding the three errors yields

```text
|qhat - q*| <= (7 + 9u + 5u² + u³) ε < 8ε.                    (9)
```

This includes interpolation on either polygon and zero-span candidates.

## 5. Supporting-axis difference: the audited 14ε bound

Let n be A's selected canonical face normal, with supporting face vertex a.
Its exact supporting gap is

```text
g = min over B vertices b of n · (b-a).
```

The axis multiply is by exactly +1 or -1; the other product is signed zero.
Only the axial subtraction has numerical error. Its error is at most
`2ε + δ < 3ε`. Taking a minimum cannot increase this absolute error. Therefore

```text
g >= f - 3ε.                                                   (10)
```

Every A edge point is on or behind A's supporting plane and every B edge point
is on or beyond B's minimum support plane along n. Hence the exact oriented
axial difference of either kind of candidate (B vertex/A edge, or A vertex/B
edge with the orientation reversed) is at least g.

Replacing its exact edge point by qhat loses at most 8ε by (9). Finally, the
old stored offset `x = RN(vertex_coordinate - qhat_coordinate)` has subtraction
error below 3ε: `|qhat| <= M+8ε`, so (1) bounds that error by
`u(2M+8ε)+δ <= (2+9u)ε < 3ε`. Taking an absolute value bounds either orientation.
Thus every candidate has an offset component satisfying

```text
|x| >= f - (3+8+3)ε = f - 14ε.                                (11)
```

The intermediate constant is 14, not 12. If the right side is negative the
inequality remains valid. These estimates also give `|x| < 3M` for both stored
offset components.

## 6. Rounded norm: another 8ε, including underflow

For a candidate's two stored components x,y, the old squared distance and
rounded distance are

```text
P = RN(x*x), Q = RN(y*y), S = RN(P+Q), di = RN(sqrt(S)).
```

All are finite and nonnegative under (6). For example, `|x|,|y| < 3M` bounds
each rounded square below `10M²` and their rounded sum below `21M² < 2^45`.
There is no overflow. P and Q are nonnegative, so `S >= P` by monotonicity.
Equation (1) gives `P >= (1-u)x²-δ`. Using
`sqrt(max(A-B,0)) >= sqrt(A)-sqrt(B)` for nonnegative A,B gives

```text
di >= (1-u) sqrt(P) - δ
   >= (1-u) sqrt(1-u) |x| - (1-u)sqrt(δ) - δ
   >= (1-2u)|x| - sqrt(δ) - δ.                                (12)
```

The last step uses `sqrt(1-u) >= 1-u`. Since `|x| < 3M`, the loss is less than
`6ε + sqrt(δ) + δ < 8ε`. In particular, `sqrt(δ)=2^-75` is explicitly covered
by `ε >= 2^-24`; squaring a small offset to zero is not silently treated as a
relative-error operation. Combining (11) and (12):

```text
di >= f - 22ε for every one of the original 32 candidates.     (13)
```

The old `pmin` reductions find the numerical least squared candidate. Correctly
rounded sqrt is monotone, so its returned distance d is also the least numerical
rounded candidate distance. The original first-tie witness is immaterial when
the original preferred clipped face is proved to succeed. Equation (13) implies

```text
d >= f - 22ε.                                                  (14)
```

## 7. Computable lower and upper bounds

The lower bound deliberately leaves a large margin:

```text
E = RN(M * 2^-16) = 256ε
L = RN(f-E).                                                   (15)
```

The multiplication is an exact power-of-two scaling for binary32 M in (6),
with neither underflow nor overflow. Since a canonical face value has
`0 < f <= 2M`, `|f-E| <= 2M`. Equation (1) bounds upward subtraction error
below `3ε`. Consequently

```text
L <= f - 253ε <= f - 22ε <= d.                                (16)
```

There are at least 231ε of margin beyond the audited loss. Negative L is
allowed: it is a conservative lower bound, never a replacement output distance.

For the upper bound, evaluate two actual old arithmetic paths: two actual B
vertices against A's selected actual edge, using exactly (8), the original
offset expression, its ordered squared length, and its rounded sqrt. Selecting
the two least support projections, stably on ties, is only a useful heuristic
for obtaining a small upper bound; any two actual old candidates would be safe.

Let their rounded distances be d1,d2 and set `U = min(d1,d2)`. Every old squared
candidate is finite and nonnegative; monotonic sqrt proves

```text
d <= d1, d <= d2, hence d <= U.                                (17)
```

A scalar candidate helper is valid only when it keeps this exact arithmetic.
Its scalar clamp has the same ordered comparisons as the old `pmax`/`pmin` for
finite or infinite quotients, including equal signed zeros. When a zero span
allows a NaN quotient, the identical final zero-span select discards that
quotient. An algebraically equivalent endpoint projection, early endpoint
rewrite, approximate sqrt, or changed dot expression is not justified by (17).
Bounds must be finite before the interval is used.

Equations (16) and (17) establish the required interval `L <= d <= U`.

## 8. Three monotone checks prove the original first face succeeds

Keep the original rounded radius sum `R = RN(ar+br)`, speculative threshold s,
face tolerance τ, original fresh-reference comparison, and original hysteresis
choice. Let `ref` be that original first preferred reference, not a newly chosen
alternate. It must have a valid edge index. Clip exactly that face with the
original owner/other order, radii, incident selection and point compaction. Let
c be the least returned point separation, with +infinity for an empty result.

The fast path requires these exact ordered floating-point comparisons:

```text
RN(U-R) <= s                                                   (18)
ref.separation >= RN(U-τ)                                      (19)
c <= RN(RN(L-R)+τ).                                            (20)
```

RN subtraction and addition are monotone. Since `L <= d <= U`, (18) implies
`RN(d-R) <= s`: the original closest-distance rejection cannot occur. Equation
(19) implies `ref.separation >= RN(d-τ)`, the original first face's distance
test. Equation (20) implies `c <= RN(RN(d-R)+τ)`, its original clipped-point
test. The expression order in (18)-(20) is part of the proof; the radius sum and
subtractions are not regrouped.

Thus the original loop accepts this same face on its first iteration and never
uses the closest-point witness, its feature id, or its derived single-point
normal. The fast path returns exactly the manifold from that original clip and
the unchanged final world normal/point transforms, in the original order. Its
nonempty/finite-result guards may conservatively reject an attempt; they do not
authorize any different output. Unused manifold slots retain the same default
initialization.

Trying a fresh alternate before the preferred reference would not follow this
proof: the preferred reference could also have succeeded with different output.
If any check fails, discard the attempt and invoke the original complete
decision with the original faces and complete `closest_quads`. Never pass L, U,
or another guessed distance to that fallback.

## 9. Reusing current SAT metadata without repeating its scan

The SAT guard already computes (3) for A's two grid-extreme corners and all B
vertices. Accumulate, per lane,

```text
M = max(1, S(A0), S(A2), S(B0), S(B1), S(B2), S(B3)).            (21)
```

Although (21) contains squared norms, it is a valid coordinate-magnitude bound.
For a representable coordinate with `|x| >= 1`, real `x² >= |x|`. Monotonic RN
and representability of `|x|` imply `RN(x²) >= RN(|x|) = |x|`. Adding the
nonnegative rounded y square and rounding cannot lower that bound. The same
argument applies to y; coordinates smaller than 1 are covered by the constant
floor. A0 and A2 contain every A coordinate magnitude because of the certified
grid. Therefore (21) bounds all eight vertices exactly as required by (6).

This bound may be much larger than the maximum absolute coordinate. That makes
E larger and L smaller, so fewer intervals certify a face; it cannot make an
unsafe interval pass. Metadata is admitted only when the current full grid and
SAT safe masks are valid and `1 <= M <= 2^20`. In particular, accumulation by
`pmax` alone is insufficient: it may retain a finite operand when another operand
is NaN. The successful per-value finite/range mask is also required.

The metadata object is private, constructed only from that current lane's
certificate and consumed with those same current placed quads and SAT faces.
It is not a public caller-supplied magnitude and is not retained across edits or
steps. Reusing it omits only already-proved canonical/range scans. Scalar calls
and lanes without qualifying metadata perform the complete original eligibility
scan; the much broader `2^120` SAT range is not narrowed to the distance range.
NaNs, infinities, overflow, noncanonical current normals, invalid indices,
mixed shapes, or an unsuccessful logical check retain the complete original
fallback for the affected lane.

## 10. Evidence required in addition to the proof

This proof is conditional on the stated guards and arithmetic order. It does
not replace executable comparison against the retained unmodified reference:
compare all manifold fields and unused slots, original contact order and every
pinned native/Wasm hash. Cases must include mixed SIMD masks, lane permutations,
all reference histories, signed zeros, subnormal and zero-span edges, public
array mutations, nonfinite and oversized inputs, near-corner and threshold
cases, short queues, and scalar fallbacks. Interval tests must independently
check `L <= old_distance <= U`, including interpolation and squared-norm
underflow. Metadata tests must verify both its coordinate bound and rejection
of stale/invalid current geometry without shrinking SAT's valid range.

The deterministic work claim is precise: a successful interval evaluates two
old point/edge candidates and the same accepted clip, avoiding the remaining
30 old candidates and their complete minimum/witness calculation. Failed
attempts retain the full calculation and add certificate work. Hit counts and
paired full-step measurements therefore decide whether this proved replacement
is useful; the proof alone makes no speed claim.
