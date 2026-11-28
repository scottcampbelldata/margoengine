# The Rolling Race

Release the brass disc and the steel ring together. Both have the same 63 mm outer radius. The ring's bore has a radius of 56.7 mm. The ramp angle is adjustable, and the clock records each centre as it crosses the timing line 0.701 m from the start.

The model assumes rigid, uniform bodies released from rest with enough static friction to roll without slipping. The linear acceleration is g sin(θ)/(1 + I/(mR²)). The solid disc has I/(mR²) = 1/2 and the annular cylinder has I/(mR²) = (1 + r²/R²)/2. Both rotate by the travelled distance divided by the outer radius. Bearing, deformation and air losses are omitted from the timed region. The catch zone uses idealized braking after timing is complete.

The scene uses Margo Engine. Append `?backend=webgl2` to test the same scene through the compatibility renderer.

## References

- University of California, Santa Barbara, *28.27 — Roll cylinders down incline*. [Laboratory apparatus and timing demonstration](https://web.physics.ucsb.edu/~lecturedemonstrations/Composer/Pages/28.27.html).
- Yale University, *1Q10.30 — Rolling objects of different moments of inertia*. [Ring and disc demonstration](https://yppsweb2.its.yale.edu/physics/demos/demomain.asp?id=1Q10.30&task=viewdemo).
- OpenStax, *University Physics Volume 1*, §11.1. [Rolling motion without slipping](https://openstax.org/books/university-physics-volume-1/pages/11-1-rolling-motion).
