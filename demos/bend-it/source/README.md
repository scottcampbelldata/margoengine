# Bend It

This original footbridge model starts as straight, segmented mesh geometry. The guide is an editable 3D Catmull–Rom spline. Margo's public `CurveFlow` moves each vertex to its arc-length frame and transforms the normal with the inverse transpose of the deformation. The longitudinal coordinate is fit to the guide length, so the first and last ends stay attached to their path endpoints. Width station measurements use the perpendicular frame. This is a deformation exhibit and does not model material strain or structural strength.

Use Lateral bend for the overall curve, Centre lift for a vertical rise, or drag one of the three internal points in the plan. The numbered Point selector and Side offset slider edit the same offsets with the keyboard. Straight deck restores the unbent geometry, and Reset restores the opening curve.

- Andrew J. Hanson and Hui Ma. [Parallel Transport Approach to Curve Framing](https://hdl.handle.net/2022/34260), Indiana University TR425, 1995. A moving frame gives a ribbon a continuous orientation through straight sections and changes of curvature.
- Wenping Wang, Bert Jüttler, Dayue Zheng, and Yang Liu. [Computation of Rotation Minimizing Frames](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/Computation-of-rotation-minimizing-frames.pdf), ACM Transactions on Graphics, 2008. Its discussion of rotation-minimizing frames explains why the deck avoids abrupt twist.
