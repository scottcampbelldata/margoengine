# The Reach Test

Drag the amber target, adjust its depth or try the four example positions. The arm displays the smallest signed physical gap to the convex steel block or the rounded capsule post. The readout lists which obstacle determines the gap and the current hand-to-target error. A target inside the post stops the arm at its allowed clearance.

The original instrument uses Margo's public three-link FABRIK solver, convex hull and capsule queries, and swept clearance on every accepted motion. The same shortest-arc link interpolation used for each checked transition drives the display. The minimum permitted gap is 17 mm. A held pose indicates the current bounded search did not accept a new motion. The rendered instrument and obstacle proxies share dimensions. It is an exhibit about inverse kinematics.

References: [Aristidou and Lasenby, FABRIK, 2011](https://doi.org/10.1016/j.gmod.2011.05.003) and [Gilbert, Johnson and Keerthi, A Fast Procedure for Computing the Distance Between Complex Objects in Three-Dimensional Space, IEEE 1988](https://doi.org/10.1109/56.2083).
