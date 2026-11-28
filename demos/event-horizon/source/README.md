# Event Horizon

Drag the star field to orbit a spinning Kerr black hole. Edge-on shows the far side of the thin accretion disk lensed above and below the shadow. From above shows the hot inner ring, and the brightness slider can remove the disk to expose distorted stars. Camera distance is in units of the gravitational radius, GM/c². The event horizon and the innermost stable prograde circular orbit come from the same spin used by the rendering package.

Margo's shader traces rays backward from the observer through the Kerr geometry. A model thin disk emits light based on the Page–Thorne flux profile. The shader accounts for the direction of the gas motion and shifts the measured colors and brightness as it approaches or recedes. This is a demonstration of an idealized disk and a procedural star field.

The same Kerr shader runs through native WebGPU and the full WebGL2 compatibility layer. With a cold shader cache, the WebGL2 driver takes about 11–14 seconds to translate and compile this shader on the test workstation. The page waits for a drawn frame before enabling the controls.

- Jean-Pierre Luminet. Image of a spherical black hole with thin accretion disk, 1979. [Astronomy & Astrophysics](https://ui.adsabs.harvard.edu/abs/1979A%26A....75..228L/abstract)
- Don N. Page and Kip S. Thorne. Disk-accretion onto a black hole. Time-averaged structure of accretion disk, 1974. [The Astrophysical Journal](https://ui.adsabs.harvard.edu/abs/1974ApJ...191..499P/abstract)
- Oliver James, Eugénie von Tunzelmann, Paul Franklin, and Kip S. Thorne. Gravitational lensing by spinning black holes in astrophysics, and in the movie Interstellar, 2015. [Classical and Quantum Gravity](https://arxiv.org/abs/1502.03808)
