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
