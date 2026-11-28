# The Guard

Choose a chime and its modeled hearing range, then ring it. In the fictional Resonance Gallery, Rita pauses her rounds when a sound reaches her, walks to its last known location, looks around, and returns to patrol as the memory fades. A second audible chime can redirect her. Mute changes playback audio. The hearing simulation and the graphic pulse continue to work with the speakers muted.

## Behavior and perception

The inspector displays the actual trace from the pinned public Margo `BehaviorTree`. A reactive selector rechecks the higher-priority investigation branch on each tick. The investigated location comes from the Margo `Perception` memory. Its own blackboard publishes the remembered position and awareness. The exhibit stores the inspection station, cleared search passes and patrol waypoint in that same board. “Search passes” counts sweeps that removed nonzero probability from Margo’s `OccupancyMap`. The guard turns to scan a short range and a modeled central island can block the view. Facing and position are advanced by deterministic fixed rules with Margo’s arrival steering. The app routes waypoints around the island inside the walkable dimensions of the stage.

The three selectable radii represent how far the simulated chime carries. The demonstration compares straight-line distance from the source to the listener’s ear height of 1.57 m. The floor rings are graphical event cues. The chime heard through speakers is synthesized with four damped sinusoidal partials. The modeled room uses an unobstructed propagation path with one distance threshold and synthetic input.

WebGPU opens first. The direct Margo WebGL2 renderer draws the same gallery geometry, Rita, materials, landmark pulses and camera views. The textured-looking suit and stone details are color assigned to geometry, which keeps the full scene within the same small budget on each backend.

## Original art and media

The gallery floor plan, suspended copper ribbons, chimes, panels, benches, fitted lighting and signage were made for this exhibit. The Kimbell’s stone, pale timber, and daylight contrasts informed the lighting and palette of the invented interior. [Kimbell Art Museum, Kahn Building](https://kimbellart.org/content/kahn-building-detail), [Kimbell Art Museum, Piano Pavilion](https://kimbellart.org/content/piano-pavilion-detail)

Rita is an original character fitted from the MakeHuman/MPFB CC0 base, skin, bob02 hair, eyes, shoes02 and the CC0 double-breasted trouser suit credited to MRT in its source metadata. The dress colors use the source UVs and an exhibit palette. [MakeHuman license](https://static.makehumancommunity.org/about/license.html), [official asset packs](https://static.makehumancommunity.org/assets/assetpacks/)

The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217. The 0.7083–1.9167 s walk window is from Subject 16 trial 16. The idle base comes from Subject 16 trial 33. The public Margo retargeter fitted those samples to Rita’s rig during authoring. The exhibit then drives the walk with actual distance traveled and uses the lowest deformed shoe tread to set the floor offset. The head receives a small pose adjustment in the search phase. Movement uses one measured walking cycle and a standing capture, so planted feet can drift during turns and blends. [CMU Graphics Lab Motion Capture Database](https://mocap.cs.cmu.edu/), [official Subject 16 take list](https://mocap.cs.cmu.edu/search.php?subjectnumber=16)

## Methods and reproduction

- Michele Colledanchise and Petter Ögren, 2018, *Behavior Trees in Robotics and AI*, reactive selection and sequence semantics. [Book and paper](https://arxiv.org/abs/1709.00084)
- Damian A. Isla and Bruce M. Blumberg, 2002, *Object Persistence for Synthetic Creatures*, perception-based probability update. [ACM proceedings](https://doi.org/10.1145/545056.545132)
- Craig W. Reynolds, 1999, *Steering Behaviors for Autonomous Characters*, arrival and agent locomotion. [GDC paper](https://www.red3d.com/cwr/papers/1999/gdc99steer.html)

Author the GLB with `tools/author-rita.py` in Blender with MPFB and its official core asset pack. Run `tools/pack-rita.mjs` with the verified Margo checkout, that GLB, the directory containing the licensed source `16.asf`, `16_16.amc` and `16_33.amc`, and the destination `rita.rig`. Pillow is used by the included offline albedo reader. The runtime loads the standalone packed, retargeted rig only. Engine packages use public commit `0efd9cff8230507a32deb49907ecd499d46925f5`.
