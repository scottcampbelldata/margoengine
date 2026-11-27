# The Eddy Brake

Spin a copper rotor and change the coil current while it coasts. The second speed curve shows the same rotor with the field off. The heat readout integrates the rotational energy dissipated by the magnetic brake in the disc. Bearing drag is accounted for separately.

At low speed, a nonmagnetic conducting disc under a stationary field has braking torque proportional to angular velocity and the square of the applied flux density. This teaching rig assumes an unsaturated electromagnet whose applied field is proportional to coil current. For a fixed input during a simulation step, the disc's angular speed and phase advance with the closed-form solution of the viscous drag equation. The coefficients describe an illustrative bench rotor.

The current overlay uses two families of streamlines for the local flat-disc limit. It assumes a Gaussian normal field and uniform tangential speed in a thin sheet. Contours of the streamfunction proportional to `x(1-exp(-r²/(2s²)))/r²` show the two opposing eddies. The overlay indicates direction, and its brightness follows field times speed. The mechanical model and the overlay share the same simulated speed.

Serve the bundled directory over HTTP. Append `?backend=webgl2` to open Margo's compatibility renderer.

## Sources

- J. H. Wouterse, *Critical torque and speed of eddy current brake with widely separated soft iron poles*, 1991. [IEE Proceedings B](https://doi.org/10.1049/ip-b.1991.0019). Low-speed torque and stationary applied field approximation.
- J. A. Redinz, *Analytical results for rotating and linear magnetic brakes*, 2018. [Advanced Electromagnetics](https://www.aemjournal.org/index.php/AEM/article/view/610). Low-velocity thin-sheet analysis and current distribution.
- T. B. Almeida and R. Nicoletti, *Mathematical modeling and experimental validation of an eddy current brake with permanent magnets*, 2026. [Archive of Applied Mechanics](https://link.springer.com/article/10.1007/s00419-026-03180-8). Copper rotor measurement and apparatus references.
