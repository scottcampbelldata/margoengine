# Test fixtures

Fixtures are used only by the tests and are not part of the published package (`files` is `dist`).

- `capsule-golden.json` is Margo's own.
- `panda/` is the Franka Emika Panda description from example-robot-data, Apache-2.0, unchanged. Source: https://github.com/Gepetto/example-robot-data, commit `6249cab1cdffa4fadb9a53dda964a50d79c5eaaf`, folder `robots/panda_description`: `urdf/panda.urdf`, `urdf/panda_collision.urdf`, `meshes/collision/*.stl`, `README.md` and `LICENSE`. That folder's README names its upstream, https://github.com/frankaemika/franka_ros/tree/noetic-devel/franka_description. Each file's git blob hash matches that commit's tree. The licence text is `panda/LICENSE`.
