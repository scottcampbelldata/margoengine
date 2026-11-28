# Wind and Flow Painting

The velocity texture comes from Margo's GPU line integral convolution (`@margoengine/sciviz/lic`), sampled through three analytic vortices and a sheared current. Colour indicates local speed. The texture shows the field at time zero. The moving dye is separate and uses the time-varying field, sampled at 13 times over 7.2 seconds. Both dye traces are `flowInk` strokes from `@margoengine/sciviz/flow`, drawn by Margo Lines the same way on WebGPU and WebGL2.

The white-dotted gold streakline joins dye parcels released at different times from the same probe. The cyan path follows the first parcel through time. Both use Margo's actual RK4 integration, with an upper step of 0.026 seconds. A trace stops when a stage leaves the visible domain. The exhibit is a synthetic 2D flow in metres and seconds.

- Brian Cabral and Leith Casey Leedom. [Imaging Vector Fields Using Line Integral Convolution](https://www.osti.gov/biblio/10185520), SIGGRAPH 1993.
- Lisa Forssell and Scott Cohen. [Using Line Integral Convolution for Flow Visualization](https://graphics.stanford.edu/papers/flowvis2/), IEEE TVCG, 1995.
- Bruno Jobard and Wilfrid Lefer. [Creating Evenly-Spaced Streamlines of Arbitrary Density](https://doi.org/10.1007/978-3-7091-6876-9_5), Visualization in Scientific Computing 1997.
- Han-Wei Shen and David L. Kao. [Numerical Surface Flow Visualization](https://www.nas.nasa.gov/assets/nas/pdf/techreports/1998/nas-98-001.pdf), NASA Ames, 1998. The contrast between instantaneous streamline texture and moving streakline motivates the two visible layers.
