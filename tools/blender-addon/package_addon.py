"""Create the installable add-on without dependencies or generated Python caches."""
from pathlib import Path
import tomllib
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
manifest = tomllib.loads((root / "blender_manifest.toml").read_text(encoding="utf-8"))


def package(destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        for name in ("blender_manifest.toml", "__init__.py", "exporter.py", "writer.py"):
            archive.write(root / name, manifest["id"] + "/" + name)
        archive.write(root.parents[1] / "LICENSE", manifest["id"] + "/LICENSE")


if __name__ == "__main__":
    destination = root.parents[1] / "dist" / f"margo-blender-addon-v{manifest['version']}.zip"
    package(destination)
    print(destination)
