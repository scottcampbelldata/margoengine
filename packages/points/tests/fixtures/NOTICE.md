# Test fixtures

Fixtures are used only by the tests and are not part of the published package (`files` is `dist`).

- `bunny.pcd` is `test/bunny.pcd` from the Point Cloud Library, https://github.com/PointCloudLibrary/pcl
  (BSD-3-Clause; Copyright (c) 2009-2012 Willow Garage, Inc., Copyright (c) 2012- Open Perception, Inc.; licence text
  at https://github.com/PointCloudLibrary/pcl/blob/master/LICENSE.txt), a subsampled scan of the Stanford bunny
  (Stanford Computer Graphics Laboratory, Stanford 3D Scanning Repository). It is committed here, not downloaded by
  the tests.
- `USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz` is a U.S. Geological Survey 3D Elevation Program lidar point cloud
  tile (project MT_Statewide_Phase3_2021_B21, LAS 1.4, point format 6, 54,634 points). Source:
  https://rockyweb.usgs.gov/vdelivery/Datasets/Staged/Elevation/LPC/Projects/MT_Statewide_Phase3_2021_B21/MT_Statewide_P3_4_B21/LAZ/USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz
  (found through the USGS National Map products API). Size 609,938 bytes, SHA-256
  `c2804c3827fd6104acf657803f55ed4e5fa9ba83b4ec481888510385a14e31ae`, downloaded 2026-10-27. Licence: public domain;
  USGS states that all 3DEP products are available free of charge and without use restrictions
  (https://www.usgs.gov/3d-elevation-program/about-3dep-products-services, data labelled Public Domain). It is
  committed here, not downloaded by the tests.
- `laz/` holds real LAS and LAZ samples for `tests/laz-real.test.js`, committed here, not downloaded by the tests:
  - `point10`, `point-time`, `point-color` and `point-time-color` (`.laz` and `.las`), `extra-bytes.laz` and
    `point-version-1-point-wise.laz` are copies from `tests/data` of https://github.com/laz-rs/laz-rs (Apache-2.0,
    Copyright 2023 Thomas Montaigu).
  - `simple.copc.laz`, `append-bug.laz`, `fullwave.laz` and `simple1_3.las` are copies from `tests/data` of
    https://github.com/laspy/laspy (BSD-2-Clause; Copyright (c) 2012 Grant Brown, Copyright (c) 2012 Howard Butler,
    Copyright (c) 2020 Thomas Montaigu; licence text in that repository's `LICENSE.txt`).
  - `laszip-format4.laz` is `simple1_3.las` compressed by LASzip. `laszip-format5.laz`, `laszip-format9.laz` and
    `laszip-channels-format7.laz` to `format10.laz` hold the first 2,000 points of `fullwave.laz` compressed by LASzip,
    with scanner channels and wave packet offsets randomised (seed 2026) in the channels files, so that LASzip's
    switching is exercised. No public file of those formats was found.
  - `records.json` holds the SHA-256 digests of what LASzip and lazrs decode from each file. Made once outside the
    repository, through laspy; no code of those projects is here.
