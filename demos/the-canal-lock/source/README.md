# The Canal Lock

Send the narrowboat up to the higher reach and back again. The boat enters while the gate at its own water level is open. Both pairs close before the culvert valves operate. The exit gates open after the chamber reaches the destination level.

## Hydraulic model

The uniform rectangular chamber is 18.4 m by 4.5 m. The lower and upper levels are 0.92 m and 2.72 m above the model datum. The supply and receiving reaches maintain fixed levels. An equivalent sidewall culvert and valve system has a combined opening area of 1.75 m² and an assumed discharge coefficient of 0.62. A valve connects the chamber to one reach at a time. The fully floating boat displaces a constant volume through the transfer.

The signed discharge is Q = Cᵈ Aᵥ sign(Δh) √(2g |Δh|), where Δh is the level difference between open reach and chamber. Continuity gives dh/dt = Q/A of the chamber. Integrating the equation reduces √|Δh| linearly to zero. The chamber transfers 149.04 m³ through a complete 1.80 m lift or drop. The mathematical hydraulic phase takes about 46 seconds, accelerated by 12.2 times for the exhibit. The buttons also pause, resume, and reset the model. The following passage reverses the itinerary.

The gate interlock and level dynamics are from this model. The cutaway removes the viewer-side wall above the section line for visibility. Surface wavelets and culvert markings are illustrative. This study describes level changes rather than detailed currents, vessel hydrodynamics, valve travel, surge, or structural forces on a real lock.

## Implementation

- `lockage.js` implements the analytic water balance and gated phases.
- `geometry.js` and `model.js` build the chamber, water prism, masonry cutaway, cottage, miter gates and narrowboat directly in Margo.
- `scene.js` connects playback, accessible state and Margo rendering. Add `?backend=webgl2` to request the Margo compatibility backend with the same art.
- From the showcase root, build with `node build.mjs the-canal-lock` and the public Margo checkout pinned by the showcase.

## References

- U.S. Army Corps of Engineers (2006). Navigation lock hydraulics, miter gates, and filling/emptying system design. [EM 1110‑2‑1604 Hydraulic Design of Navigation Locks](https://www.publications.usace.army.mil/Portals/76/Publications/EngineerManuals/EM_1110-2-1604.pdf?ver=2013-09-04-161107-413).
- U.S. Army Corps of Engineers (2018). Sidewall ports, culverts, and independent filling/emptying valves. [EM 1110‑2‑1610 Hydraulic Design of Lock Culvert Valves](https://www.publications.usace.army.mil/Portals/76/Users/182/86/2486/EM_1110-2-1610.pdf).
- U.S. National Park Service. Water level equalization and miter-gate operation on the Chesapeake and Ohio Canal. [The Power of Water: Transportation](https://home.nps.gov/articles/000/the-power-of-water-transportation.htm).
- Canal & River Trust. Narrowboat passage and visualization reference for the masonry, balance beams, and moorings. [How does a canal lock work?](https://canalrivertrust.org.uk/canals-and-rivers/how-does-a-canal-lock-work).
- U.S. Bureau of Reclamation. Submerged orifice discharge and effective head. [Water Measurement Manual, Chapter 9](https://www.usbr.gov/tsc/techreferences/mands/wmm/chap09_01.html).