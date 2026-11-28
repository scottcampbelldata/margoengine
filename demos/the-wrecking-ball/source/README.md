# The Wrecking Ball

The exhibit is a miniature crane and alternating courses of thirty loose blocks. The three pullback settings park the crane at fixed angles. Release the ball to run a trial. Rebuild the tower to restore every block and the complete chain.

## Physics and readings

Margo’s rigid-body world simulates gravity, contact, friction, and seven rigid chain links. Spherical joints connect the fixed crane pivot, neighboring links, and the cast ball’s lifting eye. The contact shape of each link is a rounded capsule and the visible link is an open, interleaved steel oval. The render shows slowed playback with the same solver on both backends. All physical distances are in metres, and the readout gives the solver’s speed in metres per second.

The impact speed is the length of the ball’s linear-velocity vector at the beginning of the first step that records contact force between the ball and a block. It resolves to a small physics interval around contact. The preview uses rigid frictional contact and separate solid blocks. Material yielding, mortar and structural failure analysis are outside this model.

A block counts once if its center drops by at least one block height from the prepared stack or leaves the original footprint by about half a block width. The readout counts through the 3.6-second simulation interval. The real-time display is slowed to 68%. Release angle, friction, block orientation and how the ball rebounds all affect the final count. The relationship between impact speed and fall count need not be monotonic.

The camera reacts briefly at actual contact. Reduced motion keeps the camera still. Contact shadows use the listed post package. The motion-vector producer required by the optional post motion blur belongs to the separate TAA package, so the scene uses sharp frames and cinematic shake. The same materials, shadows, geometry, and physics run on desktop and mobile. Rendering uses public native WebGPU first with Margo’s automatic full-tier WebGL2 path. If the runtime refuses its HDR tier, the page shows the engine’s reason. A forced renderer check is available with `?backend=webgl2`.

## Sources

- The pendulum exchanges gravitational potential energy for kinetic energy as it descends, as described in Samuel J. Ling, Jeff Sanny and William Moebs, *University Physics Volume 1*, Section 8.3, 2016. The exhibit measures a linked, damped rigid-body ball directly. [OpenStax](https://openstax.org/books/university-physics-volume-1/pages/8-3-conservation-of-energy).
- Miles Macklin et al., *Small Steps in Physics Simulation*, SCA 2019, provides context for the substepped constraint framework. The scene uses Margo’s published rigid kernel and joint APIs. [Paper](https://mmacklin.com/smallsteps.pdf), [Margo Physics](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/physics).
- The crane and hoist are original procedural geometry. For museum display precedent, see *Demainbray’s wharf jib crane model*, maker unknown, England, ca. 1729–1753, and the *Working model of a Stothert and Pitt DD.2 dockside crane*. No reference image or third-party mesh is bundled. [Demainbray model](https://collection.sciencemuseumgroup.org.uk/objects/co2015/demainbrays-wharf-jib-crane-model), [Stothert and Pitt model](https://collection.sciencemuseumgroup.org.uk/objects/co41168/working-model-of-a-stothert-and-pitt-dd-2-dockside-crane).

All scene geometry is generated from `source/art.js` and `source/geometry.js`. The exhibit uses the public Margo Engine pin `0efd9cff8230507a32deb49907ecd499d46925f5`, with rigid bodies and spherical joints, post contact shadows, cinematic shake, core geometry, Quality and WebGL2 bootstrap. The local Vite entry aliases `margo-demo-status` to the engine checkout’s `examples/demo-status.ts`.
