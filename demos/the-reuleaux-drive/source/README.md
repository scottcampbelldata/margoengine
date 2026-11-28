# The Reuleaux Drive

Turn the cam inside its 456 mm square guide. Four amber markers show the exact wall contacts. The blue curve is the cam's center path in the frame coordinate system. The offset readouts use right and up as positive. The center moves even as the cam stays the same width.

The cam is the intersection of three radius-456 mm disks centered on the vertices of an equilateral 456 mm triangle. To get the support along a rotated wall normal, the solver checks the three vertices and the admissible circular-arc tangent points. Each pair of opposite supports is one width apart. Translating the right and upper supports to half-width aligns the left and bottom supports with the other two walls. The path is traced from the same analytic poses. Threefold symmetry makes the center trace repeat every 120°.

The guides show ideal planar geometry. The render approximates the curved flanks by finely sampled circular arcs, with a chamfer on the front face. The model omits contact forces, friction, wear and drive loads. No drilling or material removal is simulated. The fixture and its artwork are original Margo Engine geometry.

## References

- Cornell University Library, *Curved Triangular Rotor in a Square Chamber*, Reuleaux Kinematic Mechanisms Collection, late nineteenth century. [Surviving constant-width demonstration model](https://dcp-production-container.library.cornell.edu/catalog/ss%3A29271965).
- Francis C. Moon, *Franz Reuleaux: Contributions to 19th C. Kinematics*, Cornell KMODDL (2002). [Curves of constant breadth and the Reuleaux rotors](https://ecommons.cornell.edu/bitstream/1813/2712/1/2002-2.pdf).
- Atractor, “Curves of Constant Width”. [Opposite supports and the moving square guide](https://www.atractor.pt/mat/largura_constante/larguraConstante-_en.html).
- Harry J. Watts, *Drill or Boring Member*, U.S. Patent 1,241,176 (1917). [Historical application of the cam geometry](https://patents.google.com/patent/US1241176A/en).
