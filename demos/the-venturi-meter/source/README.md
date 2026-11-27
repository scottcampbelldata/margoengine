# The Venturi Meter

Change the flow through the glass constriction. The dye moves faster at the throat, and a lower water surface in the throat piezometer shows the reduction in static pressure. “Show water head” marks the two free-surface levels on the rig.

## Flow and pressure model

The filled horizontal pipe has a 53 mm approach diameter and a 26 mm throat diameter. The flow control supplies 0–50 L/min, converted to cubic meters per second. The model uses water density 998.2 kg/m³ and standard gravity 9.80665 m/s².

Continuity gives Q = A₁v₁ = A₂v₂, with each area calculated from the same radii used in the displayed tube. For steady incompressible flow along the horizontal approach and throat, the ideal Bernoulli pressure difference is p₁ − p₂ = ρ(v₂² − v₁²)/2. The open piezometer height difference is Δp/(ρg). The bench supply maintains a constant upstream head of 27 cm of water, and the throat column falls by that calculated difference. In the zero-flow state, both columns show the same level.

The tracer positions use the local area. Advancing cumulative pipe volume by Q Δt and inverting the volume-to-position table gives the local mean velocity Q/A(x). The tracer marks sit along the visible face of the dyed core so that they remain legible through the glass. They represent cross-section mean speed, without resolving a velocity profile. The steady model gives ideal pressure difference and does not model friction, boundary layers, transient pressure, cavitation, tube flex or a meter calibration coefficient. The glass uses translucent view-dependent materials. The reflections are illustrative and omit optical refraction and caustics.

## Implementation

- `flow.js` defines the pipe profile and calculates velocity, pressure head and tracer coordinates.
- `craft.js` and `meter.js` build the glass constriction, milled fixtures, calibrated scales, open pressure columns and moving menisci in Margo.
- `scene.js` connects the controls and provides WebGPU-first rendering. Use `?backend=webgl2` to request Margo’s compatibility backend with the same artwork.
- Build from the showcase root with `node build.mjs the-venturi-meter` and the verified public Margo checkout pinned by the showcase build.

## References

- U.S. Bureau of Reclamation (2001). Horizontal Venturi continuity, energy balance and pressure tap measurements. [Water Measurement Manual, Chapter 2 §14](https://www.usbr.gov/tsc/techreferences/mands/wmm/chap02_14.html).
- U.S. Bureau of Reclamation (2001). Correction coefficients for departures from ideal flow and practical meter calibration. [Water Measurement Manual, Chapter 2 §15](https://www.usbr.gov/tsc/techreferences/mands/wmm/chap02_15.html).
- NASA Glenn Research Center. Static pressure and velocity relation and assumptions. [Bernoulli’s Equation](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/bernoullis-equation/).
- NASA Glenn Research Center. Velocity and cross-sectional area for a fixed volumetric or mass flow. [Mass Flow Rate Equations](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/mass-flow-rate-equations/).