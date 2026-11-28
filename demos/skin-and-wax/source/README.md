# Skin and Wax

Brief 88. Move the light around three original display pieces. The beeswax votive has a thin, uneven rim. The marble cup uses a scalloped profile and procedural mineral veins. The nephrite cicada has separately shaped wings, carved lines, and polished eyes. The forms, textures and exhibit furniture were authored for this demo. The view focuses on one specimen at a time on a narrow screen.

**Scatter light** compares the same objects and lamp with the approximation enabled or disabled. The light-angle control keeps the lamp’s elevation fixed as it moves horizontally through 180 degrees. Key intensity, exposure, position, geometry and texture stay fixed when comparing the switch.

The public Margo Materials `subsurface` lobe uses a linear thickness map per material to model directional illumination through thin regions. The public Margo Post `SSS` effect uses a separate subject mask and depth-aware, screen-space diffusion. Select a specimen to apply its diffusion profile to its modeled surfaces. The other visible objects still use their material lobe. The radius settings are 15 mm for wax, 9 mm for marble, and 11 mm for jade. These are display settings for the approximate model, with a matching material pipeline and scene assets on WebGPU and Margo’s WebGL2 compatibility renderer. The compatibility renderer presents the real directional material response first and adds the same screen-space diffusion to that scene after startup.

This setup illustrates how thickness, color, and light position affect the appearance of a translucent solid. The shaped thickness fields represent the modeled objects and were chosen for the exhibit. The demonstration uses approximate diffusion and cannot determine a specimen’s mineral composition or measured optical properties.

## References

- Henrik Wann Jensen, Stephen R. Marschner, Marc Levoy and Pat Hanrahan, [A Practical Model for Subsurface Light Transport](https://graphics.stanford.edu/~srm/publications/SG01-subsurf-abstract.html), SIGGRAPH 2001. Measured and modeled subsurface transport, including marble.
- Jorge Jimenez et al., [Separable Subsurface Scattering](https://iryoku.com/separable-sss/), 2015. Real-time separable screen-space diffusion.
- Per H. Christensen and Brent Burley, [Approximate Reflectance Profiles for Efficient Subsurface Scattering](https://www.seanet.com/~myandper/abstract/memo1504.htm), Pixar Technical Memo 15-04, 2015. Tradeoffs of compact diffuse profiles. The engine uses its own screen-space approximation.
- The Metropolitan Museum of Art, [Cicada, Han dynasty](https://www.metmuseum.org/art/collection/search/42949), and Smithsonian National Museum of Asian Art, [Carving of a cicada](https://asia.si.edu/explore-art-culture/collections/search/edanmdm%3Afsg_S2012.9.1381/). Museum references for carved nephrite and the silhouette. The displayed figure and ornament are original.
- [Margo Material translucency](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/materials#parallax-triplanar-and-subsurface) and [Margo Post SSS](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5/packages/post#subsurface-scattering-sss), from the pinned public engine build.
