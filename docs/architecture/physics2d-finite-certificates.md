# Exact finite certificates in the 2D contact solver

The four-lane normal solver removes two redundant finite predicates while preserving its arithmetic, accepted lanes and scalar fallback. This changes neither the physical equations nor their f32 evaluation order. It introduces no stored mask, coefficient, layout field, setting or hash re-pin.

`finite(x)` means that both ordered comparisons `x <= f32::MAX` and `x >= -f32::MAX` hold. It accepts either signed zero and rejects infinities and every NaN. The proof below uses the existing F4 add, subtract, multiply and bitselect operations, with their ordinary IEEE results; it does not assume real-number cancellation or fast-math rules.

## Block certificate

Both calls to `certify_block` originate in `normal_common`. In each lane they supply the following intermediates, evaluated in the existing order, where each operation rounds to f32:

```text
m11 = K11 + K11*t0
m22 = K22 + K22*t1
det = m11*m22 - K12*K12
```

Here `ti` is zero for a hard row and the selected spring ratio for a biased soft row. The proof permits any finite or nonfinite `ti`. The K fields remain unchanged between computing these expressions and calling the certificate, including the fast exit that first applies the answer.

Finite `m11` implies finite `K11`. A NaN diagonal propagates through the multiplication and addition. An infinite diagonal multiplied by zero produces NaN; every other product is infinite or NaN, and adding the original infinite diagonal cannot produce a finite value. The same argument applies to `m22` and `K22`. If `K12` is nonfinite, its square is NaN or positive infinity. Subtracting it from `m11*m22`, including an overflowing product, cannot produce a finite determinant. Thus the retained finite checks on `m11`, `m22` and `det` imply the removed finite check on all three K entries.

This reasoning covers signed zeros, subnormals, overflow, infinities and NaNs. It does not assert that finite K guarantees a finite matrix; the retained intermediate checks still reject overflow and invalid products.

## Sequential-row certificate

The sole row caller supplies values derived by these unchanged expressions:

```text
impulse = -normal_mass*mass_scale*(vn+bias) - impulse_scale*old
sum = old + impulse
total = select(sum > 0, sum, +0)
```

Finite `impulse` implies finite `bias`, `vn` and `normal_mass`. Any nonfinite value among them remains nonfinite through this add/subtract/multiply chain: zero times infinity is NaN, and cancellation of infinities is NaN. There is no intervening min, max, division or select that could hide that value. Finite `sum` implies finite `total`, because the latter selects either that exact sum or positive zero. Checking `impulse` and `sum` therefore subsumes the original six-value finite predicate.

The sum check remains essential: finite `old` and `impulse` can overflow when added. Checking only `total` would also be insufficient because its select can hide a NaN sum.

## Caller contract and retained guards

These are proofs about actual caller dataflow, not arbitrary independent helper arguments. For example, supplying finite matrix intermediates alongside `K12 = NaN` would make the old and reduced block helpers disagree. Supplying finite `impulse`, `sum` and `total` alongside an unrelated NaN `bias` does the same for the row helper. Such arguments violate the caller contract; future callers must derive the supplied values by the equations above.

The change retains finite RHS and answer checks, the row's finite/nonnegative raw diagonal, used soft-coefficient domain checks, cap membership, post-application motion checks, and exact exceptional-lane restart, scalar fallback and error propagation. Closure and soft-state selection remain unchanged. In particular, an unused invalid soft state on an open row is not turned into an eager error, and NaN gaps are not reclassified by replacing one comparison with another.

## Verification and emitted work

Private controls preserve the old predicates and compare exact lane masks after computing the actual caller expressions. They cover 262,144 block and 131,072 row batches of four lanes: both biased states, partial live masks, all four block answer forms, signed zeros, subnormals, maximum finite values, infinities, quiet/signaling NaN bit patterns, arbitrary bits and moderate finite values. A separate directed batch retains refusal for sum overflow, an infinite raw diagonal and an invalid used soft domain, while accepting an unused NaN soft state on an open row. The existing per-visit scalar/f64 shadows, native tests, strict 29 physical bars and shipped Wasm checks pass with the same three production hashes.

Actual release compiler output establishes a smaller finite-predicate inventory. The shipped simd128 binaries were decoded with Binaryen 132.0.0 without optimization or rewriting; native output used the unchanged release profile with rustc 1.99.0 / LLVM 23.1.1.

| Static emitted operation | Control | Candidate |
|---|---:|---:|
| Wasm function `$111`: `f32x4.abs` | 42 | 28 |
| Wasm function `$111`: `f32x4.le` | 44 | 30 |
| Wasm function `$111`: `v128.and` | 64 | 50 |
| Native `certify_block`: `cmpleps` / `andps` | 31 / 35 | 29 / 30 |
| Native `normal_certified`: `cmpleps` / `andps` | 46 / 97 | 38 / 90 |

The Wasm f32/f64/vector add, subtract, multiply, divide and square-root opcode counts remain unchanged. Native `normal_certified` retains 101 `mulps`, 36 `addps`, 46 `subps` and four `divps`. Wasm module size falls from 268,372 to 268,181 bytes. These are static counts across emitted branches and call sites, not a per-contact instruction saving or a dynamic micro-op count. LLVM had already combined some source predicates; the larger source-level estimate is not the compiled result.

A 24-round paired run shows no established timing gain: median candidate/control ratio 1.000068, interquartile range 0.9254–1.0686, with the candidate faster in 12 rounds. Twelve-round browser minima are Edge Margo/Box2D/Rapier 4.065/1.500/8.855 ms and Firefox 4.420/1.420/10.460 ms. Margo loses to Box2D in every round; separate loaded sessions do not prove a before/after gain. Edge WebGPU/WebGL2 and Firefox WebGL2 retain the current pins and stack predicates; Firefox WebGPU has no adapter. Neither the counts nor the timing establish a browser speed win.

## Provenance and next investigation

The isolated control is own local commit `b09e802902825c36c717e9f452c27bc37f148937`; its physics2d and shared-kernel Git blobs are identical to pushed main `119d55a9a`. The release diff changes only the two certificate predicates in `solver/wide.rs`. The [committed diagnostic record](../whitepaper/results/physics2d-finite-certificates-20261108.json) includes the compiler inventories, provenance and raw rounds. Lane P's detailed local records are `.lane/p/speed-cert-trim/evidence.json`, `compiled-work.json` and `baseline-provenance.json`; none is a runtime dependency.

The rebuilt control and earlier flat artifact have matching production/common/checker sources and compiler metadata; the only source-inventory differences are a diagnostic example and cfg(test) storage-test formatting. Their decoded binary differences are source-filename metadata and relocated data addresses; the relevant normal-solver function is text-identical. The live flat build likewise differs in static addresses and load/store offsets. This establishes the recorded provenance, not raw binary identity or a claim that timing is independent of layout.

The next useful investigation is a matched phase profile of the remaining work—setup, body gather/scatter, constraint arithmetic, support correction and integration—with identical outputs and explicit workload counts. Any subsequent change should follow the measured dominant phase. This note proposes no additional implementation or speed forecast.
