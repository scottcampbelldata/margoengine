# The Cable Span

Move the proof cart from one tower to the other. The timber deck and both suspension cables move with it. Turn on “Unloaded cable” and switch to side view to see how shifting the same load changes the cable profile. The unloaded reference includes the bridge’s own weight.

## Engineering model

The two identical main cables share the centered load equally. Each uses a horizontal span of 24 m, saddle height 4.45 m, rest sag 3.21 m, vertical dead load of 0.42 kN/m of horizontal span, and effective axial rigidity EA of 25,000 kN. The cart applies 9.8 kN to the pair, idealized as a concentrated load at its center. The measured vertical reactions are the totals for both cables on each side. “Peak cable tension” gives the larger resultant at the two saddles for one cable.

For one cable, the vertical force on a cut is V(x) = Rwest − qx − P·I(x ≥ a), where a is the cart station and P is its load on one cable. The cable equilibrium gives downwards slope V/H with horizontal tension H. Integrating from the west saddle gives y(x) = (Rwest·x − qx²/2 − P·max(0, x − a))/H. The rest geometry fixes the cable’s unstrained length. At each station, a bracketed solve finds H so that the elastic length integral ∫√(1 + (V/H)²)/(1 + √(H² + V²)/EA) dx returns that same length, splitting quadrature at the load. The rendered central deck uses the live minus dead cable displacement through ideal vertical hangers. An end load at a tower produces no interior displacement and goes directly into its support.

The study treats the bridge as an unstiffened, articulated deck and the tower saddles as fixed. It neglects wind, vibration, lateral loads, deck bending stiffness, cable self-weight along the arc, slack hangers, and anchor-span interactions. Deck and cable movement are drawn at the same scale, with fittings and wire thicknesses sized for the exhibit.

## Implementation

- `equilibrium.js` solves the elastic cable profile and reactions.
- `bridge.js`, `gorge.js`, and `craft.js` author the suspension hardware, timber deck, moving cart and cutaway gorge.
- `scene.js` connects the range control, render loop, and measurements. Native Margo WebGPU opens first. Add `?backend=webgl2` to request the Margo compatibility backend. Both use the same meshes, materials, and lighting.
- Build from the showcase root with `node build.mjs the-cable-span` with `MARGO_ENGINE_CHECKOUT` pointing at the public Margo revision pinned by the showcase build.

## References

- Chuanxi Li, Jun He, Zhe Zhang, Yang Liu, Hongjun Ke, Chuangwen Dong and Hongli Li (2018). Perfectly flexible elastic cable assumptions and axial compatibility. [An Improved Analytical Algorithm on Main Cable System of Suspension Bridge](https://doi.org/10.3390/app8081358).
- Zhijun Chen, Hongyou Cao and Hongping Zhu (2013). Suspension-bridge form finding with equilibrium and unstrained cable length. [An Iterative Calculation Method for Suspension Bridge’s Cable System Based on Exact Catenary Theory](https://doi.org/10.3846/bjrbe.2013.25).
- Felix Udoeyo. Equilibrium for concentrated and distributed loads, reactions, and the general cable theorem. [Structural Analysis, Chapter 6](https://eng.libretexts.org/Bookshelves/Civil_Engineering/Structural_Analysis_%28Udoeyo%29/01%3A_Chapters/1.06%3A_Arches_and_Cables).
- California Department of Parks and Recreation (2019). Reference for timber suspension footbridge proportions, anchorages and visible structural hardware. [Trail Bridges, §16.2.11](https://www.parks.ca.gov/pages/1324/files/Chapter%2016%20-%20Trail%20Bridges.FINAL.04.04.19.pdf).
- Reutte Nature Park Region. Reference for gorge footbridge presentation and construction. [Highline179 Construction and Commissioning](https://www.reutte.com/en/the-region/highlights/highline179/construction-and-commissioning).