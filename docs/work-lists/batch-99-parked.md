# Batch 99 parked jobs

The coordinator parked jobs 1 and 2 under the lane efficiency rules. These
remain open quality gaps for the fix phase, not completed parity claims.
The unpushed `batch-99` branch is preserved at `8d3481907`; none of its
checkpoints are included in this documentation-only push.

## Job 1: MagicaVoxel parity gap

MagicaVoxel 0.99.7.2 Cloud with S-density 0 still differs: Margo RGB mean
255 versus external gray mean 74.999844, a 180.000156 channel-value gap.
The `density = 14 * d` mapping produces zero interaction at zero density;
the general boundary/scattering/albedo mapping is unresolved. Controls differ
only in MATL `_trans` 0/1, at 960 x 800, 1024 spp and the stored pose.
Frozen PNG SHA-256:
`247f85adce1c7079560f47e759d18736a3534c54d32a479f38732afb7feb364b`.
Preserve all six external captures and `99-parity-runtime.json` in the
existing batch-99 runtime location. Exact camera, nonzero density, glass
and atmosphere parity remain unproved. Job 1 had no further work in r18.
Next: derive and validate a general medium boundary and scattering mapping
against the frozen controls; do not special-case zero density.

## Job 2: optional denoiser quality gap

Five frame-4 exposed-region losses remain (10 pixels each). RMSE from the
r17 common-stream comparison, unchanged by r18:

| Case | Optional | Root | Best published baseline |
| --- | ---: | ---: | ---: |
| Diffuse | 0.122444661 | 0.104193749 | 0.106810265 |
| Glossy | 0.123212583 | 0.103197626 | 0.105346015 |
| Glass | 0.108309154 | 0.093360242 | 0.098913747 |
| Media | 0.126616676 | 0.112097887 | 0.124540936 |
| Light change | 0.132573769 | 0.122245638 | 0.127367494 |

Three other misses of the unchanged 0.08 bar already beat root and every
published comparator; they are reported separately from the five losses:

| Region | Optional | Root | SVGF | A-SVGF | Full BMFR |
| --- | ---: | ---: | ---: | ---: | ---: |
| Media cold detail | 0.080064508 | 0.127832148 | 0.095315794 | 0.096612380 | 0.129253208 |
| Media frame 3 exposed | 0.087280345 | 0.124966458 | 0.090672564 | 0.093211074 | 0.094429360 |
| Light change frame 2 exposed | 0.087862944 | 0.153975351 | 0.121206198 | 0.118275992 | 0.116627028 |

Tried on `batch-99`: `6eb0aa8c1` history tap redistribution;
`b3f07cb88` A-SVGF sky replay with unit directions, w=0 and exact seeds;
`f56d2c331` full BMFR comparison (multiorder features, displaced blocks,
regularized augmented Householder QR, two temporal passes and TAA);
`3b0d17916` glass guides independent of transport; and `8d3481907`
ordered visible-area partition proof. The guide repair improved all 16 glass
regions, reduced published losses 9 to 5 and total bar misses 13 to 8;
glass frame-3 whole-image RMSE fell from 0.062358799 to 0.047466035
against its 0.06 bar. The r18 primitive improved no production region.
Its 26 controls passed on two actual devices, but it is not connected to
tracing/filtering. Diffuse common-stream replay reproduced
0.1224446614486013 exactly with seven exact root RGB checks.

Cause still to resolve: a pixel can observe multiple surfaces, while the
denoise shader has no scene binding and trace output lacks fragment
metadata. A single sampled surface cannot reconstruct their separate
visible contributions. Next: current-frame fragment projection, donor
selection and per-surface irradiance in the optional entry; keep emission
and reflection separate through visible-area composition. Start with
diffuse, then the other four regions. Native, WebGL2, device-loss and
extreme-input acceptance remains owed. No threshold or bar was changed.

Detailed comparison and source-pinned proofs remain on the preserved branch:
`docs/whitepaper/batch-99-published-denoisers.md`,
`docs/whitepaper/results/batch-99-published-denoisers-20261109.json`,
`docs/whitepaper/results/batch-99-visible-area-20261109.json`, and
`docs/research/batch-99-denoise.md`. These paths describe branch artifacts,
not files shipped by this parking note. README runtime/native compile
issues remain owned by builder lane-U.
