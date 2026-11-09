# Sciviz batch 171 progress

Lane X, after batch 118. Data drawing only; physics remains on hold.

| Job | State | Evidence and remaining work |
| --- | --- | --- |
| 1. Moving flow | In progress | Optional `/flow` CPU physical-time pathline reference, feature-local Rust/Wasm, analytic/NOAA tests and real-browser pathline rendering/restoration on WebGPU and WebGL2 compatibility pass. GPU particles, fading trails, deterministic seeding, respawn, streaklines and the official real-data demo remain. |
| 2. Line integral convolution | Pending | Published LIC methods, animated/scalar-coloured surface slices and real-data demo. |
| 3. Tubes and ribbons | Pending | Scalar radius, vorticity twist, stable frames/normals and real-data demo. |
| 4. Derived fields | Pending | CPU/GPU gradient, divergence, curl, vorticity, Q and lambda-2 parity, volume/isosurface integration. |
| 5. Climate and solver formats | Pending | NetCDF, existing VTK XML reader integration, VTK 5.1, lazy range reads and real files. |
| 6. Atmosphere on globe | Pending | Existing sky integration, real-height data layers and NOAA/ERA5 globe demo. |

Native WebGL2 batch 181 job 1 has surface/rectangle drawing and strict real-backend parity on main through
`6a09f480f`. Its axes, points/lines, volumes/slices, integrated CPU isosurfaces and real-data demos remain
unfinished. Compatibility-backed WebGL2 coverage does not establish those native paths.
