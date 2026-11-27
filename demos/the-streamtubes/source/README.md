# The Streamtubes

A paired wing wake drawn by Margo Engine. The same 20 tubes, light model, bench, and vertex data are used for WebGPU and the Margo WebGL2 compatibility device. The thickness control rebuilds the capped tube surfaces with the new radii. Each side can be inspected independently in oblique, top, or downstream views.

The model uses two opposed analytic vortex cores in a continuous illustrative field. The swirling velocity uses a regularized Gaussian core, and the downstream field eases the separation and core width. The numbers and coordinates are normalized model values. The path solver follows the velocity field with fourth-order Runge–Kutta. Each path carries its local speed and is converted into a closed illuminated surface by `streamTubeGeometry` from `@margoengine/sciviz/tubes`. The foil, deck, and reference marks are original geometry. Section illumination encodes speed within each wingtip’s color palette.

## References

- Malte Zöckler, Detlev Stalling and Hans-Christian Hege, [Interactive Visualization of 3D-Vector Fields Using Illuminated Streamlines](https://doi.org/10.1109/VISUAL.1996.567777), IEEE Visualization, 1996.
- NASA Glenn Research Center, [What Is Drag?](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/what-is-drag/), finite wing induced drag and wingtip vortices.
- John D. Anderson Jr., [Introduction to the Aerodynamics of Flight](https://www.nasa.gov/wp-content/uploads/2023/04/sp-4529.pdf), NASA SP-4529, 1975, finite wing and trailing vortex context.

The exhibit integrates a prescribed model field to illustrate trajectories. A predictive wake simulation would require measured or solved boundary conditions and aerodynamic calibration.
