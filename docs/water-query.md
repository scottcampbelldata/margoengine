# Batch 234: wave queries

Job 2 research checkpoint. Implementation and validation are still pending.

Research preceded implementation. Compared Mark Finch, *Effective Water
Simulation from Physical Models*, GPU Gems chapter 1 (2004), sections 1.2.1
and 1.2.3, <https://developer.nvidia.com/gpugems/gpugems/part-i-natural-effects/chapter-1-effective-water-simulation-physical-models>,
with Jerry Tessendorf, *Simulating Ocean Water* (1999-2004), displacement
equations 42-45, cited and reviewed for job 1 in [water-fft.md](water-fft.md).
Finch supplies parameter-space displacement and its derivatives; a height
lookup at displaced world XZ is not an intersection with drawn triangles.

Compared Tomas Moller and Ben Trumbore, *Fast, Minimum Storage Ray/Triangle
Intersection* (1997), <https://my.eng.utah.edu/~cs6965/papers/MT97.pdf>, with
Sven Woop, Carsten Benthin and Ingo Wald, *Watertight Ray/Triangle Intersection*
(2013), sections 2-3, <https://jcgt.org/published/0002/01/05/paper.pdf>.
The latter's ray-relative, consistently evaluated three projected edge
functions avoid the shared-edge mismatch of a two-weight barycentric test.
For vertical wave queries no shear is required. Use binary64 edge arithmetic,
all three edge signs, and the highest hit when choppy triangles overlap.

Planned synthesis: explicit immutable CPU snapshots; periodic bilinear FFT
fields at actual finite-grid vertices; Gerstner crest bend, filtering,
terrain blend and normals from the uploaded parameters; analytic wave
derivatives and conservative coastal flux for water motion. Include dry
fragments and finite draw boundaries. No automatic readback or second FFT.

Public rival descriptions reviewed: Babylon.js, *Lite Ocean* (2026),
<https://www.babylonjs.com/lite-demos/demo-ocean.html>, advertises its
merge/buoy probe; the Babylon.js forum discussion *Float on Water Material*
(2019), <https://forum.babylonjs.com/t/float-on-water-material/1800>, describes
coordinate height queries and private animation time. The Margo contract
must supply height, normal and velocity at actual rendered time, including
horizontal chop. No rival or companion implementation was read.
