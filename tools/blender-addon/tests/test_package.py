import ast
import importlib.util
from pathlib import Path
import tempfile
import tomllib
import unittest
from zipfile import ZipFile

root = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("package_addon", root / "package_addon.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageTests(unittest.TestCase):
    def test_installable_archive_contains_only_runtime_license_and_notice(self):
        with tempfile.TemporaryDirectory() as folder:
            destination = Path(folder) / "addon.zip"
            packager.package(destination)
            with ZipFile(destination) as archive:
                prefix = packager.manifest["id"] + "/"
                self.assertEqual(set(archive.namelist()), {prefix + name for name in (
                    "blender_manifest.toml", "__init__.py", "exporter.py", "animation.py", "objects.py", "lightmaps.py", "bake.py", "curves.py", "live.py", "writer.py", "LICENSE", "NOTICE")})
                # Every module the add-on imports ships (curves.py was once left out, so Blender failed to enable it).
                modules = {path.name for path in root.glob("*.py")} - {"package_addon.py"}
                self.assertLessEqual({prefix + name for name in modules}, set(archive.namelist()))
                self.assertIsNone(archive.testzip())
                manifest = tomllib.loads(archive.read(prefix + "blender_manifest.toml").decode())
                tree = ast.parse(archive.read(prefix + "__init__.py"))
                legacy = ast.literal_eval(tree.body[0].value)
                self.assertEqual(tuple(map(int, manifest["version"].split("."))), legacy["version"])
                self.assertEqual(tuple(map(int, manifest["blender_version_min"].split("."))), legacy["blender"])
                self.assertEqual(manifest["name"], legacy["name"])
                self.assertLessEqual(len(manifest["tagline"]), 64)
                # The live link listens on a local port, which Blender's extension rules count as network use.
                self.assertIn("network", manifest["permissions"])
                for name in ("LICENSE", "NOTICE"):
                    self.assertEqual(archive.read(prefix + name), (root.parents[1] / name).read_bytes())
                for name in sorted(modules):
                    compile(archive.read(prefix + name), name, "exec")


if __name__ == "__main__":
    unittest.main()
