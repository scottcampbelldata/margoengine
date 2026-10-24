"""Reference-only native OpenCascade calls; no OCCT implementation is copied."""
import json
import sys
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS


operation, radius = sys.argv[1], float(sys.argv[2])
# Native units are mm, matching Margo's [0.01, 0.012, 0.015] metre box.
# Margo box.edges[0] runs between these endpoints, selected geometrically here.
target = sorted([(0.0, 0.0, 0.0), (0.0, 12.0, 0.0)])
result = {"operation": operation, "radiusMm": radius, "endpointsMm": target}
try:
    shape = BRepPrimAPI_MakeBox(10.0, 12.0, 15.0).Shape()
    explorer = TopExp_Explorer(shape, TopAbs_EDGE)
    selected = None
    while explorer.More():
        cast_edge = getattr(TopoDS, "Edge_s", None) or getattr(TopoDS, "Edge")
        edge = cast_edge(explorer.Current())
        curve = BRepAdaptor_Curve(edge)
        endpoints = []
        for parameter in [curve.FirstParameter(), curve.LastParameter()]:
            p = curve.Value(parameter)
            endpoints.append(tuple(round(v, 9) for v in [p.X(), p.Y(), p.Z()]))
        if sorted(endpoints) == target:
            selected = edge
            break
        explorer.Next()
    if selected is None:
        raise ValueError("No OCCT edge matches the Margo edge endpoints")
    maker = (BRepFilletAPI_MakeFillet if operation == "fillet" else BRepFilletAPI_MakeChamfer)(shape)
    maker.Add(radius, selected)
    maker.Build()
    result["done"] = maker.IsDone()
    if result["done"]:
        output = maker.Shape()
        result["valid"] = BRepCheck_Analyzer(output).IsValid()
        props = GProp_GProps()
        result["integrationError"] = BRepGProp.VolumeProperties_s(output, props, 1e-10)
        result["volume"] = props.Mass() / 1e9
        faces = TopExp_Explorer(output, TopAbs_FACE)
        count = 0
        while faces.More():
            count += 1
            faces.Next()
        result["faces"] = count
except Exception as error:
    result["error"] = {"name": type(error).__name__, "message": str(error)}
print(json.dumps(result))
