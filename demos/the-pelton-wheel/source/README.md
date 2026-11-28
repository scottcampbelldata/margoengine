# The Pelton Wheel

Adjust the runner from 0 to 700 revolutions per minute in 1 rpm increments. The incoming jet retains the same speed at every setting. Its two outlet sheets change direction as the bucket speed changes. The exhibit reports steady shaft power, torque and efficiency. Motion is slowed for inspection. With reduced motion active, **Step motion** advances the apparatus one small step. The same geometry and material maps render through Margo Engine's WebGPU and WebGL2 paths.

## Model

One jet has a 17 mm diameter and an 8.60 m net head. The bucket pitch radius is 167 mm. The nozzle velocity coefficient is 0.978, the bucket retains 90% of the inlet relative speed, and the return angle is 18° from perfect reversal. These illustrative design parameters give 12.702 m/s jet speed and approximately 2.883 L/s. Water density is 998.2 kg/m³ and gravitational acceleration is 9.80665 m/s².

For net head **H**, nozzle area **A** and velocity coefficient **C**, the jet velocity is **v = C√(2gH)** and the mass flow is **ṁ = ρAv**. The runner speed is **u = rω**. A bucket receives water at relative speed **v − u** and the two sides return it with speed **k(v − u)** relative to the bucket. The two equal branches have opposite lateral momentum. The stationary-frame tangential outlet speed **Vt = u − k(v − u) cos β** follows from adding the bucket speed. The tangential force is **F = ṁ(v − Vt)**, shaft torque is **rF**, shaft power is **Fu**, and efficiency is **Fu/(ṁgH)**. The result is quadratic in the rim speed. It peaks at **u = v/2**, or 363.15 rpm here, with about 215.4 W and 88.8% efficiency. The stationary wheel has nonzero torque and zero shaft power.

The rendered outlet trajectories show representative points from the lips of the top bucket. Their initial velocities use the computed tangential and transverse exit components, and their subsequent vertical drop follows gravity. The two transverse branches divide into opposite lateral directions and a shared downward direction. The short segments over the cup faces illustrate the split. The free sheets and tracer glints show the first 34 ms after release. The display models a steady train of buckets. Catch-basin waves, individual impact transients, droplet breakup, bearing drag, shaft load dynamics, and electrical generation are outside the model. The slider imposes a steady runner speed.

## References and provenance

- [David Apsley, *Hydraulics 2, Topic T4: Pumps and Turbines*, University of Manchester, 2025](https://personalpages.manchester.ac.uk/staff/david.d.apsley/lectures/hydraulics2/t4.pdf). Pelton velocity triangles, momentum transfer, bucket friction, and the ideal speed for maximum power.
- [U.S. Department of Energy, *Types of Hydropower Turbines*](https://www.energy.gov/cmei/water/types-hydropower-turbines). Free-jet impulse operation and the Pelton runner.
- [Chirag Trivedi, *Hydropower exercise*, NTNU Waterpower Laboratory, 2026](https://www.ntnu.no/wiki/spaces/tep4111/pages/356845433/Hydropower%2Bexercise). Primary laboratory exercise on speed and efficiency.
- [Science Museum Group, *Pelton Wheel Turbine*, 1907–1917, collection object 1913-466/1](https://collection.sciencemuseumgroup.org.uk/objects/co52266/pelton-wheel-turbine). Collection research for historical brass and nickel apparatus. The wheel, glazed splash guard, plumbing, display base, textures and staging are original geometry and materials. No collection mesh or photo is included.

Run the Margo showcase build at the repository root and serve the output over HTTP. Add `?backend=webgl2` to exercise Margo's compatibility renderer. The engine packages come from the public Margo commit recorded by the showcase build.
