# Reference generated with Blender 5.3.0 Beta ecaf39c37b28, using its public evaluated Geometry Nodes API.
# Run with Blender --background --factory-startup --python <this file>; PINGPONG_REFERENCE is the fixture array.
import bpy, json
mesh=bpy.data.meshes.new('reference');mesh.from_pydata([(0,0,0)],[],[])
obj=bpy.data.objects.new('reference',mesh);bpy.context.collection.objects.link(obj)
g=bpy.data.node_groups.new('PingPong reference','GeometryNodeTree')
g.interface.new_socket(name='Geometry',in_out='INPUT',socket_type='NodeSocketGeometry')
g.interface.new_socket(name='Geometry',in_out='OUTPUT',socket_type='NodeSocketGeometry')
i=g.nodes.new('NodeGroupInput');o=g.nodes.new('NodeGroupOutput');store=g.nodes.new('GeometryNodeStoreNamedAttribute');store.data_type='FLOAT';store.domain='POINT';store.inputs['Name'].default_value='ping'
math=g.nodes.new('ShaderNodeMath');math.operation='PINGPONG'
g.links.new(i.outputs['Geometry'],store.inputs['Geometry']);g.links.new(math.outputs[0],store.inputs['Value']);g.links.new(store.outputs['Geometry'],o.inputs['Geometry'])
obj.modifiers.new('reference','NODES').node_group=g
out=[]
for b in [0,.5,1,2,8,-1,-2]:
 for a in [-32,-24,-16,-12,-8,-4,-2,-1,-.5,0,.25,.5,1,2,4,8,12,16,24,32]:
  math.inputs[0].default_value=a;math.inputs[1].default_value=b
  bpy.context.view_layer.update();ev=obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
  out.append([a,b,ev.data.attributes['ping'].data[0].value])
print('PINGPONG_REFERENCE',json.dumps(out))
