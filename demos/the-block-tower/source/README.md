# The Block Tower

Pull the marked center beam on course 3. The two outside beams still carry the upper stack. Pull the next marked beam on the same course and watch the upper decks tip off their remaining support. Choose another course or beam with the selectors, or grab a visible beam end and drag it along its length. Rebuild restores the original stack and its resting state.

## Model

The original tabletop sculpture is 688 mm high. Eight courses rotate 18° each and carry three 207 × 66 × 36 mm beams and a square deck. The 24 oak-density beams and eight decks are live dynamic rigid bodies. A fixed plinth and surrounding gallery floor catch the extracted and fallen pieces. Convex box colliders approximate the beveled visual forms. The mass, damping and friction are exhibit parameters for the model.

The motion comes from the pinned Margo Rust/Wasm physics solver. A force-limited DragJoint pulls the marked beam along its long axis. The same joint receives an eased target from the button or a pointer-driven target when the user drags. The solver applies gravity, box contact, friction and island sleeping. Render transforms come from its body poses on both backends. Extraction is recognized after 245 mm of lateral clearance from the seated position. The collapse readout is triggered by the measured displacement of an upper deck.

Native WebGPU is tried first. The direct Margo WebGL2 renderer uses the same core geometry, PBR materials, light and shadow projections. The projections use the eight transformed collision-box corners, cast onto the plinth and gallery floor with the scene light. The orthographic camera pulls back as the stack falls. All scene geometry and ornamental details were made for this exhibit, with zero external assets.

Pinned public Margo main revision **0efd9cff8230507a32deb49907ecd499d46925f5**. The gallery's first-open path preloads the scene and physics JS plus the browser's supported physics blueprint. The pinned physics loader still owns feature selection, module loading and initialization.

## Verification

From the showcase root with MARGO_ENGINE_CHECKOUT pointing to the built public checkout and BLOCK_TOWER_PRELOAD=1:

~~~text
node qa-output/the-block-tower/mechanics.mjs
node qa-output/the-block-tower/check.mjs
~~~

The standalone mechanics check compares standing, extracted and collapsed body positions. The browser check uses trusted touch or mouse input to extract the first beam, tip the stack, wait for all 32 bodies to sleep, rebuild, physically drag a beam with pointer input, rebuild again and verify the individual selectors. It measures the first submitted frame with at least 2.8 mm of actual beam motion and waits for the renderer to finish. BLOCK_TOWER_URL runs the browser check against the gallery route.

Cold 390 × 844 phone emulation at 2× device pixel ratio, 150 ms latency, 1.6 Mbps download and 4× CPU throttling measured 2.595 s on native WebGPU, 2.705 s on automatic direct WebGL2 and 2.602 s on forced direct WebGL2. See the ignored QA folder for the logs and live rendered frames on phone and desktop.

## References

- Erin Catto, 2005, discusses persistent contact and iterative rigid-body constraints. [Iterative Dynamics with Temporal Coherence](https://box2d.org/files/ErinCatto_IterativeDynamics_GDC2005.pdf).
- David Baraff, 1994, explains friction and nonpenetrating rigid-body contacts. [Fast Contact Force Computation for Nonpenetrating Rigid Bodies](https://doi.org/10.1145/192161.192168).
- Donald Judd’s experiments with plywood and regular intervals informed the serial composition. [MoMA, Judd Exhibition Galleries](https://www.moma.org/magazine/articles/291).
- [Pinned Margo rigid-body, DragJoint and sleeping APIs](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/physics).
