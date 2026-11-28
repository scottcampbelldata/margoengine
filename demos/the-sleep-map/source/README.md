# The Sleep Map

Four brass-rimmed spring beds hold 224 glazed ceramic beads. The beads drop and turn from warm orange to cool celadon as they settle. Tap A, B, C or D to disturb one bed. The ring and button mark the selected bed, while the beads’ own colours follow their solver state. The counters report awake bodies, sleeping bodies and active solver islands.

## Live physics

Each bed holds 56 individual 26 mm radius spheres of 36 g. The beds have separate fixed cylindrical supports. Within each bed, the 73 mm pitch of the staggered triangular layout sets the rest length of 141 distance springs. The 564 total joints have stiffness 11.8 N/m and damping 0.21 N·s/m. Floor contacts and joints are resolved by the pinned Margo rigid-body kernel in 1/60 s steps with four solver substeps. These values set up the exhibit and its visible settling motion.

Each tap applies a 0.055 N·s upward impulse with a small lateral component to the selected bed’s centre bead. Its spring links wake the connected bodies in that bed. An already settled neighbouring bed remains asleep. The solver decides when bodies sleep, with an authored sleep threshold of 0.033 J/kg and a 0.47 s quiet window. The label “Active solver islands” uses the engine’s count for its latest step, so it reads zero when all four beds rest. The plunger’s visible travel marks the tap.

“Show springs and contacts” draws the actual positions returned by Margo’s PhysicsDebugView. Spring links appear in mint and contact normals appear in gold. The overlay lifts both slightly above the physical positions for legibility. Contact normals appear while a solver step has active contacts.

## Art and rendering

The material palette, turned rims, enamel plungers, lettered wells, casework and ceramic glaze were made for this exhibit. Margo WebGPU is tried first. The engine’s direct PBR WebGL2 renderer draws the same geometry, materials and live diagnostics when WebGPU is unavailable. Append '?backend=webgl2' to exercise that route. The finished 3D instrument can render while the public rigid-body kernel prepares. Tap controls enable after the first real solver state appears.

- [Pinned public Margo Engine revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5)
- Erin Catto, *Simulation Islands*, 2023. [Connected components, sleeping and waking](https://box2d.org/posts/2023/10/simulation-islands/).
- Miles Macklin et al., *Small Steps in Physics Simulation*, 2019. [Stability and simulation substeps](https://mmacklin.com/smallsteps.pdf).
- Erin Catto, *Soft Constraints*, 2011. [Damped spring constraints](https://box2d.org/files/ErinCatto_SoftConstraints_GDC2011.pdf).
