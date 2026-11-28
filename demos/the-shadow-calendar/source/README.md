# The Shadow Calendar

Move the time slider to rotate the real shadow of a bronze sundial. Select a date to change the sun’s height and the shadow’s reach at that hour. Overhead view aligns the dial’s true north with the top of the view. Play the day sweeps 08:00–16:00 in 12 seconds.

The original cutaway courtyard, stone pedestal and engraved instrument are made from Margo Engine geometry, all measured in metres. The sundial is horizontal at 43.5° N and its style points along the celestial pole. The hour marks are calculated independently of the solar model and the shadow itself comes from Margo Engine’s directional light and shadow map. The projected distance is measured from the gnomon foot to the projected tip on the horizontal plane of the bronze face. The shadow can extend beyond that face.

The sun's place comes from `sunPath` in `@margoengine/sky/sun` (Spencer's 1971 Fourier series for the declination, with a 365-day reference year, the same series NOAA's calculator uses), and the Play the day sweep is a `Tween` from `@margoengine/tween`. The controls use local apparent solar time, so longitude, time zones, and daylight saving are outside the model. The model uses the solar center and geometric elevation, with no atmospheric refraction.

## References

- NOAA Global Monitoring Laboratory, “General Solar Position Calculations”. [Declination and solar geometry](https://www.gml.noaa.gov/grad/solcalc/solareqns.PDF).
- Ibrahim Reda and Afshin Andreas, “Solar Position Algorithm for Solar Radiation Applications”, 2004. [Solar Energy](https://doi.org/10.1016/j.solener.2003.12.003).
- British Sundial Society, “Glossary Equations” and “Sundial Angle Finder”. [Hour-line geometry and polar style](https://sundialsoc.org.uk/documents/BSS_Glossary_Equations.pdf).
- Richard Glynne, “Horizontal pedestal dial”, 1753, Royal Museums Greenwich. [Reference photograph and construction](https://www.rmg.co.uk/collections/objects/rmgc-object-10401).
- Smithsonian Gardens, “Sundial, Birds”. [Bronze-and-granite pedestal dial reference](https://gardens.si.edu/collections/explore/object/hac_1984.187).
