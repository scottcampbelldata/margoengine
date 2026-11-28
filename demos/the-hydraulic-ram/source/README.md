# The Hydraulic Ram

Raise or lower the delivery height and compare how much water is lifted on each settled cycle. Watch the open waste valve admit drive flow, the waste poppet shut, and the delivery check lift when body pressure exceeds the trapped air pressure. The compressed air keeps pressing on the water while the drive pipe recovers. Pause the cycle to inspect it. With reduced motion enabled, the button steps through the cycle.

## Lumped physical model

The modeled source is 1.6 m above the pump. An 8 m, 42 mm drive line supplies a compliant junction. The indicated delivery height is the static pressure load of an external riser, above the pump datum. The visible tube is a compact representation of the rig. The model uses water at 20 °C, 998.21 kg/m³ (Kell 1975).

The drive momentum balance is I dQᵈ/dt = ρgHₛ − p − K Qᵈ|Qᵈ|. Here I = ρL/A, p is junction gauge pressure, and the quadratic resistance K is 1.14 × 10¹⁰ Pa·s²/m⁶. The single junction storage relation is C dp/dt = Qᵈ − Qʷ − Qᶜ with effective compliance C = 7.5 × 10⁻¹⁰ m³/Pa. Flow to waste is proportional to the waste opening and √max(p,0). Flow through the delivery check is proportional to √max(p − pₐ,0). Flow up the riser is proportional to √max(pₐ − ρgHᵈ,0).

A constant-mass, polytropic air pocket occupies the remainder of a 2.30 L vessel. Its absolute pressure is P₀[V₀/(V₀ − Vʷ)]¹·²⁴, with P₀ atmospheric pressure and V₀ the dry tank volume. Air gauge pressure pₐ is absolute pressure minus P₀. Tank water storage obeys dVʷ/dt = Qᶜ − Qᵒ, where Qᵒ is delivered flow. The combined balance is d(Cp + Vʷ)/dt = Qᵈ − Qʷ − Qᵒ. Midpoint steps use the same time-integrated fluxes for these water-balance checks and for the displayed average.

The waste poppet begins closing when waste flow reaches 47.28 L/min, representing the lift force overcoming its weight. The opening falls over 36 ms. The poppet reopens over 55 ms after the closed minimum hold and recovery below the reopening pressure. The delivery check responds to the calculated pressure difference without a reverse path. Each slider setting selects a settled, primed cycle from the numerical solution. The display plays at 0.52 times simulated time so the valves can be seen.

The assumed orifice coefficients, waste threshold and effective compliance describe a teaching rig. They were chosen to demonstrate a repeating cycle from 2.6–5.8 m. The model does not solve distributed pressure waves, detailed valve forces, priming, leakage, air dissolution, or cavitation. Valve travel and visible water marks indicate phase, direction and presence of flow. They do not prescribe component dimensions or local velocities.

## Implementation

- `cycle.js` holds the rig's dimensions and valve settings; `@margoengine/physics/hydraulics` (`HydraulicRam`) integrates the water column, valves and air pocket, tracks the conserved water volumes and finds the repeating cycle.
- `craft.js` and `machine.js` build the bench, transparent vessel, valves and traced flow directly in Margo.
- `scene.js` implements the controls. Native Margo WebGPU opens first. Add `?backend=webgl2` to request the Margo compatibility renderer with the same artwork.
- Build from the showcase root with `node build.mjs the-hydraulic-ram` and the verified public Margo revision pinned by the showcase.

## References

- Ghislain O. Lungudi, Sherifa Cohen, Saber Nasraoui, Capucine Dupont, Sergio G. Salinas-Rodriguez, Maria Kennedy and David Ferras (2024). Mechanism, cycle phases and measured hydraulic ram behavior. [Numerical and experimental analyses of hydraulic rams](https://doi.org/10.1080/00221686.2024.2401899).
- Stefania Evangelista, Giuseppe Tortora and Giacomo Viccione (2023). Experimental measurements of waste valve closure and the subsequent surge into the air chamber. [Experimental and Numerical CFD Modelling of the Hydrodynamic Effects Induced by a Ram Pump Waste Valve](https://doi.org/10.3390/su151713104).
- Engol Enongene Ebong George and Seong Gu Hong (2019). Laboratory apparatus, air storage and pressure delivery. [Experimental Study on the Effect of Air Chamber Size and Operation Parameters on the Performance of a Hydraulic Ram Pump](https://doi.org/10.5389/KSAE.2019.61.4.055).