# The Stress Glyphs

Turn **Pull direction** to rotate a 10 MPa remote tensile load around a circular, traction-free opening. In **Principal** view, gold arrows point outward along tensile axes, and cyan arrows point inward along compressive axes. The right-rim readout changes from −10 MPa at 0° to +30 MPa at 90°. The 30 MPa peak moves around the rim as the pull changes direction. Switch to **Shear** to see the normals of the two in-plane maximum-shear planes at each sample.

## Mechanical model

The exhibit evaluates the Kirsch solution for an infinite, isotropic, linearly elastic sheet under uniaxial plane stress. The 78 mm nominal bore is an open aperture in a 318 × 214 × 7 mm modeled display sheet. The rectangular sheet edges are the crop boundary of the analytic field. The cradle is exhibit geometry. Wall stress and vanishing traction are evaluated at the modeled throat radius of 39 mm, while the beveled rim carries an offset strip of color so the readings remain easy to see.

At radius r, set u = (a/r)² and let θ denote the angle from the direction of remote tension S. The radial, tangential and polar shear components respectively are:

    σrr = S/2 [(1 − u) + (1 − 4u + 3u²) cos(2θ)]
    σθθ = S/2 [(1 + u) − (1 + 3u²) cos(2θ)]
    τrθ = −S/2 [1 + 2u − 3u²] sin(2θ)

At r = a, radial and shear traction vanish, and the tangential result simplifies to S[1 − 2cos(2θ)]. The three-dimensional stress tensor uses the two-dimensional values with out-of-plane coefficients zero. In-plane maximum shear magnitude is half the difference between the two in-plane principal stresses.

## Rendering and verification

The plot samples 72 positions in the exact continuous field. Margo Sciviz’s `tensorEigen` supplies signed eigenvalues and their directions. The public glyph API `prepareGlyphs` calculates the shared instanced orientation and scales. The stage uses 0.98 mm of glyph length per MPa. Marks below 0.06 MPa are omitted from the plot for legibility. Gold and cyan report the sign in Principal view. Violet identifies the Shear view. Glyph length encodes the maximum shear magnitude. The rim cells discretize the real signed tangential stress into 13 colors.

The original 3D cradle, beveled specimen, sampled markings and remote-load arrows use public Margo Engine revision `0efd9cff8230507a32deb49907ecd499d46925f5`. WebGPU opens first, and the full WebGL2 compatibility renderer uses the same geometry and calculations. The page downloads no data or visual assets.

The model proof in `qa-output/the-stress-glyphs/model-proof.mjs` checks rim traction, the far field, tensor rotation, eigen residuals, glyph magnitudes and the watertight oriented solids. The browser check in the same folder measures a trusted touch changing load direction, toggles the real glyph mode and compares screenshots. The mobile profiles use a 390 px viewport, 150 ms latency, 1.6 Mbps and fourfold CPU slowdown.

Final trusted first angle change was 1.199 s on WebGPU, 2.031 s on forced WebGL2 and 1.748 s on automatic WebGL2 in the throttled phone profiles. Desktop measured 0.369 s native and 0.204 s forced WebGL2. The signed right-rim value moved from −10 MPa at 0° to +26.6 MPa at 73°. The two view modes populated the same 72 positions. Shear contained 144 marks, two per sample. All five profiles completed with no errors.

## References

- Ernst Gustav Kirsch, 1898. *Die Theorie der Elastizität und die Bedürfnisse der Festigkeitslehre*. The circular-hole solution is derived in David Roylance’s *Closed-Form Solutions*, MIT 3.11, 1999. [MIT derivation](https://live.ocw.mit.edu/courses/3-11-mechanics-of-materials-fall-1999/2ed676922db750766161cdd004b2270a_MIT3_11F99_airy.pdf)
- Elbridge Z. Stowell, 1950. *Stress and Strain Concentration at a Circular Hole in an Infinite Plate*. NACA Technical Note 2073. [NASA Technical Reports Server](https://ntrs.nasa.gov/citations/19930082747)
- Chiara Hergl and colleagues. *Visualization of Tensor Fields in Mechanics*, 2021. [Computer Graphics Forum survey](https://doi.org/10.1111/cgf.14209)
