# Toon Town

A live canal village rendered with Margo Toon and Hatching. Compare cel bands, crossed pen strokes and halftone dots on the same modeled walls, windows, boat, bridge and windmill. The view control swings the camera. Animation turns the windmill, drifts the ripples and carries the boat past the village, and starts paused when the device requests reduced motion.

## Rendering

Toon uses four diffuse bands, a subtle rim and an inverted-hull pass for the outlines. Hatching and halftone replace the bands using Margo's screen-space ink patterns. Stroke coverage increases on faces turned away from the light. One dot per cell grows as the light falls off. The same scene, camera math and lighting draw on WebGPU and Margo's WebGL2 compatibility renderer. The canal is stylized matte geometry with moving markings.

The architecture, village layout, geometry and palette were created for this exhibit. The row houses and windmill draw on Dutch canal and polder architecture. The front camera keeps the houses, mill, boat and span visible together on a 390-pixel phone.

## References

- Amy Gooch, Bruce Gooch, Peter Shirley and Elaine Cohen. *A Non-Photorealistic Lighting Model for Automatic Technical Illustration*, 1998. [Paper](https://doi.org/10.1145/280814.280950)
- Emil Praun, Hugues Hoppe, Matthew Webb and Adam Finkelstein. *Real-Time Hatching*, 2001. [Paper](https://gfx.cs.princeton.edu/pubs/Praun_2001_RH/)
- Georges Winkenbach and David H. Salesin. *Computer-Generated Pen-and-Ink Illustration*, 1994. [Paper](https://grail.cs.washington.edu/projects/cg-illus/)
- Ramesh Raskar and Michael F. Cohen. *Image Precision Silhouette Edges*, 1999. [Paper](https://doi.org/10.1145/300523.300539)
