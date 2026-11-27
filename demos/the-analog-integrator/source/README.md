# The Analog Integrator

Drag the roller position slider across the disk. Hold at the center to keep the disk turning while the output wheel stops. On opposite sides the amber roller and striped output wheel turn in opposite directions. The total counts signed wheel turns since opening the page or clicking **Zero output**. **Pause disk** freezes both shafts and saves the current total.

## Kinematics

The horizontal disk has a 240 mm radius and runs at 0.40 turns per second. The 46 mm radius roller slides along the X axis up to 195 mm either side of center and shares a keyed shaft with the output wheel. Positive disk rotation is about +Y. At contact `(r, 0, 0)` the disk's velocity along Z is `−ωdisk × r`. The roller's velocity at its bottom surface is `−ωroller × 46 mm`. Equating these gives `ωroller = ωdisk × r / 46 mm`. Thus the total output is `∫ r / 46 mm d(disk turns)`. Positive and negative inputs add to and subtract from the same running total.

Slider events hold the new position until the next event. At every change the elapsed disk travel is multiplied by the previous radius ratio before applying the new position. This integrates the accepted control path exactly up to floating-point roundoff and yields the same result across frame rates. The motor pauses when the tab is hidden. Users with reduced motion enabled can start the motor manually. The model isolates rolling contact along the tangent and omits slip, torque, inertia, finite contact width and the rest of the differential analyzer.

## Review

1. Drag from one side to the other. The position and direction readouts follow the roller, and the striped wheel on the right reverses.
2. Tap the middle or focus the slider and use the arrow keys to reach 0 mm. The disk keeps spinning while the striped wheel and running total stay fixed.
3. Pause and zero the output. Resume on one side, then move to the other and watch the displayed signed total change in the opposite direction.

## References

- Vannevar Bush, *The differential analyzer. A new machine for solving differential equations* (1931). [Original Journal of the Franklin Institute paper](https://www.sciencedirect.com/science/article/abs/pii/S0016003231906169).
- Science Museum Group, *Manchester University Differential Analyser* (1935). [Original instrument with wheel-and-disk integrators](https://collection.sciencemuseumgroup.org.uk/objects/co59975/manchester-university-differential-analyser-analogue-computer-differential-analyser).
- Smithsonian Institution, *UCLA Differential Analyzer Components – Two Wheel and Disc Integrators*. [Original General Electric units](https://www.si.edu/object/ucla-differential-analyzer-components-two-wheel-and-disc-integrators-1-and-2%3Anmah_689956).
