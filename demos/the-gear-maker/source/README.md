# The Gear Maker

Fit either of the two compound trains or type new tooth counts for wheels A through D. The worker cuts each new involute outline and regenerates its thickness, bore and lightening holes. Use **Input rotation** to turn the input by exactly one revolution or **Run the train** to keep it moving. Inspect either mesh on its own to see the two axial levels of the compound shaft.

The two gears in each mesh share a 62 mm module and a 20° pressure angle. Shaft centers sit at the sum of the two pitch radii. A drives B, B and C share the stud, and C drives D. The output turns in the same direction as the input with the ratio (A C) divided by (B D). Margo's compound angle solver sets the phase every frame. Both backends render the same geometry and contact shadows.

The train is a kinematic exhibit. It illustrates the involute and ratio. Engineering a loaded gear pair also involves backlash, material limits, tolerances and lubrication.

## References

- NASA Jet Propulsion Laboratory. *Fundamentals of Involute Spur Gears*. [Technical memorandum](https://ntrs.nasa.gov/api/citations/19640007313/downloads/19640007313.pdf)
- NASA Lewis Research Center. *The Optimal Design of Standard Gearsets*, 1983. [Technical report](https://ntrs.nasa.gov/archive/nasa/casi.ntrs.nasa.gov/19830011874.pdf)
