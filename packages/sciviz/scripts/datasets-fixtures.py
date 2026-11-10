# Clean-room fixture generation through VTK public runtime APIs only. Run from repository root.
# Requires the external VTK 9.7.2 and NumPy tools; no engine source is read.
import sys,json,os

import vtk
out={'writer':'VTK '+vtk.vtkVersion.GetVTKVersion(),'nodes':{},'quadratic':{}}
for shape,cls in [('curve',vtk.vtkLagrangeCurve),('triangle',vtk.vtkLagrangeTriangle),('quad',vtk.vtkLagrangeQuadrilateral),('tetra',vtk.vtkLagrangeTetra),('hex',vtk.vtkLagrangeHexahedron),('wedge',vtk.vtkLagrangeWedge)]:
 out['nodes'][shape]={}
 for p in range(1,7):
  n={'curve':p+1,'triangle':(p+1)*(p+2)//2,'quad':(p+1)**2,'tetra':(p+1)*(p+2)*(p+3)//6,'hex':(p+1)**3,'wedge':(p+1)**2*(p+2)//2}[shape]
  c=cls();c.GetPointIds().SetNumberOfIds(n);c.GetPoints().SetNumberOfPoints(n);c.Initialize()
  if shape=='quad': c.SetOrder(p,p)
  if shape=='hex': c.SetOrder(p,p,p)
  if shape=='wedge': c.SetOrder(p,p,p,n)
  coords=c.GetParametricCoords();nodes=[list(coords[3*i:3*i+3]) for i in range(n)];samples=[]
  for at in [[.13,.21,.17],[.3,.1,.2]]:
   if shape=='curve':at=[at[0],0,0]
   if shape in ['triangle','quad']:at=[at[0],at[1],0]
   w=[0.]*n;c.InterpolateFunctions(at,w);samples.append({'at':at,'weights':w})
  out['nodes'][shape][p]={'nodes':nodes,'samples':samples}
for shape,cls in [('curve',vtk.vtkQuadraticEdge),('triangle',vtk.vtkQuadraticTriangle),('quad',vtk.vtkQuadraticQuad),('tetra',vtk.vtkQuadraticTetra),('hex',vtk.vtkQuadraticHexahedron),('wedge',vtk.vtkQuadraticWedge),('pyramid',vtk.vtkQuadraticPyramid)]:
 c=cls();n=c.GetNumberOfPoints();coords=c.GetParametricCoords();nodes=[list(coords[3*i:3*i+3]) for i in range(n)];samples=[]
 for at in [[.3,.2,.1],[.4,.3,.3]]:
  if shape=='curve':at=[at[0],0,0]
  if shape in ['triangle','quad']:at=[at[0],at[1],0]
  w=[0.]*n;c.InterpolateFunctions(at,w);samples.append({'at':at,'weights':w})
 out['quadratic'][shape]={'nodes':nodes,'samples':samples}
os.makedirs('packages/sciviz/tests/fixtures/datasets',exist_ok=True)
json.dump(out,open('packages/sciviz/tests/fixtures/datasets/vtk-oracle.json','w'),separators=(',',':'))

import sys,os,json,hashlib

import vtk,numpy as np
from vtk.util.numpy_support import numpy_to_vtk
root='examples/assets/sciviz/datasets'
a=np.fromstring(open(root+'/flatplate_clust2_4levelsdown_35x25.p2dfmt').read(),sep=' ')
nx,ny=map(int,a[1:3]);n=nx*ny;x=a[3:3+n].reshape(ny,nx);y=a[3+n:].reshape(ny,nx)
print('rectilinear error',np.max(abs(x-x[0,:])),np.max(abs(y-y[:,0,None])))
# Coordinate-line projection for the VTR view only; exact VTS retains all original coordinates.
r=vtk.vtkRectilinearGrid();r.SetDimensions(nx,ny,1);r.SetXCoordinates(numpy_to_vtk(x[0,:].copy(),deep=True));r.SetYCoordinates(numpy_to_vtk(y[:,0].copy(),deep=True));r.SetZCoordinates(numpy_to_vtk(np.array([0.]),deep=True));f=numpy_to_vtk(x.ravel().copy(),deep=True);f.SetName('x');r.GetPointData().AddArray(f)
w=vtk.vtkXMLRectilinearGridWriter();w.SetFileName(root+'/flatplate.vtr');w.SetInputData(r);w.SetDataModeToAppended();w.SetCompressorTypeToZLib();w.Write()
s=vtk.vtkStructuredGrid();s.SetDimensions(nx,ny,1);p=vtk.vtkPoints();p.SetData(numpy_to_vtk(np.column_stack([x.ravel(),y.ravel(),np.zeros(n)]),deep=True));s.SetPoints(p);s.GetPointData().AddArray(f)
w=vtk.vtkXMLStructuredGridWriter();w.SetFileName(root+'/flatplate.vts');w.SetInputData(s);w.SetDataModeToBinary();w.SetCompressorTypeToZLib();w.Write()
m=vtk.vtkMultiBlockDataSet();m.SetNumberOfBlocks(2);m.SetBlock(0,r);m.SetBlock(1,s);m.GetMetaData(0).Set(vtk.vtkCompositeDataSet.NAME(),'rectilinear');m.GetMetaData(1).Set(vtk.vtkCompositeDataSet.NAME(),'structured')
w=vtk.vtkXMLMultiBlockDataWriter();w.SetFileName(root+'/flatplate.vtm');w.SetInputData(m);w.SetDataModeToAppended();w.Write()
print('wrote VTR VTS VTM with',vtk.vtkVersion.GetVTKVersion())


