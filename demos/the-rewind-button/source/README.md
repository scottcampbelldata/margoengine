# The Rewind Button

An original kiln transfer yard with a brass roller and 54 glazed ceramic crates. Run the roller into the stack and watch 55 moving rigid bodies accumulate into a pile. Then scrub the 2.8-second run.

## The recorded timeline

The scene uses the pinned `@margoengine/physics` Rust/Wasm `KernelWorld`. Gravity, friction, rotation, rolling, contact and body motion come from the engine. The floor and perimeter are fixed box colliders. The drum uses a cylinder collider and the crates use box colliders inside their rounded visual profiles. The crate marks and drum fittings move with their parent bodies.

- **Run pile-up** restores the initial world, applies the roller’s starting motion and advances at a fixed 60 solver steps per second, with four fixed substeps in each step. One second of timeline time always represents 60 physics steps. The browser can present fewer frames when it is busy.
- The app keeps one real `world.snapshot()` every 12 steps and one at the start. The completed run has 15 checkpoints. Each checkpoint contains the full kernel state, including contact memory and velocities. One run occupies about 6.9 MB of checkpoint memory.
- **Timeline** restores the closest checkpoint at or before the selected moment using `world.restore(bytes)`. It runs the intervening solver steps and draws the resulting positions and orientations. Repeat seeks to the same step produce the same kernel hash. **Run again** starts from the original state and replaces the stored run.

The rendering uses the same original geometry, painted materials, projected contact shading and sample density on native WebGPU and Margo’s native WebGL2 preview backend. WebGPU is preferred. Append `?backend=webgl2` to test the latter directly. The page draws the complete starting yard while the selected Wasm module loads, and a queued run starts when that module is available.

## Sources

- Brian V. Mirtich. *Timewarp Rigid Body Simulation* (2000). Describes rollback and time handling for rigid-body simulation. This exhibit uses checkpoints in one local world. [SIGGRAPH paper](https://www.merl.com/publications/docs/TR2000-00.pdf)
- Miles Macklin, Kier Storey, Michelle Lu, Pierre Terdiman, Nuttapong Chentanez, Stefan Jeschke and Matthias Müller. *Small Steps in Physics Simulation* (2019). Describes the effect of substepping on stiff dynamics. [Author’s paper](https://mmacklin.com/smallsteps.pdf)
- Science Museum Group. *Building Construction Collection*. Kiln and brickwork materials and machinery informed the original transfer yard. [Science Museum collection](https://collection.sciencemuseumgroup.org.uk/search/categories/building-construction/museum/science-museum)
