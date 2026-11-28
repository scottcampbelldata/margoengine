# Compound Shapes

Release both sculptures onto the inclined test deck. Choose **Fork** or **Elbow** to read that object's physics mass, center of mass and principal moments of inertia. The gold cross in the scene marks the selected body's actual center of mass. Reset restores the launch poses and clears the contact history.

## Model

Each original sculpture has seven parts. Its boxes, spheres and cylinders form one ordinary dynamic compound collider and share a uniform physical density. The Fork uses 2,700 kg/m³. The Elbow uses 7,650 kg/m³. A part's render geometry shares the collider pose and dimensions. Small bevels and finish details are decorative.

The body mass and inertia readouts come directly from the Margo solver. For the independent check, each part's mass equals density times its analytic volume. The compound center is the mass-weighted sum of the offsets. The inertia tensor adds the rotated part-center tensors and the parallel-axis terms. The three principal moments are its eigenvalues.

Both bodies receive an angular impulse of [1.85, 0, 0.52] kg·m²/s at release. Gravity, friction and restitution then act through real Margo contact constraints. The physical ramp uses the same position, dimensions and slope as the visible plate. Shadow silhouettes are projected from the moving part shapes onto the ramp and landing bed. Native WebGPU is tried first. The direct Margo WebGL2 renderer shows the same geometry, lighting, measurements and solver results. All packages are built from public Margo main at **0efd9cff8230507a32deb49907ecd499d46925f5**.

| Object | Mass | Center of mass X/Y/Z | Principal moments |
| --- | --- | --- | --- |
| Fork | 49.36539 kg | −27.930 / 38.053 / 8.747 mm | 1.34462 / 2.93480 / 4.06270 kg·m² |
| Elbow | 164.44307 kg | 15.207 / 3.199 / 42.379 mm | 4.56636 / 9.75814 / 11.84595 kg·m² |

## Verification

From the gallery root, point MARGO_ENGINE_CHECKOUT at the built public checkout and set COMPOUND_SHAPES_PRELOAD=1 to include the gallery's physics startup preloads. The isolated QA harness shows the exact preload hook for the physics entry and the browser's supported Wasm variant.

~~~text
node qa-output/compound-shapes/mechanics.mjs
node qa-output/compound-shapes/check.mjs
~~~

COMPOUND_SHAPES_URL can target the live route. Independent analytic masses matched the engine within one milligram. The check also verifies the center and inertia tensor invariants, then runs both bodies through ordinary contact. At step 90 the Fork had 65 contact steps and had turned 0.696 rad from release, while the Elbow had 64 contact steps and had turned 1.601 rad. Before first contact, the same torque impulse produced angular speeds of 1.377 and 0.337 rad/s.

First working touch through visible falling motion took 2.558 s on native WebGPU, 2.583 s on automatic direct WebGL2 and 2.566 s on forced direct WebGL2. The cold phone profile used a 390 × 844 viewport at 2× DPR, 4× CPU throttling, 150 ms latency and 1.6 Mbps download. Desktop times were 0.430 s and 0.500 s. Both renderers passed contact, object selection, the mass readout and reset.

## References

- J. Kim Vandiver, 2011, [Mass Moment of Inertia of Rigid Bodies](https://ocw.mit.edu/courses/2-003sc-engineering-dynamics-fall-2011/resources/lecture-11-mass-moment-of-inertia-of-rigid-bodies-1/index.html).
- David Baraff, 1994, [Fast Contact Force Computation for Nonpenetrating Rigid Bodies](https://doi.org/10.1145/192161.192168).
- Naum Gabo's treatment of negative space informed the open original silhouettes. [Construction in Space, Yokohama Museum of Art](https://inventory.yokohama.art.museum/eng/3001).
- [Pinned Margo compound collider and mass properties documentation](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/physics).
