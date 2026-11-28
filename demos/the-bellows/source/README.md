# The Bellows

Lift or press the walnut handle to work the leather chamber. Use “Pump one cycle” to watch an intake stroke followed by a discharge stroke. Cool traces enter through the inlet, and warm traces leave through the brass nozzle. The moving leather and both check-valve reeds are modeled geometry.

## Air displacement model

The chamber is the loft between a fixed pear-shaped footprint and an identical board that swings about the hinge. The hinge gap is 34 mm. The upper board rotates between 0.065 and 0.575 radians. Let A be the area of the footprint and M its first area moment measured from the hinge. In the loft, a point (x,z) on the footprint maps to ((1 + t(cos θ − 1)) x, t(g + x sin θ), z) for normalized loft coordinate t. Integrating its volume gives V(θ) = Ag(1 + cos θ)/2 + M sin θ. The model integrates the same pear-shaped polygon used by the rendered chamber. It neglects the small volume changes within individual leather fold corrugations.

Air density is held constant and the modeled chamber is close to ambient pressure. Continuity therefore gives Ṽ = Qᵢₙ − Qₒᵤₜ. Ideal opposed check valves admit air only when the chamber expands and discharge air only when it contracts. The displayed airflow is the magnitude of the model’s volume derivative during the selected stroke, calculated from the handle trajectory. This study omits pressure drop, air compression, reed stiffness and lag, sealing losses, turbulence and load on the nozzle. The colored traces indicate route and direction. They do not measure local air speed.

The instrument is an original exhibit design with an inspection inlet at the top and an outward nozzle reed. Historical bellows informed the choice of pear-shaped boards, leather folds and tacks.

## Implementation

- `pump.js` defines the common footprint and the stroke trajectory, and asks `@margoengine/physics/hydraulics` (`hingedBellows`) for the loft volume and the signed flow through each check valve.
- `craft.js` and `instrument.js` model the cut intake, walnut grain, brass hardware, mechanical folds, reeds, and air traces directly in Margo.
- `scene.js` handles the controls and rendering. Native WebGPU is preferred. Add `?backend=webgl2` to request the Margo compatibility backend with identical artwork.
- From the showcase root, build with `node build.mjs the-bellows` and the public Margo checkout pinned by the showcase.

## References

- Museum of the Highlands, Brora Heritage Centre. Operating principle and wood/leather construction of the Brora bellows, made in 1900. [Blacksmith’s Bellows](https://museumofthehighlands.org/project/blacksmiths-bellows).
- Museum of English Rural Life, University of Reading. Mounted wood-and-leather bellows and visible metal fasteners. [Brown Bros. bellows, object 93/34](https://www.reading.ac.uk/adlib/Details/collect/6477).
- Havelock Museum. Nozzle, rivets, boards and leather construction reference. [Bellows, HM00.800.0003](https://virtualexhibit.marlboroughmuseum.org.nz/havelock/vewebsite9/exhibit1/e10003a.html).
- Massachusetts Institute of Technology. Mass transport in a deforming control volume. [Fluids Modules: The Transport Theorem](https://web.mit.edu/fluids-modules/www/basic_laws/1-3trans-thm.pdf).
- NASA Glenn Research Center. Mass conservation and constant-density volumetric flow. [Mass Flow Rate Equations](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/mass-flow-rate-equations/).