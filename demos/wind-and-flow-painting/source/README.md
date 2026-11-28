# Wind and Flow Painting

The velocity texture comes from Margo's GPU line integral convolution, sampled through three analytic vortices and a sheared current. Colour indicates local speed. The opening velocity texture shows the field at zero. For fast startup, the GPU displays a recorded image of the exact Margo LIC output while the page loads the same field calculation. The interactive trajectories run from the opening frame, and the generated texture takes over once ready. The moving dye is separate and uses the time-varying field, sampled at 13 times over 7.2 seconds.

The white-dotted gold streakline joins dye parcels released at different times from the same probe. The cyan path follows the first parcel through time. Both use Margo's actual RK4 integration, with an upper step of 0.026 seconds. A trace stops when a stage leaves the visible domain. The exhibit is a synthetic 2D flow in metres and seconds.

- Brian Cabral and Leith Casey Leedom. [Imaging Vector Fields Using Line Integral Convolution](https://www.osti.gov/biblio/10185520), SIGGRAPH 1993.
- Lisa Forssell and Scott Cohen. [Using Line Integral Convolution for Flow Visualization](https://graphics.stanford.edu/papers/flowvis2/), IEEE TVCG, 1995.
- Han-Wei Shen and David L. Kao. [Numerical Surface Flow Visualization](https://www.nas.nasa.gov/assets/nas/pdf/techreports/1998/nas-98-001.pdf), NASA Ames, 1998. The contrast between instantaneous streamline texture and moving streakline motivates the two visible layers.
