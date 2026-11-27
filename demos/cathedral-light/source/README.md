# Cathedral Light

Slide the local solar time from 08:00 to 17:00 to move the light falling through the south lancets. The readouts show solar elevation above the horizon and bearing clockwise from north. The morning, noon and afternoon buttons jump to the same values as the slider.

## The building

An original six-bay limestone nave. The pointed clerestory openings extend through the full wall thickness. The masonry, mullions, vaulted bays, ribs, rose window and oak stalls are built in Margo coordinates at architectural scale. The glass uses a Margo shader for lead and colored quarries. A separate shadow map for each window lets the real stone and tracery interrupt the modeled sunlight.

## The light

The solar vector uses latitude 48.2° N and a fixed declination of −4° for an illustrative autumn day. Hour angle advances by 15° per hour from local solar noon. The model gives geometric solar position and omits atmospheric horizon refraction and civil-time corrections. A ray from the reference window is projected onto level paving for the position recorded by the browser check.

Six distant spot sources follow the same solar vector. Each source points through the center of a window, approximating parallel sunlight over the interior. Their colors approximate the average transmission per window. The model does not compute the spectral transmission of each glass pane. Margo clustered spot shadows capture the masonry and mullions. Margo volumetric fog scatters the light in the nave. Screen-space global illumination supplies a first bounce and bloom softens the brightest glass. The camera and exposure stay fixed while the sun moves.

The page uses Margo’s WebGPU-first automatic engine bootstrap. Compatible WebGL2 hardware runs the same scene. Devices lacking the necessary GPU support receive the engine’s error message and a WebGPU help link. Add `?backend=webgl2` to exercise that route.

## Sources

- The Metropolitan Museum of Art, Department of Medieval Art and The Cloisters, **Gothic Art** (2002). Architectural reference for pointed arches, ribbed vaults, the three-part elevation and colored glass. [The Met](https://www.metmuseum.org/pt/essays/gothic-art)
- Wells Cathedral, **Wells Cathedral Timeline**. Architectural references for Early English Gothic nave proportions, carved stone and arch details. [Wells Cathedral](https://www.wellscathedral.org.uk/heritage-conservation/wells-cathedral-timeline)
- Ibrahim Reda and Afshin Andreas, **Solar Position Algorithm for Solar Radiation Applications** (2004). Reference for solar angle definitions and solar-position conventions. [National Laboratory of the Rockies](https://research-hub.nlr.gov/en/publications/solar-position-algorithm-for-solar-radiation-applications-2/)
- Sébastien Hillaire, **Physically-based and Unified Volumetric Rendering in Frostbite** (2015). Reference for interpreting in-engine volumetric scattering and shadowed illumination. [SIGGRAPH course notes](https://sebh.github.io/publications/)

The public Margo Engine example inspired the interactive premise. All exhibit meshes, glass artwork and scene code were authored for this page.
