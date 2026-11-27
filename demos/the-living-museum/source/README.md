# The Living Museum

The West Gallery is a live cutaway of a night museum. Tap the floor or choose **Cross gallery** to move the visitor marked by the brass floor tag. **Enter alcove** sends that visitor around a partition. The guard’s readout follows a real behavior tree as it patrols, spots the visitor and searches the last place it saw them. Reset restores the patrol and all visitor tours.

The display tables, tiled gallery, bronze orbits, stacked ceramic, blue minerals, rail and partitions are original procedural Margo geometry. Eleven fixtures light the gallery and the five characters. This includes three roaming visitors, the visitor you control and one guard. The first interactive frame uses posed geometry baked from the original rig. The textured glTF rigs and continuous foot placement finish in the background and take over each character at its live navigation position. Both stages use the same scene and lights on phone and desktop.

## Model

An inset convex polygon mesh represents the accessible floor. Crowd runs A* and reciprocal ORCA avoidance inside that surface. The guard’s finite cone integrates awareness over time. Wall and exhibit bounds occlude it. Its reactive behavior tree selects a visible target first, remembered position second and the patrol route when the memory expires. Search uses three nearby positions around the last sighting. Player and guard locations are distinct Margo crowd agents. The walking pose uses navigation velocity and Margo Animator’s foot targets and upper-body offsets. It is a procedural walking animation.

## Verification and limits

The opening navigation starts as the first gallery frame renders. The five opening figures use three quantized poses sampled from the scene's shared rig. All eleven lights contribute from the first frame through one conservative cluster, avoiding repeated light lists for this small room. The detail pass prepares and compiles the full rigs in the background, then restores the full glTF materials and procedural body animation in place. To regenerate the opening geometry, run `node src/the-living-museum/pack-opening.mjs` from the showcase root with `MARGO_ENGINE_CHECKOUT` set to the verified engine checkout.

## Provenance

The shared visitor derives from the showcase’s earlier CC0 MakeHuman body, skin, clothing and hair, authored from the MakeHuman core pack. This exhibit repaints the clothing, downsamples the atlas for the distant overhead camera and provides new walking and behavior. Regenerate with `gltfpack -i walker.glb -o reduced.glb -cc -kn -km -vpf -si 0.42`, restore the Float32 animation using the Stepping Stones `pack-animation.mjs`, then run `node pack-visitor.mjs restored.glb visitor.mesh` with FFmpeg installed.

- MakeHuman Community, *MakeHuman Assets and Licensing*. [Core asset license](https://static.makehumancommunity.org/about/license.html)
- Jur van den Berg, Stephen J. Guy, Ming Lin and Dinesh Manocha, *Reciprocal n-Body Collision Avoidance* (2011). [ORCA paper](https://gamma.cs.unc.edu/ORCA/publications/ORCA.pdf)
- Michele Colledanchise and Petter Ögren, *Behavior Trees in Robotics and AI* (2018). [Authors’ text](https://arxiv.org/abs/1709.00084)
- Google Chrome Developers, *Optimizing the Critical Rendering Path*. [Startup resources](https://web.dev/articles/critical-rendering-path/optimizing-critical-rendering-path)
