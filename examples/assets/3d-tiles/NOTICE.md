# 3D Tiles samples

Real tilesets from Cesium's official 3D Tiles samples repository, https://github.com/CesiumGS/3d-tiles-samples, commit
a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56 (2026-09-16), downloaded 2026-11-07 from that repository on GitHub and not
modified. Each sample's licence is the one its own README there states. The tiles package tests and the README check
(`npm run check:readme-run`) read them; no npm tarball ships them.

| Folder | Source folder | Licence | Files (sha256 as downloaded) |
| --- | --- | --- | --- |
| `TilesetWithTreeBillboards` | `1.0/TilesetWithTreeBillboards` | CC0 1.0 | `tileset.json` 98489c972e72791e53f475b61c6411284ac9c57a76e6ddc4c7944380638d78b8, `tree.i3dm` b62cf0ab1769cf11869a8c55965423be2fbe767c0c417d82669a416d506b5904, `tree_billboard.i3dm` 492a24393a3782e5c940b0afd5b9c91d0cf035c2459b3b9ea9c0712bd9f148d4 |
| `TilesetWithRequestVolume/city` | `1.0/TilesetWithRequestVolume/city` | CC BY 3.0 Unported, Cesium | `tileset.json` fbd40810298879b840206254f28802522ce2c0693e7790a086674296db811097, `ll.b3dm` 1239e2504634f97497192a4a1af6dd1321636da7421bea3d243eff1e025aa9cc, `lr.b3dm` c33e26647f7d44623eae6049a7e093fe20a57a4bf42a3191b208abf5bdbdcb77, `ul.b3dm` 601ba49e4547f7680dcd28b7848221a86e804f46c0b4c6577f082349e5f7665c, `ur.b3dm` 2381d07524f621e6b5c093a17df9539eeb11323ebc13d87fa766221efaed0e1d |

Only the `city` sub-tileset of TilesetWithRequestVolume is kept; its building model (by Richard Edwards) and point cloud
are left out for their size.
