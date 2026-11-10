"""Run the shipped notebook and preserve its real binary comm payloads for browser tests."""
import json
import os
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "python"))
os.environ["MARGO_REPO"] = str(root)
scope = {}
for cell in json.loads((root / "examples/notebooks/sciviz-portable.ipynb").read_text())["cells"]:
    if cell["cell_type"] == "code":
        exec(compile("".join(cell["source"]), "sciviz-portable.ipynb", "exec"), scope)
folder = root / "test-results/sciviz-notebook"
folder.mkdir(parents=True, exist_ok=True)
for name in ("mri", "exo"):
    widget = scope[name]
    buffers = {}
    for key, data in widget.buffers.items():
        path = folder / f"{name}-{key}.bin"
        path.write_bytes(data)
        buffers[key] = f"/test-results/sciviz-notebook/{path.name}"
    (folder / f"{name}.json").write_text(json.dumps({"spec": widget.spec, "buffers": buffers, "height": 360}), encoding="utf-8")
    widget.save_html(folder / f"{name}.html")
    widget.close()
print("Shipped notebook executed: OpenNeuro T1 and NASA Exoplanet Arrow table")
