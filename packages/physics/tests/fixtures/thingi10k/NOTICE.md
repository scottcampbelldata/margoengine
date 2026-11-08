# Thingi10K test points

Two meshes of the Thingi10K data set (Zhou and Jacobson, "Thingi10K: A Dataset of 10,000 3D-Printing Models", 2016),
each marked Public Domain on Thingiverse per the data set's metadata. Used only by `tests/next-hull.test.js`; never in a
package tarball.

| File | Source | Bytes of the source | SHA-256 of the source |
| --- | --- | --- | --- |
| `40261-points.bin` | https://huggingface.co/datasets/Thingi10K/Thingi10K/resolve/main/raw_meshes/40261.stl | 1,275,984 | faa32af2990bad0273c90212b6b91be0a786a502abfa4504eada9d1c2519caa6 |
| `41940-points.bin` | https://huggingface.co/datasets/Thingi10K/Thingi10K/resolve/main/raw_meshes/41940.stl | 2,197,884 | e7e7be6acd446f9acefc693b3217159ba863b09c90639c1ee8ba91d58800be1f |

Each `.bin` holds the distinct vertices of the binary STL (bit-identical x, y, z taken once), in order of first use, as
little-endian 32-bit floats x, y, z: 12,757 points for 40261 and 21,797 for 41940. Nothing else was changed.
