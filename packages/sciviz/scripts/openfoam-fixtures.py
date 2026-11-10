"""Write a small case with the actual OpenFOAM blockMesh and foamFormatConvert executables."""
import os, subprocess, shutil
from pathlib import Path
root=Path('test-results/batch176/engineering').resolve()
foam=root/'bluecfd/app/OpenFOAM-12'
platform=foam/'platforms/mingw_w64Gcc122DPInt32Opt'
env=dict(os.environ)
env.update(WM_PROJECT_DIR=str(foam), WM_PROJECT='OpenFOAM', WM_PROJECT_VERSION='12', FOAM_ETC=str(foam/'etc'), WM_OPTIONS='mingw_w64Gcc122DPInt32Opt')
env['PATH']=os.pathsep.join([str(platform/'bin'),str(platform/'lib'),str(platform/'lib/dummy'),str(root/'bluecfd/app/ThirdParty-12/platforms/mingw_w64Gcc122DPInt32/lib'),str(root/'bluecfd/app/msys64/mingw64/bin'),env['PATH']])
case=root/'foam-case'
for name in ['system','constant','0']: (case/name).mkdir(parents=True,exist_ok=True)
def header(cls,obj): return 'FoamFile { version 2.0; format ascii; class '+cls+'; object '+obj+'; }\n'
control=header('dictionary','controlDict')+'application foamRun; startFrom startTime; startTime 0; stopAt endTime; endTime 1; deltaT 1; writeControl timeStep; writeInterval 1; purgeWrite 0; writePrecision 16; writeCompression off; timeFormat general; timePrecision 6; runTimeModifiable false; writeFormat '
(case/'system/controlDict').write_text(control+'ascii;\n')
(case/'system/blockMeshDict').write_text(header('dictionary','blockMeshDict')+'''scale 1;
vertices ((0 0 0)(1 0 0)(1 1 0)(0 1 0)(0 0 1)(1 0 1)(1 1 1)(0 1 1));
blocks (hex (0 1 2 3 4 5 6 7) (2 2 2) simpleGrading (1 1 1));
edges ();
boundary (walls { type wall; faces ((0 4 7 3)(1 2 6 5)(0 1 5 4)(3 7 6 2)(0 3 2 1)(4 5 6 7)); });
mergePatchPairs ();
''')
for name,cls,typ,width,values in [('p','volScalarField','scalar',1,[1,2,3,4,5,6,7,8]),('U','volVectorField','vector',3,[(1,2,3)]*8)]:
    fmt=lambda v: str(v) if width==1 else '('+' '.join(map(str,v))+')'
    (case/'0'/name).write_text(header(cls,name)+'dimensions [0 0 0 0 0 0 0];\ninternalField nonuniform List<'+typ+'>\n8\n(\n'+'\n'.join(fmt(v) for v in values)+'\n);\nboundaryField { walls { type fixedValue; value uniform '+fmt(9 if width==1 else (4,5,6))+'; } }\n')
def run(name,args):
    with (root/(name+'.log')).open('wb') as log:
        p=subprocess.run([str(platform/'bin'/(name+'.exe')),*args],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=90,creationflags=subprocess.CREATE_NO_WINDOW)
    print(name,p.returncode,flush=True)
    if p.returncode: raise RuntimeError((root/(name+'.log')).read_text())
run('blockMesh',['-case',str(case)])
out=Path('packages/sciviz/tests/fixtures/engineering')
def copy(suffix):
    dest=out/('foam-owner-'+suffix)
    for src in [case/'constant/polyMesh',case/'0']:
        target=dest/src.relative_to(case); target.mkdir(parents=True,exist_ok=True)
        for p in src.iterdir():
            if p.is_file() and p.name in ['points','faces','owner','neighbour','boundary','p','U']: shutil.copyfile(p,target/p.name)
copy('ascii')
(case/'system/controlDict').write_text(control+'binary;\n')
run('foamFormatConvert',['-case',str(case),'-constant','-time','0'])
copy('binary')
