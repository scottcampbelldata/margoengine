# The Siphon

Lower the brass outlet to send water from the raised reservoir, over the glass crown and into the catch basin. Return the outlet to the source waterline to stop the flow. “Show waterline” marks the height difference that drives the siphon.

## Hydraulic model

The tube starts full. The raised reservoir is open to the atmosphere and replenished at a fixed water level. The receiver is open and drained, and the nozzle discharges into air throughout the control's 0–18 cm range. The source surface and outlet therefore have the same ambient pressure. The source level, crown elevation and sink level are 0.321 m, 0.496 m and 0.087 m in scene coordinates. A self-leveling tip on the swinging arm gives vertical free discharge. The bore is 13 mm. The length is calculated from the authored straight runs, crown bends, rigid articulated arm and outlet. The model takes water at about 20 °C with density 998.2 kg/m³ and kinematic viscosity 1.004 × 10⁻⁶ m²/s.

The steady energy equation from reservoir surface to the free outlet is h = (1 + ΣK + fL/D) v²/(2g). The unit term is the velocity head at the open nozzle. The assumed fitting-loss coefficients sum to 1.65. A bracketed solve finds v using the Darcy–Weisbach loss, Churchill's all-regime correlation and an assumed effective roughness of 1.5 µm. The displayed discharge is the bore area times v. Crown pressure is gauge pressure from the same energy equation evaluated at the top of the tube, with the upstream length and an assumed upstream fitting coefficient of 0.70. At equal elevation, discharge and outlet speed are zero and the static crown pressure is below atmosphere because the water column is still present in the model.

The displayed jet contracts using conservation of area times speed under gravity. Dye dashes move along the centerline at model speed as a visualization aid. Constant levels stand in for concealed supply and drain plumbing. Margo renders the translucent glass and uses original view-dependent studio reflection maps for the glass, brass, nickel and dyed water. The water shading, tracer intensity and ripples are illustrative. The optical treatment does not solve refraction, caustics or multiple reflections between surfaces. The study assumes an intact prime and quasisteady flow. It does not simulate air ingress, priming, drain-down, transients, boiling, or laboratory-measured fitting coefficients.

## Implementation

- `hydraulics.js` defines the instrument dimensions and solves head, discharge and pressure.
- `apparatus.js` and `geometry.js` build the glass vessel profiles, falling jet, rotating arm, hairline measurement guide and original gallery geometry. `studio.js` creates the reflection maps from a procedural studio lighting rig.
- `scene.js` connects the outlet control and renders through Margo Engine, using native WebGPU first. Add `?backend=webgl2` to test the Margo WebGL2 compatibility path with the same artwork.
- Build from the showcase root using `node build.mjs the-siphon` and the public Margo checkout pinned by the showcase build.

## References

- U.S. Bureau of Reclamation (2001). Free discharge and effective head for siphon tubes. [Water Measurement Manual, Chapter 14 §14](https://www.usbr.gov/tsc/techreferences/mands/wmm/chap14_14.html).
- A. Boatwright, S. Hughes, and J. Barry (2015). Primed operation and reduced pressure at the crown. [The height limit of a siphon](https://doi.org/10.1038/srep16790).
- Stuart W. Churchill (1977). Darcy friction factor spanning laminar, transitional and turbulent regimes. [Friction-factor equation spans all fluid-flow regimes](https://files.engineering.com/files/85c0f3a6-a102-4a22-9d35-f15858c0dd2b/CEM_-_Friction-factor_equation_%281977%29.pdf).
- Nebraska Department of Roads (2006). Energy equation and fitting loss coefficients. [Drainage and Erosion Control Manual, Chapter 1](https://govdocs.nebraska.gov/epubs/R6000/H056-2011.pdf).
- James W. Queen & Co. Laboratory siphons in brass and glass, used as a period material reference. [Scientific apparatus catalog, Smithsonian Libraries](https://www.sil.si.edu/DigitalCollections/trade-literature/scientific-instruments/pdf/sil14-52536.pdf).
- Science Museum Group. Blown laboratory glass reference. [Syphon Tube, 1877–1900](https://collection.sciencemuseumgroup.org.uk/objects/co2787).