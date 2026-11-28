# The Marble Sorter

Release an opaque streak-glass marble and choose its tray while it rolls. The junction locks on the final approach. Each tray holds six marbles. **Junction view** brings the working switch closer, and **Reset** clears both trays. The buttons support touch and keyboard input. Reduced-motion settings disable the camera and lever transitions while keeping the rolling demonstration available on demand.

The brass rail profiles follow the same arc-length paths that drive the marbles. The model uses the gravitational drop, a solid sphere's inertia, and the effective rolling radius at the two rail contacts to calculate velocity and rotation. The tray landing uses a short ballistic drop, a damped rebound, and a capture path to an open slot. This constrained model illustrates rolling and track switching without simulating arbitrary collisions between loose marbles.

All geometry, material ribbons, lighting, and shadows are drawn with Margo Engine. The same scene and rendering settings run on phone and desktop. WebGPU is tried first. A browser without an available WebGPU adapter uses Margo's WebGL2 compatibility layer. Add `?backend=webgl2` to exercise that path directly. The gallery's build uses packages from the verified public [Margo Engine checkout](https://github.com/scottcampbelldata/margoengine/tree/0efd9cff8230507a32deb49907ecd499d46925f5).

## Research

- Samuel J. Ling, Jeff Sanny, and William Moebs, *University Physics Volume 1*, “Rolling Motion” (2016). Solid-sphere inertia and energy for rolling without slipping. [OpenStax](https://openstax.org/books/university-physics-volume-1/pages/11-1-rolling-motion)
- Hong Kong Science Museum, *Energy Machine*. Exhibit reference for making gravitational energy visible through ball routing. [Hong Kong Science Museum](https://hk.science.museum/en/web/scm/exhibition/em.html)
- The MAD Museum, *Assembly Instructions for MAD Marble Machine #2* (2021). Visual reference for rail, collar, and tray construction. [Museum instructions](https://themadmuseum.co.uk/wp-content/uploads/2021/07/mm2v4.pdf)
- Corning Museum of Glass, *Marble*, object 61206. Collection reference for the appearance of streak glass. [Corning Museum of Glass](https://glasscollection.cmog.org/objects/61206/marble)
- William T. Reeves, David H. Salesin, and Robert L. Cook, *Rendering Antialiased Shadows with Depth Maps* (1987), and Randima Fernando, *Percentage-Closer Soft Shadows* (2005). Filtering and contact hardening for cast shadows. [Pixar](https://graphics.pixar.com/library/ShadowMaps/paper.pdf) [NVIDIA](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/PCSS.pdf)
