# Many Goals

One four-hinge inspection arm carries three contacts. **Brace**, **Gauge**, and **Probe** set which contact gets the highest weight. **Equal** weights all three together. At zero fixture spread, all three targets align with one valid arm pose. At higher spread the target rings move apart according to three individually reachable calibration poses. The solid tips are the arm’s contacts, and dashed marks show the actual gaps.

## Model

The public **MultiGoalIKSolver** fits three world position goals simultaneously using damped least squares and bounded revolute joints. The three priority settings cycle the position weights 28, 5, and 1. The equal setting uses three weights of 1. These are weighted priorities within one objective. For each displayed pose the table measures the unweighted Euclidean distance between each engine-evaluated attachment and its target. Tests independently recompute the distances and the weighted sum of their squares.

The arm, inspection backplate, bearings, and contacts are original geometry drawn in Margo. The joints, arms and tool mounts are modeled at a one-metre world scale. The pose transition interpolates four bounded joint angles and evaluates the same forward kinematics on every frame. The exhibit demonstrates geometric targets and pose tradeoffs without simulating contact forces or dynamics. The Margo source pin is **0efd9cff8230507a32deb49907ecd499d46925f5**.

## Verification

At 75% spread, giving Gauge priority reduced its settled gap from 258 mm to 23 mm. The other two gaps changed from 78 and 332 mm to 418 and 95 mm. All ranks recovered three zero-gap contacts in the aligned case. The native and compatibility browser tests also checked the per-contact reported distances against the pinned solver.

| Browser profile | First rendered priority change |
| --- | ---: |
| 390 px phone, native WebGPU | 1.126 s |
| 390 px phone, automatic WebGL2 | 1.154 s |
| 390 px phone, forced WebGL2 | 1.166 s |
| 1440 px desktop, native WebGPU | 0.422 s |

Phone timings use actual touch in cold Chrome emulation at 150 ms latency, 1.6 Mbps downstream and fourfold CPU slowdown.

## References

- Samuel R. Buss and Jin-Su Kim, *Selectively Damped Least Squares for Inverse Kinematics*, 2005. [Multiple end-effector problems and damping](https://mathweb.ucsd.edu/~sbuss/ResearchWeb/ikmethods/SdlsPaper.pdf)
- Yoshihiko Nakamura, Hideo Hanafusa and Tsuneo Yoshikawa, *Task-Priority Based Redundancy Control of Robot Manipulators*, 1987. [Task-priority background](https://doi.org/10.1177/027836498700600201)
- Scott Campbell, Margo Engine’s multi-goal solver. [Published source at the verified pin](https://github.com/scottcampbelldata/margoengine/blob/0efd9cff8230507a32deb49907ecd499d46925f5/packages/kinematics-constraints/src/multi-goal.ts)
- Universal Robots. [Joint housings, base and tool flange](https://www.universal-robots.com/manuals/EN/HTML/SW5_23/Content/prod-usr-man/complianceUR5e/comp-introduction/RobotArm.htm)
- Renishaw. [Inspection tool and stylus references](https://www.renishaw.com/en/high-accuracy-touch-probes-for-cnc-machines--48592)
