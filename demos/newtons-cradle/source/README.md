# Newton’s Cradle

Set how many balls to lift and release the cradle. Slow motion runs the same simulation at one quarter speed. The energy reading is the balls' kinetic plus gravitational energy as a share of what the lifted balls started with.

The five 26 mm steel spheres are rigid bodies in `@margoengine/physics`, each hung from the frame by a hinge on a 247 mm arm, as the two strings of a real cradle keep a ball swinging in one plane. They touch in a line. When a moving ball strikes the line, the engine resolves the strike one pair at a time before its contact solve (Guendelman, Bridson and Fedkiw 2003), so one lifted ball sends one off the far end and two send two. Each pair bounces with a restitution of 0.995 for hardened, polished steel at under 1 m/s. The simulation steps at 240 Hz. It omits air drag, thread stretch, frame vibration and sound.

The page runs in Margo Engine. Append `?backend=webgl2` to test compatibility rendering.

## References

- Eran Guendelman, Robert Bridson and Ronald Fedkiw, *Nonconvex Rigid Bodies with Stacking*, 2003. [ACM Transactions on Graphics](https://doi.org/10.1145/882262.882358).
- Stefan Hutzler, Gary Delaney, Denis Weaire and Finn MacLeod, *Rocking Newton’s cradle*, 2004. [American Journal of Physics](https://www.maths.tcd.ie/~garyd/Publications/Delaney_2004_AmJPhys_Rocking_Newtons_Cradle.pdf).
