# CMU motion capture takes

Test data for `tests/modern-animator-real-mocap.test.js`, kept in the repository and never shipped in a package. Speeds are what the takes measure at 1 BVH unit = 2.54 / 45 m.

| File | What it is | SHA-256 |
| --- | --- | --- |
| `02_01.bvh` | Subject 2, walk | `cf56db43157acc3d200b3d4215523f54d354a8926bea67e1f6c8031bd335ba7e` |
| `16_11.bvh` | Subject 16, walk, veer left | `efeb0ebb07ab6491f4e51c32561b54a1643451e6e9a269bcf55799268f9c404a` |
| `16_15.bvh` | Subject 16, walk at 1.1 m/s | `7459cd4be169477b4e2c629075a9cde9436e37a87cdf4e774574400f4ec942d8` |
| `16_21.bvh` | Subject 16, walk at 1.7 m/s | `fa1ac84e2efca453c4cd002b0d908f1e6c1fab4aa237898ac3ee5c80efdddd0e` |
| `16_32.bvh` | Subject 16, stand, then walk | `85c04d40dafd959d07e910ea97179e72367915050002ade48c7ad21d33803a88` |
| `16_36.bvh` | Subject 16, jog at 2.7 m/s | `bc99c89352df21f9fed601b4529f430e364c174b6e87527144b6143e04005caf` |
| `16_45.bvh` | Subject 16, run at 4 m/s | `6c179f799f3b2f766ce41cf962caaae08d9342ce73fc32fbc15648bf6589e872` |
| `16_47.bvh` | Subject 16, walk at 1.3 m/s | `2138c2e46a95052a437a71b1bff5680fb490636c989556576b0533754ee61cf6` |
| `16_57.bvh` | Subject 16, jog, then stop | `b400e99a6acc63ccf04434a678c82673ad58f93f87bdaac87303c2dc2f775afc` |

Source: the CMU Graphics Lab Motion Capture Database, <http://mocap.cs.cmu.edu/>, in the BVH conversion by Bruce Hahne, as mirrored at <https://github.com/una-dinosauria/cmu-mocap> (commit `09a07f54f3bbb58797325f009282d0b2048a2871`, `data/002/` and `data/016/`). The files are not modified.

The database's terms: "This data is free for use in research and commercial projects worldwide." The conversion's READMEFIRST.txt places no further restrictions on it.

The data used in this project was obtained from mocap.cs.cmu.edu. The database was created with funding from NSF EIA-0196217.
