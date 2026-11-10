# 3D Tiles samples

Real tilesets from Cesium's official 3D Tiles samples repository, https://github.com/CesiumGS/3d-tiles-samples, commit
a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56 (2026-09-16), downloaded 2026-11-07 from that repository on GitHub and not
modified. Each sample's licence is the one its own README there states. The tiles package tests and the README check
(`npm run check:readme-run`) read them; no npm tarball ships them.

| Folder | Source folder | Licence | Files (sha256 as downloaded) |
| --- | --- | --- | --- |
| `TilesetWithTreeBillboards` | `1.0/TilesetWithTreeBillboards` | CC0 1.0 | `tileset.json` 98489c972e72791e53f475b61c6411284ac9c57a76e6ddc4c7944380638d78b8, `tree.i3dm` b62cf0ab1769cf11869a8c55965423be2fbe767c0c417d82669a416d506b5904, `tree_billboard.i3dm` 492a24393a3782e5c940b0afd5b9c91d0cf035c2459b3b9ea9c0712bd9f148d4 |
| `TilesetWithRequestVolume/city` | `1.0/TilesetWithRequestVolume/city` | CC BY 3.0 Unported, Cesium | `tileset.json` fbd40810298879b840206254f28802522ce2c0693e7790a086674296db811097, `ll.b3dm` 1239e2504634f97497192a4a1af6dd1321636da7421bea3d243eff1e025aa9cc, `lr.b3dm` c33e26647f7d44623eae6049a7e093fe20a57a4bf42a3191b208abf5bdbdcb77, `ul.b3dm` 601ba49e4547f7680dcd28b7848221a86e804f46c0b4c6577f082349e5f7665c, `ur.b3dm` 2381d07524f621e6b5c093a17df9539eeb11323ebc13d87fa766221efaed0e1d |

The two `EXT_structural_metadata` folders come from `glTF/EXT_structural_metadata` of the same commit, CC0 1.0 as their
READMEs state; the tests check them against the property values those READMEs list.

| Folder | Files (sha256 as downloaded) |
| --- | --- |
| `EXT_structural_metadata/ComplexTypes` | `ComplexTypes.gltf` d14a7239aa187563148db8f1cdda94c2f132530dd96b977605938c3b5562976f, `tileset.json` 00e217a459bc742118d20c81750d001f63549dc8cfd15b8422b08dc4e69a1ae5 |
| `EXT_structural_metadata/FeatureIdAttributeAndPropertyTable` | `FeatureIdAttributeAndPropertyTable.gltf` f5e93a9b9be7ca41e62ce270c17d9ec0685f2952e8027405fd4898f886aa1f38, `tileset.json` 736d9f1ef77c18ab17be0ee94a720278edc15018d3cdb9f90a30b7cfae58825c |

Only the `city` sub-tileset of TilesetWithRequestVolume is kept; its building model (by Richard Edwards) and point cloud
are left out for their size.

Additional CC0 1.0 standard samples, byte for byte from the same pinned source commit a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56, downloaded 2026-11-10. Source folders: https://github.com/CesiumGS/3d-tiles-samples/tree/a30bfdf2d6cc55f4c3078e8aea3a793af6ebfd56/glTF/EXT_structural_metadata/PropertyAttributesPointCloud and the adjacent SimplePropertyTexture. Each source sample's README states CC0. No source code or README file is copied.

| Folder | Files (sha256 as downloaded) |
| --- | --- |
| EXT_structural_metadata/PropertyAttributesPointCloud | PropertyAttributesPointCloudTree.bin 83307690b7406d2758006e246e9d44c02fe5fadec6c50551bcbcde64bbfb7a07; PropertyAttributesPointCloudTree.gltf a459285737e3fd48f6726d51879a5ab2b384bcd95a0f57e84dcea90bfe180603; MetadataSchema.json 43fd8b5c9633237819c335044fd5bf1d5b7335002d25b50a07d882df61be84f1 |
| EXT_structural_metadata/SimplePropertyTexture | SimplePropertyTexture.gltf a2a282a39f62378d306d805235a1ef955277d4fc01fec60fbb8bd3fe38b41d26 |
