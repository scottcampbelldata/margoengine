# SEA-04 steady tow and measured stem

This opt-in diagnostic tests the moving side and translating free-surface conditions on the published full Wigley geometry before scoring the nine independent University of Tokyo waterline stations. The analytic offsets, nominal tank depth and width, modes of tow, draft, and speeds come from the original cooperative experiment. The benchmark transcription and the earlier live HullSolver–WakeSolver score remain separate. [Kajitani et al., 1983](https://archive.org/details/DTIC_ADP003037) · [Earlier measured stem fixture](./sea04-stem.md)

## Operator and independent controls

Let x increase forward in the hull frame and y increase upward from the undisturbed surface. For perturbation potential φ and free-surface elevation η, the steady convective kinematic equation is φ_y = −Uη_x and linear Bernoulli gives gη = Uφ_x. The diagnostic adds a positive limiting absorption σ to the shared material derivative D = σ − U∂x. The equivalent equations are φ_y = Dη and gη = −Dφ. The damping is positive and quintic over two finite-depth transverse wavelengths at each end. The channel centreline, sidewall, and floor are reflective, and each longitudinal end has zero perturbation normal flow behind the absorbed region. The approach follows the linear convective form described in the Neumann–Kelvin and Neumann–Michell literature. The sparse finite-volume discretization is specific to this diagnostic. [Noblesse, Huang and Yang, 2013](https://doi.org/10.1007/s10665-012-9568-7) · [Huang et al., 2013 numerical formulation](https://www.sciencedirect.com/science/article/pii/S0997754613000514) · [Peng, Ni and Qiu, 2014 finite-depth radiating formulation](https://www.sciencedirect.com/science/article/pii/S0029801814002170)

The cross-sectional and vertical clipping integrals are analytic on the parabolic hull. Transverse faces use 12-point Gauss panels split at both depth-edge cuts. All cell connections share their aperture. The wetted hull enforces the integrated perturbation condition ∂ₙφ = U n_x using the exact local displaced longitudinal open-area difference. The production QuayPotential manufactured rectangle recovers φ = Ux to 7.12e−13 m²/s with zero surface rise to 1.14e−11 m/s. Its prescribed hull fluxes are +0.3125 and −0.3125 m³/s, and flipping the hull sign produces 0.4673 m²/s potential error and 2.833 m/s spurious rise. QuayPotential provides its existing surface-Dirichlet bulk solve. The Wigley steady solve assembles the convective trace block separately.

For an undamped finite-depth traveling mode with gk tanh(kH) = U²k², doubling the exposed surface resolution reduces manufactured normal and elevation errors by 3.91× and 4.00×. A derivative-of-Gaussian source in an empty channel radiates 3.410 mm RMS downstream against 3.475 mm from the analytical outgoing residue, and 0.014 mm RMS upstream. Six downstream zero crossings are recovered over three wavelengths. The initial arbitrary 10 mm excitation threshold was inconsistent with the prescribed analytical amplitude. Its failed receipt is preserved, and the final control applies a numerical error bound around the analytical residue.

The first operator composes the centred x derivative twice. After preserving its forecast and score, a separate spectral control detects a spurious high-wavenumber root in the exact layered-channel matrix at all four speed and grid combinations. Its Fourier convective symbol is proportional to sin²(kΔx) and returns to zero at Nyquist. The alternative uses 4 sin²(kΔx/2) for the interior second derivative and wet-run endpoint stencils. The independently frozen damping and all physical inputs are shared. At 50 mm and Froude 0.267 the original graph predicts 5.71796 and 47.34999 rad/m, compared with the exact physical 5.61096 rad/m. The alternative predicts only 5.60109 rad/m. The alternative channel radiates 3.515 mm downstream and 0.335 mm upstream against the same 3.475 mm outgoing residue. This same-settings branch checks the fixed discretization defect separately from the measured discrepancy.

## Reproduce

Use Python with NumPy and SciPy, Node, and the same Physics build as the earlier fixture. The production QuayPotential proof imports the original fixture's built snapshot. See the prior fixture for reproducing that snapshot and the required legacy score receipt. The manufactured and radiation gates run before the forecasts. Numerical forecasts and all hashes are written under ignored `test-results/sea04-stem`. A fine solve used about 2.8 GiB during this comparison. Run the fine cases sequentially on memory-constrained hosts.

```powershell
$env:OPENBLAS_NUM_THREADS = '2'
node scripts/run-with-timeout.mjs --max 1 -- node packages/physics/scripts/sea04-stem-tow-quay.mjs
node scripts/run-with-timeout.mjs --max 2 -- python packages/physics/scripts/sea04-stem-tow.py controls
foreach ($grid in 'coarse','fine') {
  foreach ($froude in .267,.316) {
    node scripts/run-with-timeout.mjs --max 3 -- python packages/physics/scripts/sea04-stem-tow.py predict --grid $grid --froude $froude
  }
}
node scripts/run-with-timeout.mjs --max 3 -- python packages/physics/scripts/sea04-stem-tow.py predict --extra 1.25
node scripts/run-with-timeout.mjs --max 3 -- python packages/physics/scripts/sea04-stem-tow.py predict --interior .0025
python packages/physics/scripts/sea04-stem-tow.py freeze
python packages/physics/scripts/sea04-stem-tow.py score
node scripts/run-with-timeout.mjs --max 2 -- python packages/physics/scripts/sea04-stem-tow-contact.py controls
foreach ($grid in 'coarse','fine') {
  foreach ($froude in .267,.316) {
    node scripts/run-with-timeout.mjs --max 3 -- python packages/physics/scripts/sea04-stem-tow-contact.py predict --grid $grid --froude $froude
  }
  node scripts/run-with-timeout.mjs --max 3 -- python packages/physics/scripts/sea04-stem-tow-contact.py predict --grid $grid --shift 0
}
python packages/physics/scripts/sea04-stem-tow-contact.py seal
python packages/physics/scripts/sea04-stem-tow-contact.py score
```

## Frozen measured comparison

| Froude | Held-out stem | Live source stem, 25 mm | Live depth-band stem, 25 mm | Cut side stem, 100 mm | Cut side stem, 50 mm | Cut side profile RMS, 50 mm |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0.267 | 43.843 mm | 16.424 mm | 9.522 mm | 19.993 mm | 8.170 mm | 25.855 mm |
| 0.316 | 39.942 mm | 14.527 mm | 9.281 mm | 0.018 mm | 7.161 mm | 33.096 mm |

The live surface-source profile RMS values are 19.890 and 28.249 mm, and the depth-banded profile RMS values are 27.073 and 35.789 mm. The two deterministic radiation controls extend each end by 1.25 m and separately halve interior absorption at Froude 0.267. The coarse predicted stem changes 1.418 and 0.066 mm, respectively. The computed net body-boundary flux is below 1.4e−18 m³/s in both baseline grids. This verifies the moving-side flux accounting while the measured acceptance remains open. The current surface trace linearizes about the undisturbed waterplane and uses Cartesian cell-centre values and one-sided connected-wet rows at the hull. A wet aperture can occupy only part of a top cell. The sampling uses lateral extrapolation from the nearest two active column centres and linear interpolation in x. This is a distinct discretization issue alongside nonlinear physical run-up. The original experiment provides its printed ordinate resolution without a probe uncertainty estimate.


## Bordered outgoing closure

The alternate interior stencil exposes a separate failure at the upstream computational end. The empty-tank oblique n = 4 forcing produces a 24.689 mm upstream excursion from a 0.857 mm near-source peak. The largest coarse Wigley excursions occupy fully wet outer cells and reach 0.714 m at one lattice phase and 5.810 m at another. A mirrored free-surface ghost consistent with the bulk Neumann wall fails the same control. Its coarse hull excursions reach 1.290 and 18.236 m. Those are rejected boundary variants. The signed failed forecasts remain in the result directory.

The exact straight-end closure keeps the discrete potential and surface operators consistent. Each transverse cosine mode reduces the uniform grid strip to depth-column matrices A₋, A₀ and A₊. The quadratic pencil A₋ + ζ A₀ + ζ²A₊ supplies axial multipliers ζ. Positive uniform limiting absorption selects modes with |ζ| > 1 on the aft side and |ζ| < 1 on the forward side. Each tested empty-tank 15-unknown column has 16 aft and 14 forward modes. The two traveling conjugates propagate aft. Independent outgoing modal amplitudes are included as bordered unknowns and matched to the interior end state. The rectangular mode groups permit both radiated conjugates to exit aft. The full solver maps every cosine mode back onto the end cells. It uses the interior absorption value throughout, replacing both absorbing fringes and their terminating walls. The body apertures, speed, gravity, tank breadth and depth, and measured station sampling stay fixed.

For the n = 4 empty-tank mode, the 0.634 mm near peak produces 3.986e−15 m far upstream. Adding 32 cells at both ends changes the restricted field by 4.28e−15 relative and the tow-reversal transpose check closes to 1.64e−13. The completely assembled 3D empty tank matches its separate modal solution to 4.46e−13 relative at every surface cell. The controls exercise the left and right operators and validate the absence of a spurious reflected upstream mode. They qualify the exact straight-end closure for this finite-volume model. They leave the approximation at the actual waterline in scope for its independent convergence score.

```powershell
node scripts/run-with-timeout.mjs --max 2 -- python -B packages/physics/scripts/sea04-stem-tow-radiation.py modal
node scripts/run-with-timeout.mjs --max 2 -- python -B packages/physics/scripts/sea04-stem-tow-radiation.py mapping
foreach ($grid in 'coarse','fine') {
  foreach ($froude in .267,.316) {
    node scripts/run-with-timeout.mjs --max 4 -- python -B packages/physics/scripts/sea04-stem-tow-radiation.py predict --grid $grid --froude $froude
  }
}
python -B packages/physics/scripts/sea04-stem-tow-radiation.py score
```

The sealed bordered-hull comparison failed at both resolutions.

| Froude | 100 mm stem | 50 mm stem | Measured stem | 50 mm nine-station RMS | 50 mm maximum elevation |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0.267 | 622.595 mm | 620.816 mm | 43.843 mm | 608.008 mm | 874.459 m |
| 0.316 | 494.516 mm | 769.933 mm | 39.942 mm | 736.994 mm | 303.125 m |

Both fine cases peak in the same aft partly exposed top cell at x = −0.6625 m, z = 0.075 m, with 20.26% wet area. The fine relative residuals are 6.42e−8 and 6.88e−8 against the 1e−8 gate. The coarse Froude 0.316 run passes its linear residual gate while the physical surface amplitude is over 2,000 drafts. The shape and straight-end controls isolate a failure of the current waterline closure. All four prediction packets were sealed before the comparison. The rejected score SHA-256 is `d37412900fe7e070198f79f71193cdcb1dac5b59314e550733bbbceec2ef270f`.

## Conservative contact ablations

The weak trace equation uses each shared axial opening width b with face mass bΔx. Let G take the potential difference divided by Δx and J take the midpoint. With C = JᵀMfG, K = GᵀMfG, and W the exposed area, the immersed-point trace block uses σ²W + σU(Cᵀ−C) − U²K. The limiting absorption cross term has zero real quadratic work. The paired face stiffness exactly reproduces its work, and neither coefficient divides by the area of a partly exposed cell. Boundary rows retain the uniform operator expected by the outgoing pencil. The cut-surface linear gradient error is 1.07e−14, the constant error is 1.11e−16, and face energy closes to 1.42e−13. The mapped empty-tank oblique field matches the separate exact mode to 3.30e−13 relative.

The weak cut-hull 100 mm trials remove the large upstream contamination. The peak upstream field drops to 0.011 and 0.194 mm at Froude 0.267 and 0.316 with relative linear residuals 2.09e−12 and 4.77e−10. But the worst aft surface elevations are 12.58 and 1,694.74 m in the same 3.74%-exposed cell. It is geometrically dry at its Cartesian centre. Restricting nine dry-centred traces using affine-exact extrapolation from physical wet centres and the matching Galerkin transpose reproduces transverse affine fields to 2.78e−17 m. The largest resulting elevations move into fully exposed aft cells and grow to 3,793 and 2,369 m. Both variants are rejected. No independent measurements entered these ablations.

An unchanged-source control puts the identical signed cut-hull bulk right-hand side into the uncut wet graph. It retains the same exact transverse modes, layered potential, tow speeds, and bordered radiation. The coarse global peaks are 19.704 and 28.702 mm, and the upstream excursions are 5.39 and 7.57 μm. Relative linear residuals are at most 1.03e−13. This isolates the instability to the coupled cut-hull free-surface/contact treatment. The source flux, broad mode excitation, exact outgoing strip, and small area alone cannot account for the failure.

```powershell
node scripts/run-with-timeout.mjs --max 2 -- python -B packages/physics/scripts/sea04-stem-tow-weak.py controls
node scripts/run-with-timeout.mjs --max 2 -- python -B packages/physics/scripts/sea04-stem-tow-weak.py source-control
foreach ($froude in .267,.316) {
  node scripts/run-with-timeout.mjs --max 3 -- python -B packages/physics/scripts/sea04-stem-tow-weak.py predict --froude $froude
  node scripts/run-with-timeout.mjs --max 3 -- python -B packages/physics/scripts/sea04-stem-tow-weak.py predict --froude $froude --tied
}
```

Measured stem acceptance requires an independently validated hull-aligned nonlinear free surface with consistent hull and waterline kinematics. Raven’s published nonlinear RAPID solution for the same fixed-sinkage, fixed-trim Wigley benchmark at Froude 0.316 remains about 11% low at its finest bow crest, with broader deviation for the linear Neumann–Kelvin and Dawson methods. Raven discusses spray uncertainty and resolution of the singular bow flow. Mola, Heltai and DeSimone provide an implementable alternative using a deforming hull-fitted surface, potential-flow boundary elements, implicit time integration, and upwind stabilization. Their waterline velocity must simultaneously satisfy the hull and free-surface normal conditions. Their Wigley comparisons retain a mesh-scale oscillation that a new implementation would need to quantify. [Raven, 1996, §9.1 p. 152](https://www.vliz.be/imisdocs/publications/72/385172.pdf#page=158) · [Mola, Heltai and DeSimone, 2013, Eq. 33 and Fig. 10](https://arxiv.org/pdf/1203.3384)
