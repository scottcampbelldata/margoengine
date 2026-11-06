# Draco point cloud fixtures

- `cube_pc.drc`, `pc_color.drc`, `pc_kd_color.drc`, `point_cloud_no_qp.drc`: real files from `testdata/` of google/draco, Apache-2.0
  (https://github.com/google/draco).
- `survey.drc`, `wide.drc`: written by Draco's own encoder (draco3d 1.5.7, Apache-2.0, run outside this repository) from
  `tests/generate-points-fixture.mjs`, because no public file has generic attributes with name metadata.

`records.json` holds what this package decoded from the real files, so a change shows. Their point counts and attribute types were
compared with draco3d's own decoder, outside this repository.
