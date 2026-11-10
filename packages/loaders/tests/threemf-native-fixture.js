export const MATERIALS =
  '<basematerials id="1"><base name="red" displaycolor="#FF0000"/><base name="blue" displaycolor="#0000FF"/></basematerials><compositematerials id="2" matid="1" matindices="0 1"><composite values="0.25 0.75"/></compositematerials><colorgroup id="4"><color color="#00FF0000"/><color color="#FFFFFF00"/></colorgroup><multiproperties id="3" pids="2 4"><multi pindices="0 0"/><multi pindices="0 1"/></multiproperties>';
export const VERTICES =
  '<vertices><vertex x="1.123456789012345" y="0" z="0"/><vertex x="5.123456789012345" y="0" z="0"/><vertex x="1.133456789012345" y="0" z="0"/><vertex x="1.123456789012345" y="4" z="0"/></vertices>';
export const TRIANGLES = '<triangles><triangle v1="0" v2="1" v3="3"/></triangles>';
export const LATTICE =
  '<b:beamlattice radius="1" minlength="1" cap="sphere" b2:ballmode="all" b2:ballradius="0.25"><b:beams><b:beam v1="0" v2="1" r1="2" r2="3" cap1="butt" cap2="hemisphere" p1="1"/><b:beam v1="0" v2="2"/></b:beams><b2:balls><b2:ball vindex="0" r="0.5"/><b2:ball vindex="3" r="10"/></b2:balls><b:beamsets><b:beamset name="members" identifier="set-a"><b:ref index="0"/><b:ref index="1"/><b2:ballref index="0"/></b:beamset></b:beamsets></b:beamlattice>';
export const SLICE =
  '<s:slice ztop="1"><s:vertices><s:vertex x="0" y="0"/><s:vertex x="2" y="0"/><s:vertex x="2" y="2"/><s:vertex x="0" y="2"/></s:vertices><s:polygon startv="0"><s:segment v2="1" p1="0" p2="1"/><s:segment v2="2"/><s:segment v2="3"/><s:segment v2="0"/></s:polygon></s:slice><s:slice ztop="2"/>';
export const model = (resources, build = '<item objectid="9"/>') =>
  `<model unit="millimeter" xmlns:s="http://schemas.microsoft.com/3dmanufacturing/slice/2015/07" xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02" xmlns:b2="http://schemas.microsoft.com/3dmanufacturing/beamlattice/balls/2020/07" requiredextensions="s b b2"><resources>${resources}</resources><build>${build}</build></model>`;
export const object = (extras = '', attributes = '', triangles = TRIANGLES) =>
  `<object id="9" pid="3" pindex="0" ${attributes}><mesh>${VERTICES}${triangles}${extras}</mesh></object>`;
export const nativeFixtureXML = () =>
  model(
    MATERIALS +
      `<s:slicestack id="10">${SLICE}</s:slicestack>` +
      object(LATTICE, 's:slicestackid="10" s:meshresolution="lowres"'),
  );
