# Sciviz batch 171 progress

Lane X, after batch 118. Data drawing only; physics remains on hold.

| Job | State | Evidence and remaining work |
| --- | --- | --- |
| 1. Moving flow | Done | GPU physical-time RK4 particles on 2D/3D steady/unsteady fields, fading generation-cut trails, all four deterministic seed layouts, fixed-seed respawn, CPU pathlines/streaklines and bounded exact device replay. NOAA Moving wind passes both layouts/backends; numeric, all-pixel parity, cancellation and all 23 README examples pass. Core/stage unchanged. |
| 2. Line integral convolution | Done | Optional retained GPU LIC, phase animation, scalar colour and affine 3D slices. CPU and analytical box/circular, mask, animation, exact restoration and zero-difference backend pixel checks pass, including after rebase. NOAA demo passes both layouts/backends and late-update regression. Full verify ran once with four metadata/test-fixture failures corrected and affected checks passing; all package GPU, 24 README, lint/hygiene/quality gates pass. 23,461 B gzip after main restored full-precision colormaps (ceiling 24,165 B); core/stage 23,924 B. Latest-main integration, coherent records and affected acceptance pass. |
| 3. Tubes and ribbons | Pending | Scalar radius, vorticity twist, stable frames/normals and real-data demo. |
| 4. Derived fields | Pending | CPU/GPU gradient, divergence, curl, vorticity, Q and lambda-2 parity, volume/isosurface integration. |
| 5. Climate and solver formats | Pending | NetCDF, existing VTK XML reader integration, VTK 5.1, lazy range reads and real files. |
| 6. Atmosphere on globe | Pending | Existing sky integration, real-height data layers and NOAA/ERA5 globe demo. |

Native WebGL2 batch 181 job 1 has surface/rectangle drawing and strict real-backend parity on main through
`6a09f480f`. Its axes, points/lines, volumes/slices, integrated CPU isosurfaces and real-data demos remain
unfinished. Compatibility-backed WebGL2 coverage does not establish those native paths.
