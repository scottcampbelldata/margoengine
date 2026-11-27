# The Night City

Port Meridian is an original, fictional city of 98 blocks and 502 buildings. Its late-summer Sun follows Margo Engine's solar path at 34.6° north on day 238 of the year. The control spans 17:30–21:00 local apparent solar time. It drives the Sun, sky, atmospheric haze, and street lighting in the same frame.

The city's seed and custom skyline plan produce podiums, stepped glass towers, older masonry blocks, foothills, and small parks. Building rules supply representative street-front masonry. Road sweeps supply avenue markings. Roof equipment uses geometric level of detail. The page uses the same city, lights, and reflection passes on desktop and phone. The engine quality tier controls sampling and the reflection march budget.

The lighting wave is a designed district schedule for the exhibit. An occupied pane draws in world space with a short brightness ramp. Every street fixture uses the same district schedule and feeds a clustered spot light aimed at the street. Counts record fixtures and occupied panes whose ramps have started. At full night the city has 26,738 lit panes and 3,342 active street lamps. The sky model supplies atmospheric lighting. The glass curtain walls and asphalt use Margo screen-space reflections and bloom, with reflection rays bounded by the current view.

## Review

1. Scrub from 17:30 to 21:00. At the left end the windows and lamps are off. At 18:57 some blocks are lit, and at 21:00 the whole schedule is active.
2. Select **Avenue** at night. The street lamps illuminate separate patches of road, and neighboring panes appear as reflections on the asphalt and glass.
3. Return to **Skyline** and use **Play evening** to see the wave move across the city. Pause at any time to inspect it.

The exhibit uses WebGPU first and supports the full Margo WebGL2 compatibility path through automatic escalation. All geometry, materials, and lamp scheduling are authored in code. The city uses no external asset files.

## References

- Yoav I. H. Parish and Pascal Müller, *Procedural Modeling of Cities* (2001). [Street networks and lot generation](https://cgl.ethz.ch/Downloads/Publications/Papers/2001/p_Par01.pdf).
- Pascal Müller, Peter Wonka, Simon Haegler, Andreas Ulmer, and Luc Van Gool, *Procedural Modeling of Buildings* (2006). [Rule-based architectural shells and façade subdivisions](https://doi.org/10.1145/1141911.1141931).
- Morgan McGuire and Michael Mara, *Efficient GPU Screen-Space Ray Tracing* (2014). [Screen-space reflection sampling and constraints](https://jcgt.org/published/0003/04/04/).
- Hong Kong Tourism Board, *8 Best Vantage Points for Viewing the Iconic Skyline*. [Reference for the massing, twilight color, and distant ridgelines](https://www.discoverhongkong.com/eng/attractions/the-best-vantage-points-for-viewing-the-iconic-skyline.html).
- U.S. Naval Observatory, *Rise, Set, and Twilight Definitions*. [Solar elevation and twilight](https://aa.usno.navy.mil/faq/RST_defs).
