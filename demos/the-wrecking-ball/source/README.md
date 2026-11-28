# The Wrecking Ball

The exhibit is a miniature crane and alternating courses of thirty loose blocks. The three pullback settings park the crane at fixed angles. Release the ball to run a trial. Rebuild the tower to restore every block and the complete chain.

## Physics and readings

The trial runs on `@margoengine/physics` at its high fidelity tier (32 substeps a step). The chain is the package's `Rope`: seven steel capsules joined end to end by spherical joints, pinned to the trolley sheave and to the cast-iron ball's lifting eye. The thirty blocks are pine boxes with rounded edges, stacked in alternating courses on a fixed deck. Densities come from the package's named materials (iron, steel, pine). Each visible link is an interleaved steel oval drawn over its capsule. All distances are in metres.

**First impact speed** is the ball's speed at the start of the solver step whose `contactforce` event first pairs the ball with a block. **Blocks fallen** counts a block once its centre has dropped a block height or left its place by half a block width, over the 3.6 s trial. Playback runs at 68% of real time; the solver's time is not changed. Release angle, friction, block order and the rebound all affect the count, so it need not grow with the angle. Material yielding, mortar and structural failure are outside this model.

## Rendering

The crane's mast, jib, counter-jib and A-frame are `trussGeometry` lattice girders from `@margoengine/geometry/extras`; the plinth, deck, cab and blocks are bevelled `roundedBoxGeometry`. Light is a warm key with soft shadows (`@margoengine/shadows`, PCSS), image-based fill and rim from the procedural studio of `@margoengine/environment/studio` (also the blurred backdrop), screen-space contact shadows (`@margoengine/post/contact-shadows`) and AgX tone mapping with a light vignette (`@margoengine/tonemap`). WebGPU first, with the full WebGL2 compatibility layer when WebGPU is missing; `?backend=webgl2` forces it.

## Sources

- The pendulum exchanges gravitational potential energy for kinetic energy as it descends, as described in Samuel J. Ling, Jeff Sanny and William Moebs, *University Physics Volume 1*, Section 8.3, 2016. The exhibit measures a linked, damped rigid-body ball directly. [OpenStax](https://openstax.org/books/university-physics-volume-1/pages/8-3-conservation-of-energy).
- Miles Macklin et al., *Small Steps in Physics Simulation*, SCA 2019, provides context for the substepped constraint framework. [Paper](https://mmacklin.com/smallsteps.pdf).
- The crane and hoist are original procedural geometry. For museum display precedent, see *Demainbray’s wharf jib crane model*, maker unknown, England, ca. 1729–1753, and the *Working model of a Stothert and Pitt DD.2 dockside crane*. No reference image or third-party mesh is bundled. [Demainbray model](https://collection.sciencemuseumgroup.org.uk/objects/co2015/demainbrays-wharf-jib-crane-model), [Stothert and Pitt model](https://collection.sciencemuseumgroup.org.uk/objects/co41168/working-model-of-a-stothert-and-pitt-dd-2-dockside-crane).

`source/trial.js` builds the physics world and reads the readouts back, `source/art.js` places the props, and `source/scene.js` sets up the engine, lights and controls. Rebuild with `node scripts/web-demos/build.mjs the-wrecking-ball`.
