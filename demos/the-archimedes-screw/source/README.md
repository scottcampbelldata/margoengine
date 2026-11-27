# The Archimedes Screw

Change the motor speed to see the single copper flight rotate inside a stationary trough. The cutaway shows separate pockets of water rising while their surfaces remain horizontal. Pause the rotor to inspect the pockets. With reduced motion enabled, the button advances the screw by one eighth of a turn.

## Geometry and flow

The shaft is inclined 26° above horizontal. The lift along the modeled 1.43 m shaft is 0.627 m. The pitch p is 0.348 m, the shaft radius is 0.061 m, and the modeled casing radius is 0.175 m. One revolution advances the trapped pockets one full pitch along the shaft, equivalent to 0.153 m of vertical rise per turn. This corresponds to an axial pattern speed of p × RPM / 60.

An ideal bucket is bounded by adjacent turns of the modeled flight and the circular casing. At azimuth θ, its low axial boundary x₀ is pθ/(2π). Represent an axial point within the corresponding bucket by x = x₀ + λ, where λ lies between zero and p. Its height relative to the screw origin is x sin α + r cos θ cos α, where α is the shaft incline and r is the radius. The horizontal free surface is 2.8 mm below the lowest point along the corresponding inner-shaft flight, leaving a small no-spill margin. For each azimuth, the solver integrates the available radial area between that plane and the casing, then integrates over azimuth. The nominal full bucket contains about 2.32 L. One bucket reaches the outlet per revolution of this single-start screw, so the ideal average discharge in L/min is bucket volume in liters multiplied by RPM.

The exhibit assumes filled pockets and fixed reservoir levels. The front half of the casing is sectioned away for visibility. The modeled liquid shape uses the calculated free surface and is clipped at each end of the screw. The small discharge glints are illustrative. The model omits tip leakage, sloshing, partial filling, torque, and transient energy losses, so it gives a geometric ideal rather than measured pump performance.

## Implementation

- `screw.js` calculates pocket capacity, phase and ideal discharge.
- `geometry.js` builds the finite helix, trough and water volumes. `machine.js` assembles the rotating drive and the two basins.
- `scene.js` implements the controls through Margo Engine. Add `?backend=webgl2` to request the Margo compatibility backend, which renders the same artwork.
- Build from the showcase root using `node build.mjs the-archimedes-screw` and the verified public Margo revision pinned there.

## References

- Chris Rorres (2000). Screw geometry, water trapped between flights, the inner-shaft spill criterion, and volume conveyed per turn. [The Turn of the Screw: Optimal Design of an Archimedes Screw](https://cs.drexel.edu/~crorres/screw/screw.pdf).
- Murray Lyons, Scott Simmons, Maxwell Fisher, James Sebastien Williams and William David Lubitz (2020). Laboratory measurements of flow versus rotational speed and inlet water level. [Experimental Investigation of Archimedes Screw Pump](https://doi.org/10.1061/%28ASCE%29HY.1943-7900.0001786).
- Science Museum Group. Water-lifting pump reference. [Archimedean Screw, accession 1924-324](https://collection.sciencemuseumgroup.org.uk/objects/co61358).