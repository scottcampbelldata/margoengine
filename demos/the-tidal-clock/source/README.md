# The Tidal Clock

Scrub through 24 hours and watch a model harbor flood and uncover its sand flats. The floating buoy rises with the water, the indicator follows the tide staff, and the marker on the rim follows the time control. Switch between a spring day and a neap day to compare the water ranges.

## Illustrative tide model

The model adds the principal lunar semidiurnal constituent (M₂) and the principal solar semidiurnal constituent (S₂). It uses their NOAA angular speeds of 28.9841042° and 30° per solar hour. The exhibit assumes amplitudes of 0.88 m and 0.39 m and sets mean water to zero. The combined elevation is 0.88 cos(ωₘ t) + 0.39 cos(ωₛ t) in meters, with angles converted to radians. At the start of the spring day the two constituents align. The neap day begins half of the resulting 14.77-day beat period later. Both time sliders describe relative model time. The 24-hour range is the highest height minus the lowest height in the selected interval, located from turning points and its endpoints.

The harbor, constituent amplitudes and starting phase are invented for the exhibit. A real tide prediction needs harmonic constants and a datum for a specific station, plus many more constituents. Weather, currents, surge, wave action and harbor-specific delays are outside the model. The rendered waterline follows the sum of the two constituents. Foamy edges and surface glints are illustrative.

## Implementation

- `tide.js` computes the harmonic sum, its slope and the daily extrema.
- `harbor.js` and `geometry.js` create the circular cabinet, carved foreshore, stone quay, cottages, observatory staff and floating buoy. The water plane and the tide staff pointer use the same height.
- `scene.js` connects the controls and playback to Margo Engine. Native WebGPU opens first. Add `?backend=webgl2` to request the Margo compatibility backend with the same artwork.
- Build from the showcase root with `node build.mjs the-tidal-clock` using the verified public Margo revision pinned by the showcase.

## References

- NOAA Center for Operational Oceanographic Products and Services (2006). Appendix C, speeds of M₂ and S₂ in degrees per hour. [Skill Assessment of NOS Water Level and Current Forecast Systems](https://tidesandcurrents.noaa.gov/ofs/publications/CS_Techrpt_024_SkillAss_WLsCUs_2006.pdf).
- NOAA Center for Operational Oceanographic Products and Services. Sum of harmonic constituents and the role of station constants. [About Harmonic Constituents](https://tidesandcurrents.noaa.gov/about_harmonic_constituents).
- NOAA National Ocean Service. Spring and neap ranges. [What are spring and neap tides?](https://oceanservice.noaa.gov/facts/springtide.html).
- NOAA Heritage. Graduated tide staffs and historical float-based water-level observation. [Changing Technology for Tide Measurements](https://www.noaa.gov/heritage/resource-collections/changing-technology-for-tide-measurements-way-it-was).
- Historic England Archive. Pier and lighthouse design reference. [The entrance to Whitby Harbour, c. 1880–1890](https://historicengland.org.uk/images-books/photos/item/JRC01/01/090/047).