# The 2D Sandbox

A stylized quarry crossing with articulated timber decking, brass pivots and painted stone. The complete illustration and moving objects are Margo Engine geometry. The full frame and controls are the same on desktop and phone.

- **Add crate** drops a box over the starter stack. Tap the open area to choose the release point. Both paths use real box bodies and contact response from the pinned `@margoengine/physics2d` Rust/Wasm kernel.
- **Build bridge** assembles 14 rigid planks with 15 actual revolute joints, including the two shore pins. The slight starting curve gives the hinged span slack. The solver advances the joints and supports additional crate loads.
- **Knock down** removes the far bank’s joint and drops a dense circular weight. The remaining hinges stay connected as the span falls. The release is a user action. It is the same controlled removal as unpinning a mechanical test fixture.
- The left and right rock outlines supply the polygon colliders. Two flat shelves make it possible to stack boxes. The river shelf bounds the bottom of the physical scene. Reset restores the original quarry, planks, pins and crates. The crate tool supports up to 64 live crates.
- WebGPU is preferred. Margo’s native WebGL2 preview backend draws the same flat-lit geometry and runs the same 2D simulation. Request it directly with `?backend=webgl2`. The view can accept the first drop while the chosen physics kernel finishes loading. The crate enters the world only when the engine takes the action.

## Sources

- Erin Catto. *Modeling and Solving Constraints* (2009). Explains hinges, contact constraints and iterative dynamics. [Author’s GDC presentation](https://box2d.org/files/ErinCatto_ModelingAndSolvingConstraints_GDC2009.pdf)
- Erin Catto. *Iterative Dynamics with Temporal Coherence* (2005). Discusses persistent contact solving and stable stacking. [Author’s paper](https://box2d.org/files/ErinCatto_IterativeDynamics_GDC2005.pdf)
- Brian V. Mirtich. *Impulse-Based Dynamic Simulation of Rigid Body Systems* (1996). Explains contact and impacts in rigid-body dynamics. [UC Berkeley technical report](https://www2.eecs.berkeley.edu/Pubs/TechRpts/1996/7978.html)

The quarry, materials and bridge artwork were created for this exhibit.

## Kernel transport

The two `.packed` assets are gzip wrappers around the compiled public Margo Engine pin `0efd9cff8230507a32deb49907ecd499d46925f5`. They preserve the bytes of `packages/physics2d/dist/physics2d.wasm` and `physics2d-scalar.wasm` respectively. The shared loader selects the build the current browser can compile and passes the unwrapped bytes through the public `Physics2D.load({wasm})` API. A browser without `DecompressionStream` uses the stock kernel loader.

Restore the transport assets from the pin by compiling the public package and using Node `gzipSync(bytes,{level:9})`. Verify the uncompressed SHA-256 before building the gallery.

| Build | Original bytes | Packed bytes | Uncompressed SHA-256 |
| --- | ---: | ---: | --- |
| SIMD | 471,440 | 170,696 | `d921119b281178f8b624dffabdb2a3fdbaf1810aa20bace5f53fa248987e1a33` |
| Scalar | 553,342 | 189,279 | `c8aaf4cffc5c847dac18e852501c6a6998a7e0fd58070a2535bc63295a808dd8` |
