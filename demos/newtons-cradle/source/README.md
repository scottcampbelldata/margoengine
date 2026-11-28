# Newton’s Cradle

Set how many balls to lift and release the cradle. Slow motion keeps the same collision model running at one quarter speed. The mechanical-energy reading includes gravitational, kinetic, and transient elastic contact energy.

The five identical steel spheres are constrained to measured-length pendulum arcs. Adjacent spheres compress elastically according to the Hertz law, with velocity-dependent dissipative contact and weak pendulum damping. Contacts are integrated together at 60 kHz rather than assigned a predetermined outgoing velocity. The initial slot clearance is 22 µm. The model uses small contact deformation and ideal pivots. It omits spin, thread stretch, frame vibration and acoustics.

The original artwork runs in Margo Engine. Append `?backend=webgl2` to test compatibility rendering.

## References

- Stefan Hutzler, Gary Delaney, Denis Weaire and Finn MacLeod, *Rocking Newton’s cradle*, 2004. [American Journal of Physics](https://www.maths.tcd.ie/~garyd/Publications/Delaney_2004_AmJPhys_Rocking_Newtons_Cradle.pdf).
- K. H. Hunt and F. R. E. Crossley, *Coefficient of Restitution Interpreted as Damping in Vibroimpact*, 1975. [Journal of Applied Mechanics](https://doi.org/10.1115/1.3423596).
