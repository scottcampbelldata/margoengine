"""Our tetra, written by the Exodus II library through its documented public C API."""
import ctypes as C
import os
from pathlib import Path
p = Path('test-results/batch176/python/vtk.libs').resolve()
os.add_dll_directory(str(p))
lib = C.CDLL(str(p / 'vtkexodusII-9.7.2.dll'))
def fn(name, args):
    f = getattr(lib, 'vtkexodusII_' + name)
    f.argtypes = args; f.restype = C.c_int
    return f
I, L, P, S = C.c_int, C.c_int64, C.c_void_p, C.c_char_p
create = fn('ex_create_int', [S,I,P,P,I])
init = fn('ex_put_init', [I,S,L,L,L,L,L,L])
coord = fn('ex_put_coord', [I,P,P,P])
block = fn('ex_put_block', [I,I,L,S,L,L,L,L,L])
conn = fn('ex_put_conn', [I,I,L,P,P,P])
close = fn('ex_close', [I])
param = fn('ex_put_variable_param', [I,I,I])
name = fn('ex_put_variable_name', [I,I,I,S])
var = fn('ex_put_var', [I,I,I,I,L,L,P])
time = fn('ex_put_time', [I,I,P])
def ok(n):
    if n < 0: raise RuntimeError('Exodus returned ' + str(n))
for mode, suffix in [(8, 'classic')]:
    ws, io = I(8), I(8)
    path = str(Path('packages/sciviz/tests/fixtures/engineering') / f'exodus-{suffix}.exo').encode()
    f = create(path, mode, C.byref(ws), C.byref(io), 904); ok(f)
    ok(init(f,b'Clean-room tetra',3,4,1,1,0,0))
    ok(coord(f,(C.c_double*4)(0,1,0,0),(C.c_double*4)(0,0,1,0),(C.c_double*4)(0,0,0,1)))
    ok(block(f,1,100,b'TETRA4',1,4,0,0,0))
    ok(conn(f,1,100,(I*4)(1,2,3,4),None,None))
    for kind, label in [(14,b'temperature'),(1,b'stress')]:
        ok(param(f,kind,1)); ok(name(f,kind,1,label))
    for step in [1,2]:
        ok(time(f,step,C.byref(C.c_double(step-1))))
        ok(var(f,step,14,1,1,4,(C.c_double*4)(*[step*x for x in [10,20,30,40]])))
        ok(var(f,step,1,1,100,1,C.byref(C.c_double(7*step))))
    ok(close(f)); print(path, flush=True)
