"""Value clips through OpenUSD public APIs, using original analytical layers."""
from pxr import Usd
import json, pathlib, sys, re
folder=pathlib.Path(sys.argv[1]);folder.mkdir(parents=True,exist_ok=True)
mesh='int[] faceVertexCounts=[3]\nint[] faceVertexIndices=[0,1,2]\npoint3f[] points\ndouble value\n'
def write(name,text):
 text=re.sub(r' (?=(?:upAxis|metersPerUnit|subLayers|clips|clipSets)=|(?:asset|double2|double|int|point3f|string|bool|dictionary)(?:\[\])?\s)', '\n', text)
 (folder/name).write_text('#usda 1.0\n'+text.replace('}', '\n}'))
def points(x): return f'[({x},0,0),({x+1},0,0),({x},1,0)]'
write('a.usda','def Mesh "Geometry" {point3f[] points.timeSamples={0:'+points(0)+',5:'+points(5)+',15:'+points(15)+'} double value.timeSamples={0:0,5:5,15:15} double ignored=888 }')
write('b.usda','def Mesh "Geometry" {point3f[] points.timeSamples={6:'+points(16)+',11:'+points(21)+'} double value.timeSamples={6:16,11:21} double ignored=999 }')
write('manifest.usda','over "Geometry" {point3f[] points double value}')
clip='dictionary default={asset[] assetPaths=[@a.usda@,@b.usda@] asset manifestAssetPath=@manifest.usda@ string primPath="/Geometry" double2[] active=[(0,0),(10,1)]}'
write('explicit.usda','(metersPerUnit=1 upAxis="Y")\ndef Mesh "Cache" (clips={'+clip+'}) {'+mesh+'}')
write('local.usda','(metersPerUnit=1 upAxis="Y")\ndef Mesh "Cache" (clips={'+clip+'}) {'+mesh+'double value=77}')
write('weak.usda','over "Cache" {double value=77}')
write('weak-root.usda','(subLayers=[@weak.usda@] metersPerUnit=1 upAxis="Y")\ndef Mesh "Cache" (clips={'+clip+'}) {'+mesh+'}')
write('retime.usda','(metersPerUnit=1 upAxis="Y")\ndef Mesh "Cache" (clips={'+clip.replace('double2[] active=','double2[] times=[(0,0),(5,5),(5,10),(10,0)] double2[] active=').replace('[(0,0),(10,1)]','[(0,0)]')+'}) {'+mesh+'}')
write('empty.usda','over "Geometry" {double value=999}')
write('manifest-gap.usda','over "Geometry" {double value=10}')
write('manifest-gap-linear.usda','over "Geometry" {double value}')
for mode in ['gap','gap-linear']:
 conf='dictionary default={asset[] assetPaths=[@a.usda@,@empty.usda@,@b.usda@] asset manifestAssetPath=@manifest-'+mode+'.usda@ string primPath="/Geometry" double2[] active=[(0,0),(5,1),(10,2)] '+('bool interpolateMissingClipValues=true' if mode.endswith('linear') else '')+'}'
 write(mode+'.usda','def Xform "Cache" (clips={'+conf+'}) {double value}')
for n in [1,2,3]:write('clip.'+str(n).zfill(3)+'.usda','over "Geometry" {double value.timeSamples={'+str(n)+':'+str(n*10)+'}}')
write('template.usda','def Xform "Cache" (clips={dictionary default={string templateAssetPath="clip.###.usda" double templateStartTime=1 double templateEndTime=3 double templateStride=1 double templateActiveOffset=0.5 string primPath="/Geometry"}}) {double value}')
write('offset.usda','(subLayers=[@explicit.usda@(offset=100;scale=2)] metersPerUnit=1 upAxis="Y")')
write('sets.usda','def Xform "Cache" (clips={dictionary A={asset[] assetPaths=[@a.usda@] asset manifestAssetPath=@manifest-gap-linear.usda@ string primPath="/Geometry" double2[] active=[(0,0)]} dictionary B={asset[] assetPaths=[@b.usda@] asset manifestAssetPath=@manifest-gap-linear.usda@ string primPath="/Geometry" double2[] active=[(0,0)]}} clipSets=["B","A"]) {double value}')
write('gap-a.usda','over "Geometry" {double value.timeSamples={0:0,2:2,15:15}}')
for mode in ['gap','gap-linear']:
 p=folder/(mode+'.usda');p.write_text(p.read_text().replace('@a.usda@','@gap-a.usda@'))
(folder/'parts').mkdir(exist_ok=True)
write('parts/ref.usda','def Mesh "Cache" (clips={'+clip.replace('@a.usda@','@../a.usda@').replace('@b.usda@','@../b.usda@').replace('@manifest.usda@','@../manifest.usda@')+'}) {'+mesh+'}')
write('reference.usda','def Xform "World" (references=@parts/ref.usda@</Cache>) {}')
for n in [1.25,1.5,1.75]:write('sub.'+format(n,'06.2f')+'.usda','over "Geometry" {double value.timeSamples={'+str(n)+':'+str(n*10)+'}}')
write('fractional.usda','def Xform "Cache" (clips={dictionary default={string templateAssetPath="sub.###.##.usda" double templateStartTime=1.25 double templateEndTime=1.75 double templateStride=0.25 string primPath="/Geometry"}}) {double value}')
write('template-hole.usda','def Xform "Cache" (clips={dictionary default={string templateAssetPath="hole.###.usda" double templateStartTime=1 double templateEndTime=3 double templateStride=1 string primPath="/Geometry"}}) {double value}')
for n in [1,3]:write('hole.'+str(n).zfill(3)+'.usda','over "Geometry" {double value.timeSamples={'+str(n)+':'+str(n*10)+'}}')
write('topology.usda','(metersPerUnit=1 upAxis="Y")\ndef Mesh "Cache" (clips={dictionary default={asset[] assetPaths=[@topology-a.usda@,@topology-b.usda@] asset manifestAssetPath=@topology-manifest.usda@ string primPath="/Geometry" double2[] active=[(0,0),(1,1)]}}) {int[] faceVertexCounts\nint[] faceVertexIndices\npoint3f[] points}')
write('topology-manifest.usda','over "Geometry" {int[] faceVertexCounts\nint[] faceVertexIndices\npoint3f[] points}')
write('topology-a.usda','over "Geometry" {int[] faceVertexCounts.timeSamples={0:[3]} int[] faceVertexIndices.timeSamples={0:[0,1,2]} point3f[] points.timeSamples={0:[(-1,-1,0),(1,-1,0),(0,1,0)]}}')
write('topology-b.usda','over "Geometry" {int[] faceVertexCounts.timeSamples={1:[4]} int[] faceVertexIndices.timeSamples={1:[0,1,2,3]} point3f[] points.timeSamples={1:[(-1,-1,0),(1,-1,0),(1,1,0),(-1,1,0)]}}')
topo=Usd.Stage.Open(str(folder/'topology.usda'))
json.dump({str(t):list(topo.GetPrimAtPath('/Cache').GetAttribute('faceVertexCounts').Get(t)) for t in [0,0.5,1,2]},open(folder/'topology-openusd.json','w'),indent=2)
write('template-integer-start.usda','def Xform \"Cache\" (clips={dictionary default={string templateAssetPath=\"clip.###.usda\" double templateStartTime=1.9 double templateEndTime=3.9 double templateStride=1 string primPath=\"/Geometry\"}}) {double value}')
truth={}
for name,times in {'explicit':[0,2,5,8,10,12,20],'local':[0,8,12],'weak-root':[0,8,12],'retime':[-1,0,2,4.999,5,6,9,12],'gap':[0,2,5,7.5,10,12],'gap-linear':[0,2,5,7.5,10,12],'template':[0,1,1.5,2,2.5,3,3.5,4],'offset':[100,104,110,116,120,124,140],'sets':[0,6,8,12],'reference':[0,2,8,12],'fractional':[1,1.25,1.375,1.5,1.75,2],'template-hole':[0,1,1.5,2,2.5,3,4],'template-integer-start':[0,1,1.9,2,2.5,2.9,3,3.9,4]}.items():
 s=Usd.Stage.Open(str(folder/(name+'.usda')))
 prim=s.GetPrimAtPath('/World' if name=='reference' else '/Cache');attribute=prim.GetAttribute('value')
 truth[name]={str(t):attribute.Get(t) for t in times}
json.dump(truth,open(folder/'openusd.json','w'),indent=2)
