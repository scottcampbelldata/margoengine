# Complete checked-step profile: current finite trim

Matched complete-step profile of current finite-trim physics. Busy diagnostic; instrumentation and export reads can alter optimizer/layout/cache behavior. Absolute instrumented phase costs are not an unmodified production-step speed claim.

Aggregate host CPU busy was 99.2917%. These absolute whole-step times must remain separate from the original browser benchmark rows.

Both artifacts pass shipped checks0/1/2 and full3 explicit u64 pins. Node100-step and every measured browser-step full public body/contact/cache state and public work fingerprint match. All measured visits retain5050awake.

Clock-loop minus empty-loop cost is approximate. The black_box empty loop includes int-to-f64/checksum work that differs from the imported-clock loop; neither subtraction nor adjacent-phase attribution isolates import cost. Raw phases and raw calibration samples are retained, no exact deconvolution is claimed.

All values below are milliseconds. Phase shares use the sum over320 actual instrumented steps divided by the sum of those same320 outer elapsed times. Phase means/medians are not an additive minimum step. The selected vector belongs to the named real complete step.

## edge 157.0.4341.42

Control/instrumented minimum complete step: 6.640000 / 7.210000. Median paired round-minimum ratio: 1.028444 (Q1 0.950416, Q3 1.083863).

There are 39 imported clock calls per instrumented step. The approximate clock-minus-empty median cost per call is 153.200 ns, estimated all-call cost 0.005975 ms. The observed outer-minus-phase-sum residual median is 0.010000 ms (range 0.000000 to 0.025000). No clock or layout cost is silently subtracted.

Selected real minimum step: round 4, sample 23, world step 84, outer 7.210000, phase sum 7.200000, residual 0.010000.

| Phase | Mean ms | Median ms | Share of outer total | Selected real step ms | Entries/step |
|---|---:|---:|---:|---:|---:|
| preflight | 0.222609 | 0.200000 | 2.389% | 0.175000 | 1 |
| broad | 0.574047 | 0.490000 | 6.161% | 0.275000 | 1 |
| narrow | 1.330234 | 1.310000 | 14.278% | 1.175000 | 1 |
| islands | 0.149875 | 0.140000 | 1.609% | 0.110000 | 1 |
| solver-setup | 2.061938 | 1.982500 | 22.132% | 1.500000 | 1 |
| support-planner | 1.019047 | 0.950000 | 10.938% | 0.620000 | 1 |
| substep-preparation | 0.064031 | 0.060000 | 0.687% | 0.040000 | 4 |
| warm-start | 0.434547 | 0.410000 | 4.664% | 0.300000 | 4 |
| biased-solve | 1.302281 | 1.260000 | 13.978% | 1.165000 | 4 |
| support-correction | 0.002047 | 0.000000 | 0.022% | 0.000000 | 4 |
| pose-integration | 0.120797 | 0.115000 | 1.297% | 0.120000 | 4 |
| relax-solve | 1.269172 | 1.230000 | 13.623% | 1.180000 | 4 |
| substep-observer | 0.029109 | 0.030000 | 0.312% | 0.025000 | 4 |
| solver-finalization | 0.596094 | 0.575000 | 6.398% | 0.390000 | 1 |
| post-solve-validation | 0.062547 | 0.060000 | 0.671% | 0.055000 | 1 |
| sleep | 0.044094 | 0.045000 | 0.473% | 0.045000 | 1 |
| post-sleep-validation | 0.025641 | 0.025000 | 0.275% | 0.025000 | 1 |

Runtime count values: substeps=4, passes-per-substep=1, moving-bodies=5050, constraints=14950, simd-blocks=3740/3742/3739/3741, colours=8, planner-calls=1, eligible-plan=0, snapshot-calls=0, correction-calls=0, wide-biased-calls=4, scalar-biased-contact-visits=0, wide-relax-calls=4, scalar-relax-contact-visits=0, warm-start-calls=4.

Public count values: compared=12562/29458/22791/11193/10170/8911/8039/15875/9106/12488/4878/13066/7776/7409/5188/4453/3356/2151/1137/697/249/88/47/0, pairs=14950, manifolds=14950, cold-points=0/2, constraints=14950, block=119600, sequential=0, colours=8, overflow=0, islands=2, awake-bodies=5050.

## firefox 157.0

Control/instrumented minimum complete step: 9.380000 / 9.000000. Median paired round-minimum ratio: 0.966695 (Q1 0.898876, Q3 1.027316).

There are 39 imported clock calls per instrumented step. The approximate clock-minus-empty median cost per call is 76.100 ns, estimated all-call cost 0.002968 ms. The observed outer-minus-phase-sum residual median is 0.020000 ms (range 0.000000 to 0.540000). No clock or layout cost is silently subtracted.

Selected real minimum step: round 7, sample 38, world step 99, outer 9.000000, phase sum 8.960000, residual 0.040000.

| Phase | Mean ms | Median ms | Share of outer total | Selected real step ms | Entries/step |
|---|---:|---:|---:|---:|---:|
| preflight | 0.422688 | 0.380000 | 2.492% | 0.280000 | 1 |
| broad | 1.250187 | 1.080000 | 7.370% | 0.540000 | 1 |
| narrow | 1.767875 | 1.500000 | 10.422% | 1.280000 | 1 |
| islands | 0.366313 | 0.250000 | 2.159% | 0.140000 | 1 |
| solver-setup | 4.080687 | 3.680000 | 24.056% | 1.900000 | 1 |
| support-planner | 2.598437 | 2.210000 | 15.318% | 0.980000 | 1 |
| substep-preparation | 0.228875 | 0.200000 | 1.349% | 0.040000 | 4 |
| warm-start | 1.000250 | 0.840000 | 5.897% | 0.400000 | 4 |
| biased-solve | 1.893000 | 1.630000 | 11.159% | 1.220000 | 4 |
| support-correction | 0.004687 | 0.000000 | 0.028% | 0.000000 | 4 |
| pose-integration | 0.254625 | 0.200000 | 1.501% | 0.120000 | 4 |
| relax-solve | 1.681063 | 1.420000 | 9.910% | 1.220000 | 4 |
| substep-observer | 0.044438 | 0.040000 | 0.262% | 0.060000 | 4 |
| solver-finalization | 1.100937 | 0.960000 | 6.490% | 0.660000 | 1 |
| post-solve-validation | 0.143375 | 0.100000 | 0.845% | 0.060000 | 1 |
| sleep | 0.068500 | 0.060000 | 0.404% | 0.040000 | 1 |
| post-sleep-validation | 0.040000 | 0.020000 | 0.236% | 0.020000 | 1 |

Runtime count values: substeps=4, passes-per-substep=1, moving-bodies=5050, constraints=14950, simd-blocks=3740/3742/3739/3741, colours=8, planner-calls=1, eligible-plan=0, snapshot-calls=0, correction-calls=0, wide-biased-calls=4, scalar-biased-contact-visits=0, wide-relax-calls=4, scalar-relax-contact-visits=0, warm-start-calls=4.

Public count values: compared=12562/29458/22791/11193/10170/8911/8039/15875/9106/12488/4878/13066/7776/7409/5188/4453/3356/2151/1137/697/249/88/47/0, pairs=14950, manifolds=14950, cold-points=0/2, constraints=14950, block=119600, sequential=0, colours=8, overflow=0, islands=2, awake-bodies=5050.

Original attempt and its failure log remain intact. The only correction was signed Wasm i64-to-u64 hexadecimal normalization, verified by directed assertions for all three pins. No physics module, fixture, settings, hash expectation or accuracy predicate changed.
