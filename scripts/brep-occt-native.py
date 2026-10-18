# Native (C++) OpenCascade on the CAD corpus, as the desktop speed reference for @margoengine/brep. Reads each STEP
# entry of test-results/cad-corpus/manifest.json with STEPControl_Reader and meshes it with BRepMesh_IncrementalMesh at
# a deflection of 0.001 of the model's bounding-box diagonal and 0.5 rad, once on one thread and once in parallel, and
# writes times and triangle counts as JSON. OpenCascade is only measured here; it never ships in Margo.
#   python -m venv .occt && .occt/Scripts/python -m pip install cadquery-ocp   (Python 3.12; any OCP build)
#   .occt/Scripts/python scripts/brep-occt-native.py [--json=test-results/brep-occt-native.json] [--only=<name part>]
import json
import sys
import time

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepTools import BRepTools
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.TopoDS import TopoDS


def arg(name):
    for a in sys.argv[1:]:
        if a.startswith(f"--{name}="):
            return a[len(name) + 3 :]
    return None


def read(path):
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise RuntimeError("STEPControl_Reader could not read the file")
    reader.TransferRoots()
    return reader.OneShape()


def triangles(shape):
    count, faces = 0, 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        mesh = BRep_Tool.Triangulation_s(face, TopLoc_Location())
        faces += 1
        if mesh is not None:
            count += mesh.NbTriangles()
        explorer.Next()
    return count, faces


def main():
    only = arg("only")
    manifest = json.load(open("test-results/cad-corpus/manifest.json", encoding="utf8"))
    rows = []
    for entry in manifest:
        if entry.get("format") != "step" or (only and only not in entry["file"]):
            continue
        path = f"test-results/cad-corpus/{entry['file']}"
        row = {"file": entry["file"]}
        try:
            start = time.perf_counter()
            shape = read(path)
            row["readMs"] = round((time.perf_counter() - start) * 1000, 1)
            box = Bnd_Box()
            BRepBndLib.Add_s(shape, box)
            low, high = box.CornerMin(), box.CornerMax()
            deflection = 0.001 * low.Distance(high)
            for parallel in (False, True):
                BRepTools.Clean_s(shape)
                start = time.perf_counter()
                BRepMesh_IncrementalMesh(shape, deflection, False, 0.5, parallel)
                key = "meshParallelMs" if parallel else "meshMs"
                row[key] = round((time.perf_counter() - start) * 1000, 1)
            row["triangles"], row["faces"] = triangles(shape)
        except Exception as error:  # a file OpenCascade cannot read or mesh is reported, not fatal
            row["error"] = str(error)
        rows.append(row)
        print(
            f"{entry['file']:<48} "
            + (
                f"FAILED {row['error']}"
                if "error" in row
                else f"read {row['readMs']} ms, mesh {row['meshMs']} ms (parallel {row['meshParallelMs']} ms), "
                f"{row['faces']} faces, {row['triangles']} triangles"
            ),
            flush=True,
        )
    out = arg("json")
    if out:
        json.dump(rows, open(out, "w", encoding="utf8"), indent=2)


main()
