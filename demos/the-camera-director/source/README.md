# The Camera Director

Two tracked rovers circle a fictional radio observatory on a salt flat. Choose Station for the establishing view, Dolly to travel beside rover 1, or Group to keep both rovers in frame as they move. Dish cue raises the antenna camera to priority 60. You can call another shot while the dish is on air. Releasing the cue returns to the camera currently requested at priority 30.

The pinned public Margo Engine runs all four virtual cameras through `CameraBrain`. The standard transition blends for 0.86 seconds, and a dedicated 0.63-second blend takes the dish camera live. Hard cuts set those transition durations to zero. `DollyTrack` follows the orange rover along an authored 48.4 m `Spline`, with `FramingComposer` aiming ahead as it goes. The Group camera uses `GroupFraming` with a bounding sphere for each moving vehicle. A pause stops the vehicles and antenna while leaving the camera controls usable. The reduced-motion preference starts with motion paused and hard cuts selected.

The scene, including the 20.2 m parabolic antenna, rim and panel assembly, motor stand, maintenance building, photovoltaic racks, two differentiated tracked rovers, terrain and camera rails, is modeled directly in Margo. Both renderers use the same geometry, light and materials. The dry atmosphere and ground contact are authored from opaque scenic geometry. Rover and antenna motion are choreographed for the camera exhibit.

## References

- Li-wei He, Michael F. Cohen and David H. Salesin, “The Virtual Cinematographer: A Paradigm for Automatic Real-Time Camera Control and Directing,” SIGGRAPH 1996. Staged shot selection and the separation of camera control from the moving scene. [Authors' paper](https://grail.cs.washington.edu/wp-content/uploads/2015/08/he-1996-tvc.pdf).
- Steven M. Drucker, “Intelligent Camera Control for Graphical Environments,” MIT, 1994. The virtual camera as a system for specification of viewpoint, framing, and transitions. [MIT thesis](https://mf.media.mit.edu/pubs/thesis/druckerPHD.pdf).
- NASA Jet Propulsion Laboratory, “NASA’s New Deep Space Network Antenna Has Its Crowning Moment,” 2024. Physical reference for panel construction, pedestal and feed-support structure in dry terrain. [JPL field record](https://www.jpl.nasa.gov/news/nasas-new-deep-space-network-antenna-has-its-crowning-moment/).
- NASA Earth Observatory, “Salar de Atacama, Chile,” 2011. Physical reference for light mineral crusts and the enclosed basin. [NASA Earth Observatory](https://science.nasa.gov/earth/earth-observatory/salar-de-atacama-chile-76518/).
