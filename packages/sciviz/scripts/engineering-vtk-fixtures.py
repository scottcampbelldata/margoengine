"""Run the externally installed Xdmf library's writer through its public VTK wrapper."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path('test-results/batch176/python').resolve()))
import vtk
out = Path('packages/sciviz/tests/fixtures/engineering').resolve()
grid = vtk.vtkUnstructuredGrid()
points = vtk.vtkPoints()
for p in [(0,0,0), (1,0,0), (0,1,0), (0,0,1)]:
    points.InsertNextPoint(*p)
grid.SetPoints(points)
ids = vtk.vtkIdList()
for i in range(4): ids.InsertNextId(i)
grid.InsertNextCell(vtk.VTK_TETRA, ids)
for name, association, values, width in [('temperature', grid.GetPointData(), [10,20,30,40], 1), ('velocity', grid.GetPointData(), [1,2,3]*4, 3), ('stress', grid.GetCellData(), [7], 1)]:
    a = vtk.vtkDoubleArray(); a.SetName(name); a.SetNumberOfComponents(width)
    for i in range(0, len(values), width): a.InsertNextTuple(values[i:i+width])
    association.AddArray(a)
for cls, name in [(vtk.vtkXdmfWriter, 'owner.xmf')]:
    w = cls(); w.SetInputData(grid); w.SetFileName(str(out/name))
    if cls == vtk.vtkXdmfWriter: w.SetLightDataLimit(0)
    print(name, w.Write())
