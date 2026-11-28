# Bullet Through Paper

A virtual collision exhibit with two tumbling ceramic blocks and ideal, thin rigid dividers. The amber lane runs the engine’s standard contact solver with continuous collision detection (CCD) disabled. The cyan lane enables its additional sweep. Both lanes start from the same saved world state. A comparison requested while the kernel finishes loading runs as soon as it is available.

## How to read the comparison

- **Run comparison** advances the pinned Margo physics kernel by three fixed samples in each lane. The results come from the kernel’s position, rotation, contact and CCD state. The rotating block and the physical divider are box colliders. The app moves each rendered block to its recorded engine pose.
- **Solver sample** moves through the four saved states, including the start. **Replay samples** plays the same recorded poses at a readable pace. Small ground dots show the actual sampled positions. The ground lines join consecutive samples for legibility. They do not show a reconstructed intra-step path.
- In this chosen virtual setup the unswept lane crosses the divider’s plane during sampled motion despite the standard contact solver seeing a contact. The swept lane remains on the approach side, with CCD active at the decisive sample. Whether a miss occurs depends on the scene, shapes and time interval. The exhibit uses rigid dividers and does not simulate tearing or penetration.
- Calculation and drawing are independent. The simulator runs `KernelWorld` from the pinned `@margoengine/physics` Rust/Wasm package. Margo renders the same bench, materials, blocks and solver results on WebGPU and its native WebGL2 preview backend. Directional shadows on the horizontal surfaces come from projecting the actual collider box corners along the studio light direction. Both renderers draw the same geometry and use one scene sample per pixel. Use `?backend=webgl2` to request the latter directly.

The dual-lane bench, fixtures and artwork were created for this exhibit. All sizes play a role in this virtual scenario.

## Sources

- Erin Catto. *Continuous Collision* (2013). Introduces the distinction between fixed simulation samples and a time-of-impact sweep. [GDC author slides](https://box2d.org/files/ErinCatto_ContinuousCollision_GDC2013.pdf)
- Brian V. Mirtich. *Impulse-Based Dynamic Simulation of Rigid Body Systems* (1996). Covers scheduling and contact in rigid-body simulation. [UC Berkeley technical report](https://www2.eecs.berkeley.edu/Pubs/TechRpts/1996/7978.html)
- Stéphane Redon, Young J. Kim, Ming C. Lin and Dinesh Manocha. *Fast Continuous Collision Detection for Articulated Models* (2004). Discusses collision on continuous motions and why rotational trajectories matter. [Eurographics proceedings](https://diglib.eg.org/items/13aac165-e652-4c78-a0a6-0b42305f0753)
- Exploratorium. *Gravity’s Rainbow*. The bench presentation takes inspiration from hands-on exhibits that make repeated trajectories easy to observe. [Exploratorium exhibit index](https://annex.exploratorium.edu/xref/exhibits/gravitys_rainbow.html)
