# Trees From Space

Exhibit 121 explores space-colonisation growth above and below a specimen tray. Select **Insert barriers** to put a canopy plate and a buried block into the model. The seed and destination volumes stay fixed while the browser solves new paths around both obstacles. **Side view** exposes the depth of the paths, and **Growth replay** reveals each solved branch outward from its origin.

## Growth and obstacle handling

The browser worker uses the public Margo `createTreeGenerator` Rust/Wasm package for each actual extension. For each step, attraction points pull their nearest eligible skeleton nodes. A node grows in the direction of the summed pull, and points within the kill radius are consumed. The authored seed clouds above and below the soil define the spaces the tree can reach.

The pinned engine's solver returns an unconstrained connected skeleton. The exhibit directs it through explicitly admissible approach corridors. It excludes attraction points inside the padded barriers and admits a generated segment only when its parent is connected and the segment clears the padded box. Branch lengths and curves come from the solver. The chambers, branch skins, and leaf meshes are procedural exhibit art. The two modeled barriers reuse the same envelope coordinates as the solver filter.

The exhibit makes a second conservative swept-radius check on every displayed limb. The open solution crosses the volumes of the two absent barriers at seven canopy and 32 root centerline segments. With barriers inserted the solver's retained canopy and root skeletons remain connected and both have zero overlaps. Their minimum centerline distances from the corresponding barrier envelope are 0.224 m and 0.219 m. Branch skins remain inside the union of their per-segment swept envelopes. The canopies use fixed procedural leaf attachment rules with additional clearance at the plate.

Growth replay traces normalized path distance along the already-solved hierarchy. The bypass corridors are designed for this exhibit. The display demonstrates geometric growth and clearance, with no biological or time calibration. The two views use the same meshes and seeded solution.

## Verification

From the showcase checkout set `MARGO_ENGINE_CHECKOUT` to the pinned engine and run `node qa-output/trees-from-space/check.mjs`. Set `TREES_FROM_SPACE_URL` for a hosted check. The test runs independent segment-to-box distance calculations, verifies the connected parent chain and compares actual motion between the full and early growth frames. The browser makes trusted input on **Insert barriers**, checks the Wasm fetch and the measured overlaps, verifies the side view, checks restoration, and captures GPU-rendered frames.

The phone profile uses 390 × 844 CSS pixels, DPR 2, 150 ms latency, 1.6 Mbps download and 4× CPU throttling. WebGPU takes priority. Automatic and forced WebGL2 use the same mesh, camera, material and Wasm calculations.

## References

- Adam Runions, Brendan Lane and Przemyslaw Prusinkiewicz (2007). *Modeling Trees with a Space Colonization Algorithm*. [Eurographics Workshop on Natural Phenomena](https://doi.org/10.2312/NPH/NPH07/063-070)
- Adam Runions, Martin Fuhrer, Brendan Lane, Pavol Federl, Anne-Gaëlle Rolland-Lagan and Przemyslaw Prusinkiewicz (2005). *Modeling and Visualization of Leaf Venation Patterns*. [SIGGRAPH paper](https://www.algorithmicbotany.org/papers/venation.sig2005.pdf)
- Wencheng Jin, Jayde Aufrecht, Fernando Patino-Ramirez, Heidy Cabral, Chloé Arson and Scott T. Retterer (2020). *Modeling root system growth around obstacles*. The work motivates the exhibit's visible trajectory comparison. [Published article](https://pmc.ncbi.nlm.nih.gov/articles/PMC7522252/)
- Margo Engine public source pinned at `0efd9cff8230507a32deb49907ecd499d46925f5`. [Procedural tree generator](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/procedural/README.md#space-colonisation-trees-and-roots)
