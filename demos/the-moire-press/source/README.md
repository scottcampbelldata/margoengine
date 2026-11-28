# The Moiré Press

Use the **Top screen angle** slider to rotate the upper stencil. **Align** places one set of slits over the other. Compare **4°** and **12°** to see the broad bands come closer together. **Lift top screen** hinges the platen open so you can inspect the two separate masks.

Each mask contains opaque blades spaced 10.5 mm apart. The viewer sees the opal plate wherever there is an opening in both sets of geometry. A small near-parallel turn makes the openings drift into and out of registration, creating bands visibly wider than the slits. The analytical band spacing in the mask plane is the inverse of the magnitude of the two grating frequency vectors' difference. For equal pitch p and relative rotation θ, this is p / (2 sin(|θ|/2)). At 0° the screens align and the broad pattern disappears.

The effect comes from two overlapping 3D masks rendered by Margo. The aperture edges, hinge, and opal plate are also geometry that shares the same studio lighting. The spacing readout describes the ideal equal-pitch planar pattern. Perspective changes the apparent spacing on screen. This is geometrical occlusion and transmission, without wave diffraction.

Phone and desktop use the same artwork and scene settings. The WebGPU path is preferred, with Margo's WebGL2 compatibility layer when WebGPU is unavailable. Add `?backend=webgl2` to test it directly. The gallery uses packages built from the verified [public Margo Engine checkout](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## Research

- Isaac Amidror and Roger D. Hersch, *A generalized Fourier-based method for the analysis of 2D moiré envelope-forms in screen superpositions* (1993). Geometric screen superposition and frequency differences. [EPFL](https://infoscience.epfl.ch/entities/publication/7db722a6-49bf-4c54-9ae2-3421476891b8)
- Isaac Amidror, *Mathematical moiré models and their limitations* (2009). Identical line gratings, first-order moiré spacing and limits of the ideal model. [Journal of Modern Optics](https://doi.org/10.1080/09500340903494629)
- The Exploratorium, *Moire Patterns*. Physical exhibit with superimposed repetitive prints. [Exploratorium](https://annex.exploratorium.edu/xref/exhibits/moire_patterns.html)
- Randima Fernando, *Percentage-Closer Soft Shadows* (2005). Contact-hardening studio shadows. [NVIDIA](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf)
