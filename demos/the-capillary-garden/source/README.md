# The Capillary Garden

Five open-ended risers share the same bath. They have radii of 0.15, 0.21, 0.29, 0.40 and 0.59 mm. Changing the contact angle selects a new wetting condition at the current model time. Use **Replay rise** to compare two conditions from immersion. The session opens thirty-two simulated seconds into a rise. Under reduced-motion settings, **Step +5 s** advances the same solution. The vertical scale is in metres, and the scene enlarges the bores horizontally by 12× to show the liquid in the narrowest tubes. Playback advances model time at 5× wall time.

## Washburn rise with an immersed inlet

The liquid is an illustrative viscous aqueous mixture with density **ρ = 1,130 kg/m³**, viscosity **μ = 0.022 Pa·s** and surface tension **γ = 0.068 N/m**. Gravity is **g = 9.80665 m/s²**. The bath free surface is the zero of height, with **d = 22 mm** of submerged inlet tube already filled when the replay starts.

For tube radius **r** and contact angle **θ**, the Young–Laplace driving pressure is **Δp = 2γ cos θ / r**. The hydrostatic term **ρgh** opposes the rise. Balancing the remaining pressure against no-slip Poiseuille resistance across the full wetted length **h + d** gives **dh/dt = r²(Δp − ρgh) / [8μ(h + d)]**. At rest this gives Jurin's height **H = Δp/(ρg)**. For the rise from **h = 0**, integration gives **t = [8μ/(ρgr²)] [−(H + d) ln(1 − h/H) − h]**. The app inverts this monotonic relation by bisection. All visible water columns follow the time series and their concave menisci use a spherical-cap outline at the model contact angle.

The exhibit varies **θ** from 12° to 70° and holds the bath level constant. Across its stated range the diameter-based Reynolds number is below 1.3, the radius-based Bond number is below 0.06, and the capillary number stays below 0.007. The prefilled inlet represents the viscous stage with a finite initial wet length. Very early inertial adjustment, entrance losses, pinning, advancing-angle hysteresis, and changes in bulk properties fall outside the model.

## References and provenance

- [James Jurin, *An account of some experiments shewn before the Royal Society; with an enquiry into the cause of the ascent and suspension of water in capillary tubes*, Philosophical Transactions, 1718](https://doi.org/10.1098/rstl.1717.0026). Equilibrium capillary height and inverse radius dependence.
- [Edward W. Washburn, *The Dynamics of Capillary Flow*, Physical Review, 1921](https://doi.org/10.1103/PhysRev.17.273). Viscous pressure-driven uptake in a cylindrical bore.
- [Nicolas Fries and Michael Dreyer, *An analytic solution of capillary rise restrained by gravity*, Journal of Colloid and Interface Science, 2008](https://doi.org/10.1016/j.jcis.2008.01.009). Gravity-limited rise and the time–height equation. The exhibit includes the fixed, immersed inlet length in the viscous resistance.
- [David Quéré, *Inertial capillarity*, Europhysics Letters, 1997](https://doi.org/10.1209/epl/i1997-00389-2). Inertial stages at the start of contact and the transition to viscous behavior.
- [Royal Botanic Gardens, Kew, *In Pictures: Kew Gardens, then and now*](https://www.kew.org/read-and-watch/kew-gardens-in-pictures-then-and-now). Archival reference for curved iron glazing, tiled foregrounds and foliage. The conservatory, plants, risers and material maps are original to the exhibit.

The normal showcase build uses the recorded public Margo Engine commit. The exhibit uses the same model and artwork with Margo WebGPU and WebGL2. Append `?backend=webgl2` to exercise the compatibility path.
