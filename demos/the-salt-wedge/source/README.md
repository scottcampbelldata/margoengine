# The Salt Wedge

Increase river discharge from 80 to 146 m³/s. The modeled saltwater wedge retreats toward the mouth and becomes shallower there. The thin light boundary marks the layer interface. The pale dashes show fresh water flowing seaward. Pause or step the dashes to compare two steady profiles without motion.

## Two-layer model

The ideal channel is horizontal and rectangular, 70 m wide and 4.6 m deep. Freshwater density is **ρ₁ = 1,002 kg/m³** and saltwater density is **ρ₂ = 1,023 kg/m³**. Reduced gravity is **g′ = g(ρ₂ − ρ₁)/ρ₁**. The lower layer is stationary. The upper layer carries discharge per unit width **q = Q/B** at speed **q/h₁**. Interfacial shear has magnitude **τ = ρ₁ Cᵢ(q/h₁)²** with **Cᵢ = 0.0038**. This convention absorbs any factor of one half into the chosen coefficient.

For **x** positive inland from the mouth, **H** the channel depth, **s = h₁/H**, and **F = q/√(g′H³)**, the steady Boussinesq, hydrostatic layer-momentum equations give **dx/ds = H(1 − s)(s³ − F²)/(Cᵢ F²)**. The mouth is an internal hydraulic control **s₀ = F^(2/3)**. Integrating from **s₀** yields the inland profile. The toe is where **s = 1**. The app inverts the profile by bisection so the rendered interface matches the computed fresh depth at each station. The approximation takes total depth as constant and uses an abrupt interface. Within the selected discharge range, **F** stays between 0.26 and 0.47 and the intrusion fits within the modeled 676 m reach.

Each discharge selects its own steady profile. The illustrated setting is a generic coastal reach. The visible vertical scale is enlarged by about 17× relative to plan. The survey buoy marks the mouth. The offshore color beyond it is a continuation for visual context. Pale tracer streaks illustrate depth-averaged upper-layer transport at 72× time. Tides, entrainment, bottom slope, channel convergence and the transient adjustment between discharges are outside this model.

## References and provenance

- [Johannes B. Schijf and Johannes C. Schönfeld, *Theoretical considerations on the motion of salt and freshwater*, 1953](https://repository.tudelft.nl/file/File_a7f0dd0b-13bd-4999-990e-20b539ee011f). Canonical arrested wedge in a river without tides.
- [Anthony R. Poggioli and Alexander R. Horner-Devine, *The Sensitivity of Salt Wedge Estuaries to Channel Geometry*, 2015](https://doi.org/10.1175/JPO-D-14-0218.1). Flat-channel analytical solution and the influence of slope and width.
- [Frank E. Sargent and Gerhard H. Jirka, *Experiments on Saline Wedge*, 1987](https://doi.org/10.1061/(ASCE)0733-9429(1987)113:10(1307)). Experimental structure of a saline wedge over a horizontal bottom.
- [U.S. Geological Survey, *Groundwater and surface-water interactions in the Lower Duwamish Waterway, Seattle, Washington*, 2024](https://pubs.usgs.gov/publication/sir20245046/full). Field context for denser seawater beneath freshwater, with real tides and spatial complexity.

The cutaway, coast, lighthouse, reeds and water surfaces are original. Both renderer paths display the same geometry using the showcase's pinned public Margo Engine. Serve the normal showcase build over HTTP. Add `?backend=webgl2` to exercise Margo's compatibility renderer.
