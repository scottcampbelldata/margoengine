import { openNetCDF } from '@margoengine/sciviz/netcdf';
import type { AnalysisGrid } from '@margoengine/sciviz/clip';

/** Read the original SEACAS standard sample through Margo's NetCDF API; format-specific assembly stays in this demo. */
export async function readDisplacement(bytes: Uint8Array, step = 4): Promise<AnalysisGrid> {
  using file = await openNetCDF(bytes);
  const n = file.dimensions.num_nodes;
  if (!Number.isInteger(step) || step < 0 || step >= file.dimensions.time_step)
    throw new RangeError('Select a SEACAS time step in the file');
  const coordinates = await Promise.all(['coordx', 'coordy', 'coordz'].map((name) => file.variables[name].read()));
  const nameData = await file.variables.name_nod_var.read(),
    width = file.dimensions.len_name,
    names = Array.from(
      { length: file.dimensions.num_nod_var },
      (_, i) => String.fromCharCode(...nameData.slice(i * width, (i + 1) * width)).split('\0')[0],
    );
  const displacements = await Promise.all(
    ['disp_x', 'disp_y', 'disp_z'].map((name) => {
      const index = names.indexOf(name);
      if (index < 0) throw new Error(`SEACAS sample lacks ${name}`);
      return file.variables[`vals_nod_var${index + 1}`].read({ start: [step, 0], count: [1, n] });
    }),
  );
  const points = Float64Array.from({ length: 3 * n }, (_, i) => coordinates[i % 3][Math.floor(i / 3)]),
    displacement = Float64Array.from({ length: 3 * n }, (_, i) => displacements[i % 3][Math.floor(i / 3)]),
    magnitude = Float64Array.from({ length: n }, (_, i) =>
      Math.hypot(displacement[3 * i], displacement[3 * i + 1], displacement[3 * i + 2]),
    );
  const connectivity: number[] = [],
    offsets: number[] = [],
    types: number[] = [];
  for (let block = 1; block <= file.dimensions.num_el_blk; block++) {
    const variable = file.variables[`connect${block}`];
    if (String(variable.attributes.elem_type).replace(/\0/g, '').toLowerCase() !== 'hex8')
      throw new Error('Expected the standard SEACAS HEX8 sample');
    const data = await variable.read();
    for (let i = 0; i < data.length; i += 8) {
      for (let k = 0; k < 8; k++) connectivity.push(data[i + k] - 1);
      offsets.push(connectivity.length);
      types.push(12);
    }
  }
  return {
    points,
    connectivity: Uint32Array.from(connectivity),
    offsets: Uint32Array.from(offsets),
    types: Uint8Array.from(types),
    pointData: magnitude,
    pointArrays: { displacement },
  };
}
