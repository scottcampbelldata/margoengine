# SEA-06 laboratory evidence

## NOAA canonical beach

The diagnostic reads every coordinate and elevation in NOAA's two benchmark
workbooks. The fixture records the original URLs, SHA-256 hashes and worksheet
names. The worksheet headings give t = 30, 40, 50, 60 and 70 for H/d = 0.0185
and t = 15, 20, 25 and 30 for H/d = 0.30. The site figure captions include
earlier theoretical frames and the URL for the stronger workbook contains
`0.03`. The worksheet heading and the benchmark's stated wave height
identify the stronger case as 0.30. [NOAA canonical beach benchmark](https://nctr.pmel.noaa.gov/benchmark/Laboratory/Laboratory_CanonicalBathymetry/index.html)

```sh
node scripts/run-with-timeout.mjs --max=3 -- node packages/physics/scripts/sea06-canonical-beach.mjs
```

Run from the repository root after building the Physics package. The
computational flume has one invariant row across the width and uses d
for length and √(d/g) for time. Its bed is `b = -min(1, x/19.85)` with
positive x seaward. Its closed offshore edge at x = 100 is beyond the
return path over the comparison. The dry end is x = −20. There is no
fitted friction, velocity or clock shift.

The initial surface is `H sech²(κ(x−X))`, where `κ = √(3H/4)`.
The 0.0185 case uses the exercise's fixed published X = 37.35. The
0.30 case uses NOAA's specified 5% initial toe elevation rule,
`X = 19.85 + acosh(√20)/κ`. Offshore discharge follows the continuity
relation `hu = −√(1+H) η`
for a steadily translating incoming wave. Across the tail that overlaps
the beach, the same velocity is multiplied by the local wet depth.
Observation heights are used only after the solver advances.
[Synolakis (1987), §5.2](https://doi.org/10.1017/S002211208700329X),
[Kristina et al. (2014), §5.1](https://doi.org/10.5194/npg-21-987-2014)

The comparison reconstructs surface at each original gauge coordinate
from exact bed plus interpolated depth. Four observations in the weaker
record and three in the stronger record are below the model's idealized
bed. The receipt counts them and includes their residuals in the RMS.
A dry reconstruction gives terrain altitude, with zero water depth.

| H/d | Δx/d | Per-profile RMS in units of d, in worksheet order | Largest point error |
| --- | --- | --- | --- |
| 0.0185 | 0.125 | 0.002783 / 0.004218 / 0.003868 / 0.003512 / 0.006697 | 0.027771 |
| 0.0185 | 0.0625 | 0.002810 / 0.004357 / 0.003933 / 0.003498 / 0.007531 | 0.029643 |
| 0.0185 | 0.03125 | 0.002826 / 0.004420 / 0.003977 / 0.003485 / 0.007885 | 0.027920 |
| 0.30 | 0.125 | 0.063983 / 0.057197 / 0.011518 / 0.009533 | 0.242855 |
| 0.30 | 0.0625 | 0.064653 / 0.060452 / 0.011731 / 0.009655 | 0.238222 |
| 0.30 | 0.03125 | 0.065961 / 0.061499 / 0.011956 / 0.009718 | 0.244894 |

The closed mass residual per unit width stayed below 4.84 × 10⁻¹³
in d². At the fine-grid t = 70 rundown the nonbreaking case gives
−0.03123d against −0.00331d at x/d = 0.6545454. At t = 15 the breaking
crest among sampled positions is 0.25090d at x/d = 6.53465
against 0.31349d at x/d = 8.37624. The predicted crest is farther
shoreward. Both discrepancies persist under refinement. A successful
diagnostic run confirms reproducibility and closure. It gives evidence of
the model's limits in both regimes.

On flat water at the released crest, the leftward shallow-water
characteristic has magnitude `|u| + √(1+H)`, namely 1.02754 at
H/d = 0.0185 and 1.40329 at H/d = 0.30. The translating solitary
wave speeds are 1.00921 and 1.14018. This explains why loss of the
dispersion–nonlinearity balance can lead and steepen the front. The local
characteristic is neither a predicted crest arrival time nor an estimate
of the separate moving-shoreline error. A dispersive extension can retain
the existing conservative shock and wet/dry method and advance a separate
Green–Naghdi pressure correction in smooth wet cells. Its flat-water
solitary and linear dispersion limits need separate checks before using
these profiles again. Near-shore wetting also needs its own convergence
check. [Bonneton et al. (2011), split Green–Naghdi model](https://arxiv.org/abs/1005.1586)

## Drähne et al. boundary-driven long waves

The publisher supplement specifies a 0.30 m offshore depth, a 1:40 plane
beach, a toe at x = 12 m and positive x seaward. WG1 at x = 27.72 m
supplies boundary elevation and incoming velocity. WG2 at x = 18.16 m,
WG3 at the toe and each run's camera trace are independent readbacks.
The original experiment clock starts at zero seconds and the pump's
nominal cycle starts at 10 seconds. Use the measured clock directly.
Both cases have H = 0.02 m. T30_H2 has T = 30 s, L = 51.47 m and
surf similarity 6.63. Its flat-water depth times wavenumber is 0.03662
and linear gravity-wave phase speed is 99.9777% of the nondispersive
value. T20_H2 begins closer to the nonbreaking-to-breaking transition,
with T = 20 s, L = 34.31 m and surf similarity 4.42. The authors
classify both as nonbreaking. [Drähne et al. (2016), §§2.2, 2.4, 2.5, Figures 7 and 9](https://doi.org/10.3390/jmse4010001)

The original publisher archive has SHA-256
`85bae342afed7f2adefe5e377c765d5a15f985d4ce30528279c31dd421efeb28`.
The extraction script records each input file hash. It applies a centered
one-second mean, the paper's suggested filter scale for the noisy WG1
instruments, and changes the measured incoming velocity to outward
positive at the offshore boundary. On a 0.05 s input lattice with 1 µm
and 1 µm/s quantization, linear interpolation differs from the filtered
100 Hz T30_H2 source by at most 10.011 µm in elevation and 0.182 mm/s
in normal speed. T20_H2 bounds are 8.624 µm and 0.173 mm/s. WG2 and WG3
are independently sampled on that same lattice without filtering, to
the nearest micrometre.
[Publisher data archive](https://mdpi-res.com/d_attachment/jmse/jmse-04-00001/article_deploy/jmse-04-00001-s001.zip)

```sh
python packages/physics/scripts/sea06-draehne-fixture.py /path/to/jmse-04-00001-s001.zip T30_H2
node scripts/run-with-timeout.mjs --max=3 -- node packages/physics/scripts/sea06-draehne-runup.mjs T30_H2
node scripts/run-with-timeout.mjs --max=3 -- node packages/physics/scripts/sea06-draehne-runup.mjs T20_H2
```

Table 3 fixes the experimental run-up scoring intervals at 40–57 s
for T30_H2 and 40–52 s for T20_H2. Camera tape-crossing elevation is
the observed landward position divided by 40.
The continuous turning point is bounded by the last and next 0.1 m marks,
with the stated ±5 mm horizontal camera readout and one cell width for
the discretized wet front. The script scores each run against its own
camera band on both grids and reports the independent gauge traces'
crest, timing and RMS residuals. Camera position and gauge holdouts
are never read by the boundary callback.

The two measured WG1 components include outgoing as well as incoming flow.
In T30_H2, using the recorded incoming characteristic with a still-water
outgoing characteristic would give incident crest heights of 8.475–9.368 mm.
The measured total WG1 crest heights are 10.152–11.067 mm. Actual boundary
evaluation keeps the solver's outgoing characteristic.

| Case | Grid spacing | Run-up heights in mm, in run order | Paired camera bands met |
| --- | --- | --- | --- |
| T30_H2 last recorded tape | — | 45 / 45 / 45 / 40 / 40 / 42.5 | — |
| T30_H2 | 0.04 m | 45.50 / 44.50 / 46.50 / 47.50 / 43.50 / 48.50 | 4 of 6 |
| T30_H2 | 0.02 m | 46.75 / 44.25 / 47.25 / 48.25 / 44.25 / 50.25 | 2 of 6 |
| T20_H2 last recorded tape | — | 45 / 45 / 42.5 / 40 / 40 / 40 | — |
| T20_H2 | 0.04 m | 56.50 / 56.50 / 55.50 / 55.50 / 54.50 / 53.50 | 0 of 6 |
| T20_H2 | 0.02 m | 58.25 / 57.25 / 57.25 / 56.75 / 55.25 / 54.75 | 0 of 6 |

The mass balance including the measured boundary flux resolved to
1.76 × 10⁻¹³ m² per unit width. On the 0.02 m grid, WG2 and WG3 RMS
errors across runs range from 1.21–2.45 mm for T20_H2 and 1.20–2.41 mm
for T30_H2. In both cases all modeled crests at WG2 and WG3 were below
the measured crests, even though most shoreline comparisons overrun
their camera bands. Grid refinement preserves the discrepancy. The
authors report that T20_H2's measured run-up falls below inviscid
theory and identify possible viscous bed loss and capillary effects
in the shallow wave tongue. These runs used zero Manning roughness.
The comparison does not identify the respective contributions of
friction, surface tension, wet-front discretization or forcing
uncertainty. [Drähne et al. (2016), §§2.3 and 3.4.1](https://doi.org/10.3390/jmse4010001)

Both diagnostic invocations currently return a failed camera comparison
after printing the individual runs. The four laboratory cases here
leave measured validation open.
