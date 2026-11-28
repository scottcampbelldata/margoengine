# SEA-04 measured comparisons

These opt-in comparisons run the repository's built Physics entries. Raw source data, frozen plans, predictions and scores are written to the ignored `test-results/sea04-measured` directory.

## DHI F1 cylinder

The physical data is from the DHI Test Cases performed by an international team led by Dr. Jun Zang at the University of Bath. The separate no-cylinder WG9 workbook fixes the input, with-cylinder WG9 is the holdout. Each raw archive is verified before processing. [CCP-WSI Test 008](https://www.ccp-wsi.ac.uk/catalogue/test_cases/test_case_008/) · [Chen et al. 2018](https://doi.org/10.1017/jfm.2018.339) · [Chen et al. 2014](https://doi.org/10.1016/j.oceaneng.2014.06.003)

| Raw workbook | SHA-256 |
| --- | --- |
| No cylinder, F1/F3, WG9 | `d8a3bd21e90894d8c4e0b5f345da9c9bd26782f9b520afd6168c05d3c327f07b` |
| With cylinder, F1/F3, WG9 | `486475d8556a7a715036565f0267cad545bb990d24fefbad8ab87cab7d16ff29` |

F1 uses water depth 0.505 m, radius 0.125 m and WG9 at 0.127 m upstream of the centre. The fixed original acquisition clock starts the numerical state at 37.5 s and scores 147 common samples in 38.78–41.22 s. The 30–50 s no-cylinder record, tapered at the endpoints, supplies modes from 0.35 to 1.65 Hz. This band retains 99.068% of the crest record's windowed energy. Initial longitudinal modes use the built finite-wake solver's horizontal, vertical and midpoint dispersion. The finite experiment uses a 5 m × 8 m crop with a 1 m sponge, exact circle apertures between active wet centres, and cell-centre obstacle occupancy. The 1 mm floor gap is approximated as closed. The tested linear surface cannot produce near-wall nonlinear harmonics. Case-specific paddle timing and full-basin return waves are absent from the cropped model.

The same Fourier input produces an independent full-depth MacCamy–Fuchs solution at the exact gauge coordinate. The no-obstacle run checks that numerical propagation reproduces the incident input. The two-grid delta, the open-control error and the numerical difference against the exact circle quantify sensitivity separately. These numerical indicators and the quiet no-cylinder background are distinct from instrument uncertainty. The experimental source gives no uncertainty for WG9 in this case. [MacCamy–Fuchs report](https://usace.contentdm.oclc.org/digital/api/collection/p266001coll1/id/7401/download)

| Fixed-clock comparison | 62.5 mm | 31.25 mm | Two-grid prediction delta |
| --- | ---: | ---: | ---: |
| Crest-run held-out RMS | 64.353 mm | 63.953 mm | 0.660 mm |
| Raw half-difference diagnostic held-out RMS | 14.664 mm | 14.667 mm | 0.147 mm |

The crest-run exact circular solution misses the observed trace by 61.181 mm RMS. The fine numerical trace differs from the exact circle by 5.373 mm RMS and its open control differs from the reconstructed incident wave by 4.269 mm RMS. The measured positive crest is 72.611 mm at 40.317 s. The fine predicted crest is 64.790 mm at 39.917 s. The observed peak occurs 0.400 s later on the nominal archive axis. The coarse-to-fine refinement and exact-circle comparison leave this discrepancy open. A trigger or wave-generation record shared by both tests would help distinguish instrumentation timing from physical phase differences.

The plan also preserves a historical raw half-difference diagnostic. The underlying incident-only analysis showed the nominal crest and trough columns correlate +0.839 at zero lag in 36–44 s. These raw records do not establish phase inversion at common workbook times. No measured receiver offset, source gain, or obstacle parameter was fitted. Neither DHI variant qualifies as a measured acceptance.

Run from the repository root with existing built Physics entries and Python with NumPy and SciPy.

```powershell
python packages/physics/scripts/sea04-measured-source.py fetch
python packages/physics/scripts/sea04-measured-source.py plan crest
$env:SEA04_MEASURED_VARIANT='crest'
node scripts/run-with-timeout.mjs --max 5 -- node packages/physics/scripts/sea04-measured.mjs predict coarse
node scripts/run-with-timeout.mjs --max 5 -- node packages/physics/scripts/sea04-measured.mjs predict fine
node packages/physics/scripts/sea04-measured.mjs freeze
python packages/physics/scripts/sea04-measured-source.py score crest
```

Use the default empty variant and omit the trailing `crest` argument from the Python plan and score commands to reproduce the raw half-difference diagnostic. The two grid packets must report matching bundle hashes. The frozen receipt verifies both packet hashes before the independent measurement is decoded.

The `upstream` variant uses separate gauges in the same run. In Chen et al. 2014, §3.1 and Fig. 5, WG1 is 0.77 m from the paddle and the cylinder centre is 7.52 m away. The plan reads only WG1 from 24–42 s and propagates its retained spectrum 6.623 m to the WG9 plane using finite-depth linear dispersion. This interval contains the incoming group and tapers before the return of its main reflected group. WG9 remains the scored observation. The same 38.78–41.22 s score uses the original shared times, with no synchronization or gain fit. The coarse 62.5 mm and fine 31.25 mm runs give 18.220 and 17.975 mm RMS. The exact linear cylinder gives 18.330 mm RMS and the two production traces differ by 0.712 mm RMS. The fine 66.024 mm crest occurs 0.133 s before the 72.611 mm observation. Using the upstream gauge reduces most of the between-run discrepancy. The residual may include nonlinear wave effects and differences between the experiment and model setup. Gauge uncertainty remains unavailable. The frozen prediction SHA-256 is `45aabcee891b552b6d2de9585d381a257b29497ed2777e1d99bf110261c08b3f`. [Chen et al. 2014](https://purehost.bath.ac.uk/ws/files/141068493/Numerical_Investigation_of_Wave_Structure_Interaction_using_OpenFOAM_.pdf)

Pass `upstream` to `plan` and `score` and set `SEA04_MEASURED_VARIANT` to `upstream` for prediction and freezing. Run `freeze coarse` to score a single grid, or `freeze` after computing the two grids.

## Rabaud–Moisy apparent wake angle

The first arXiv PDF's 37 red circles on Figure 2 are the photographic measurements. Its numerical results use yellow squares. The digitizer takes the centres of the vector paths and verifies the logarithmic axis transform against every labelled major tick. The author manuscript gives ±1° angle uncertainty. The red marker centres are graph-derived values, and the original supplemental table was unavailable. The paper inferred speed from wavelength. This benchmark compares the apparent crest angle and cannot independently validate wavelength or dispersion. [Figure 2, arXiv v1](https://arxiv.org/pdf/1304.2653v1) · [Published author manuscript](https://www.fast.u-psud.fr/~moisy/papers/2013_rabaud_prl.pdf)

The plan selects the plotted Froude numbers nearest 0.42 and 1.03 within 0.35–1.15, before their angles are read by the scorer. Each case uses 1 m nondimensional hull length, speed Fr×sqrt(gL), and transverse wavelength 2πU²/g. A fixed circular raised-cosine pressure source spans the hull length, with peak static head 0.001L. Deep water, source shape, ramp and window rules are identical in both cases. The source moves eight transverse wavelengths. On the two sides of the track, the solver takes peak positive height over radial windows centred at 2, 3 and 4 wavelengths, with radius ±0.5 wavelength. It reports the angle of maximum crest at each window and the median. The circle is a fixed source surrogate. The photographs do not constrain each ship's pressure footprint, beam, draft or stern geometry.

```powershell
python packages/physics/scripts/sea04-measured-rabaud.py --download
node scripts/run-with-timeout.mjs --max 3 -- node packages/physics/scripts/sea04-measured-rabaud.mjs predict
node packages/physics/scripts/sea04-measured-rabaud.mjs score
```

| Photo Froude | Natural wavelength | WakeSolver median crest angle | Radial window range | Measured angle | Signed error |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.416441 | 1.08965 m | 12.50° | 9.75–15.50° | 19.849° | −7.349° |
| 1.033166 | 6.70688 m | 11.75° | 11.00–12.25° | 9.001° | +2.749° |

Neither radial window range overlaps its measurement's ±1° interval. The fixed footprint and finite propagation window are limitations of this first model comparison. It provides a reproducible miss for the current forcing, with no fitted correction. The scored receipt is `bde1f19110c0012952c9f70b0cc8727a618b62815dbb29750b0da135fc0708d7`.

### Gaussian disturbance and envelope

The published numerical study applies the signed longitudinal derivative of a Gaussian disturbance proportional to `exp(−2π²r²/L²)` and measures a line through the modulus of the complex deformation. The follow-up uses that forcing in the live WakeSolver in the boat frame, with a uniform opposing current and zero net volume per kick. An independent quadrature of the outgoing pole supplies an open-water envelope. The two original photographic angles and their ±1° bands stay fixed. The paper did not supply the wetted geometry or the forcing for the photographed boats. [Rabaud and Moisy, 2013, pp. 3–4](https://arxiv.org/pdf/1304.2653v1)

| Photo Froude | Measured angle | Live SIMD, 8 cells/L | Live SIMD, 10 cells/L | Outgoing-pole envelope |
| ---: | ---: | ---: | ---: | ---: |
| 0.41644 | 19.849° | 18.988° | 18.777° | 18.788° |
| 1.03317 | 9.001° | 11.584° | Reached hard time cap | 10.529° |

At 8 cells/L the last two epochs' RMS peak changes are 2.105% and 0.436%. Refinement moves the slower result just outside measurement uncertainty, and both independent envelopes also miss. The live test exercises source shape and measurement protocol while leaving the apparent-angle accuracy gap open.

```powershell
node scripts/run-with-timeout.mjs --max 4 -- node packages/physics/scripts/sea04-rabaud-gaussian.mjs
node scripts/run-with-timeout.mjs --max 4 -- node packages/physics/scripts/sea04-rabaud-gaussian.mjs --fine --marker=28
node scripts/run-with-timeout.mjs --max 1 -- node packages/physics/scripts/sea04-rabaud-gaussian.mjs --analytic-only
```

## Briggs M4 breakwater

`measure-finite-quay-briggs.mjs` drives both a fixed breakwater and an open incident control from the published depth and carrier. The 14-second window contains the packet at all three measured transects. No measured lee coefficient sets a parameter. At 0.50 m, normalized diffraction coefficient RMS is 0.03792 across all gauges. At 0.25 m it is 0.04465 overall and 0.01528, 0.02503 and 0.07019 on the 30°, 60° and 90° transects. The fine errors at 8, 10 and 12 seconds are 0.05711, 0.04579 and 0.04429. Peak energy ledger residual across the fine wall and open runs is 1.13e−9 J. The fine run replays exactly. These results preserve the lack of consistent convergence in the lee. The paper's 0.052 result is an error from a published comparison model. The gauge precision was unavailable. [Briggs, Thompson and Vincent, 1995](https://doi.org/10.1061/%28ASCE%290733-950X%281995%29121%3A1%2823%29)

```powershell
node scripts/run-with-timeout.mjs --max 5 -- node packages/physics/scripts/measure-finite-quay-briggs.mjs --grid=coarse --horizontal-order=4
node scripts/run-with-timeout.mjs --max 10 -- node packages/physics/scripts/measure-finite-quay-briggs.mjs --grid=fine --horizontal-order=4
```
