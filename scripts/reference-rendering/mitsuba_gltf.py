"""Shared glTF loader for the Mitsuba references (public Mitsuba APIs, standard glTF bytes, no renderer source).

Loads every triangle primitive of the default scene with world transforms, vertex normals and the glTF
metal/rough factors mapped to Mitsuba principled. With material_attributes, each mesh also carries its glTF
factors as vertex attributes (base colour, and metallic, roughness, 0) for integrators that evaluate them directly.
"""
import json
from pathlib import Path
import struct
import numpy as np


def load(mi, folder, material_attributes=False):
    folder = Path(folder)
    settings = json.loads((folder / 'settings.json').read_text())
    blob = (folder / 'scene.glb').read_bytes()
    assert struct.unpack_from('<II', blob) == (0x46546C67, 2)
    size = struct.unpack_from('<I', blob, 12)[0]
    doc = json.loads(blob[20:20+size])
    binary = blob[28+size:]
    components = {5121: 'u1', 5123: '<u2', 5125: '<u4', 5126: '<f4'}
    widths = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

    def accessor(index):
        item = doc['accessors'][index]
        assert 'sparse' not in item and not item.get('normalized', False)
        view = doc['bufferViews'][item['bufferView']]
        kind = np.dtype(components[item['componentType']])
        width = widths[item['type']]
        start = view.get('byteOffset', 0) + item.get('byteOffset', 0)
        return np.ndarray((item['count'], width), kind, binary, start,
                          (view.get('byteStride', width * kind.itemsize), kind.itemsize)).copy()

    def local(node):
        if 'matrix' in node:
            return np.asarray(node['matrix'], np.float64).reshape((4,4), order='F')
        x,y,z,w = node.get('rotation', [0,0,0,1])
        result = np.eye(4)
        result[:3,:3] = [[1-2*y*y-2*z*z, 2*x*y-2*z*w, 2*x*z+2*y*w],
                         [2*x*y+2*z*w, 1-2*x*x-2*z*z, 2*y*z-2*x*w],
                         [2*x*z-2*y*w, 2*y*z+2*x*w, 1-2*x*x-2*y*y]]
        result[:3,:3] *= np.asarray(node.get('scale', [1,1,1]))
        result[:3,3] = node.get('translation', [0,0,0])
        return result

    objects = {}
    counts = {'primitives': 0, 'vertices': 0, 'triangles': 0}

    def visit(index, parent):
        node = doc['nodes'][index]
        world = parent @ local(node)
        if 'mesh' in node:
            for primitive in doc['meshes'][node['mesh']]['primitives']:
                assert primitive.get('mode', 4) == 4
                positions = accessor(primitive['attributes']['POSITION'])
                normals = accessor(primitive['attributes']['NORMAL'])
                indices = accessor(primitive['indices']).reshape((-1,3)).astype(np.uint32)
                positions = positions @ world[:3,:3].T + world[:3,3]
                normals = normals @ np.linalg.inv(world[:3,:3])
                normals /= np.linalg.norm(normals, axis=1)[:,None]
                if np.linalg.det(world[:3,:3]) < 0:
                    indices = indices[:,[0,2,1]]
                material = doc['materials'][primitive['material']] if 'material' in primitive else {}
                pbr = material.get('pbrMetallicRoughness', {})
                bsdf = {'type':'principled', 'base_color':{'type':'rgb','value':pbr.get('baseColorFactor',[1,1,1,1])[:3]},
                        'metallic':pbr.get('metallicFactor',1), 'roughness':pbr.get('roughnessFactor',1), 'specular':0.5}
                if material.get('doubleSided',False):
                    bsdf = {'type':'twosided','bsdf':bsdf}
                properties = mi.Properties()
                properties['bsdf'] = mi.load_dict(bsdf)
                key = 'primitive_'+str(counts['primitives'])
                mesh = mi.Mesh(key,len(positions),len(indices),properties,has_vertex_normals=True)
                if material_attributes:
                    count = len(positions)
                    color = np.tile(np.asarray(pbr.get('baseColorFactor',[1,1,1,1])[:3], np.float32), count)
                    factors = np.tile(np.asarray([pbr.get('metallicFactor',1), pbr.get('roughnessFactor',1), 0],
                                                 np.float32), count)
                    mesh.add_attribute('vertex_gltf_color', 3, color)
                    mesh.add_attribute('vertex_gltf_factors', 3, factors)
                params = mi.traverse(mesh)
                params['vertex_positions'] = positions.astype(np.float32).ravel()
                params['faces'] = indices.ravel()
                params['vertex_normals'] = normals.astype(np.float32).ravel()
                params.update()
                objects[key] = mesh
                counts['primitives'] += 1
                counts['vertices'] += len(positions)
                counts['triangles'] += len(indices)
        for child in node.get('children',[]):
            visit(child,world)

    for root in doc['scenes'][doc.get('scene',0)]['nodes']:
        visit(root,np.eye(4))
    return settings, objects, counts


def sensor(mi, settings, samples):
    camera = settings['camera']
    return {'type':'perspective','fov_axis':'y','fov':camera['fov'],
            'near_clip':camera['near'],'far_clip':camera['far'],
            'to_world':mi.ScalarTransform4f().look_at(origin=camera['position'],target=camera['target'],up=[0,1,0]),
            'sampler':{'type':'independent','sample_count':samples},
            'film':{'type':'hdrfilm','width':settings['width'],'height':settings['height'],
                    'pixel_format':'rgb','component_format':'float32','rfilter':{'type':'box'}}}
