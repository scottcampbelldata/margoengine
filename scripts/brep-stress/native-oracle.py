"""Reference-only OpenCascade API calls. No OpenCascade implementation is copied or shipped."""
import json
import sys
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader

reader = STEPControl_Reader()
status = reader.ReadFile(sys.argv[1])
if status != IFSelect_RetDone:
    print(json.dumps({"read": False, "valid": False, "error": str(status)}))
    sys.exit(0)
reader.TransferRoots()
shape = reader.OneShape()
default = GProp_GProps()
adaptive = GProp_GProps()
BRepGProp.VolumeProperties_s(shape, default)
error = BRepGProp.VolumeProperties_s(shape, adaptive, 1e-10)
# STEPControl_Reader uses millimetres internally; the Margo API uses metres.
print(json.dumps({"read": True, "valid": BRepCheck_Analyzer(shape).IsValid(),
                  "volume": adaptive.Mass() / 1e9, "defaultVolume": default.Mass() / 1e9,
                  "integrationError": error}))
