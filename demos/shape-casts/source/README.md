# Shape Casts

Cast a sphere, box, or capsule through four fittings. The results show the first contact against each fitting, from nearest to farthest. Select a result to place the probe at that contact. Adjust the direction and height to miss some fittings or contact a different face. Toggle the measured normals on the bench.

Margo Physics sweeps the selected convex shape from the same starting pose. It excludes each reported collider from the next query until there are no more contacts. The measured distances, hit points, and normal vectors come from those queries. The probe's display moves to the corresponding measured pose. The research background for distance-based collision queries is [Gilbert, Johnson and Keerthi, A Fast Procedure for Computing the Distance Between Complex Objects in Three-Dimensional Space, 1988](https://graphics.stanford.edu/courses/cs164-09-spring/Handouts/paper_GJKoriginal.pdf).

The display uses four original fittings. The box has small visual chamfers. The cast's collision shape uses the stated box dimensions. Both WebGPU and the direct Margo WebGL2 path render the same meshes and query data. The first cast can be submitted while the solver is initializing. The page reports that the command is queued until the result can actually render.

The browser audit requires the four contacts for the baseline cast. It checks all three probe profiles, selects a measured contact, switches the normal overlay, and turns the direction to miss fittings. The numerical audit compares the two witness points, verifies outward unit normals, and requires strictly ordered distances. [Margo Engine public main, verified revision](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).
