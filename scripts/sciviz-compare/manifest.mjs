// Public API adapters only; every rival install stays in engine-bench.
export const RIVALS = {
  vtk: '@kitware/vtk.js',
  plotly: 'plotly.js-dist-min',
  deck: '@deck.gl/core',
  echarts: 'echarts-gl',
  regl: 'regl-scatterplot',
  cosmograph: '@cosmograph/cosmograph',
};
export const INSTALL = [
  '@kitware/vtk.js@38.0.5',
  'plotly.js-dist-min@4.2.0',
  '@deck.gl/core@9.4.1',
  '@deck.gl/layers@9.4.1',
  '@deck.gl/geo-layers@9.4.1',
  'echarts@6.1.0',
  'echarts-gl@2.1.0',
  'regl-scatterplot@1.16.0',
  '@cosmograph/cosmograph@2.5.1',
];
export const CASES = [
  { id: 'volume', rival: 'vtk', scales: [64, 128, 256, 512], unit: 'voxels per axis' },
  { id: 'isosurface', rival: 'vtk', scales: [32, 64, 128, 256], unit: 'voxels per axis' },
  ...['plotly', 'deck', 'echarts', 'regl'].map((rival) => ({
    id: 'scatter',
    rival,
    scales: [1024, 16384, 262144, 1048576, 4194304, 16777216],
    unit: 'points',
  })),
  ...['plotly', 'echarts'].map((rival) => ({
    id: 'line',
    rival,
    scales: [1024, 16384, 262144, 1048576],
    unit: 'vertices',
  })),
  { id: 'heatmap', rival: 'plotly', scales: [32, 64, 128, 256, 512, 1024], unit: 'cells per axis' },
  { id: 'streamlines', rival: 'vtk', scales: [8, 32, 128, 512], unit: 'seeds per axis' },
  { id: 'graph', rival: 'cosmograph', scales: [1, 4, 16, 64, 256], unit: 'copies of OpenAlex graph' },
  { id: 'tiles', rival: 'deck', scales: [1, 2, 3, 4, 5, 6], unit: 'tile zoom' },
];

export function compareOptions(args) {
  const options = { runs: 1, cases: [], output: 'test-results/bp-182/compare', install: false, list: false };
  for (const arg of args) {
    if (arg === '--install') options.install = true;
    else if (arg === '--list') options.list = true;
    else if (arg.startsWith('--runs=')) {
      if (!/^[1-9]\d*$/.test(arg.slice(7)) || Number(arg.slice(7)) > 100) throw new RangeError('runs must be 1..100');
      options.runs = Number(arg.slice(7));
    } else if (arg.startsWith('--cases=')) options.cases = arg.slice(8).split(',');
    else if (arg.startsWith('--output=') && arg.length > 9) options.output = arg.slice(9);
    else throw new TypeError(`Unknown sciviz comparison option: ${arg}`);
  }
  for (const id of options.cases)
    if (!CASES.some((c) => `${c.id}/${c.rival}` === id)) throw new RangeError(`Unknown case: ${id}`);
  return options;
}
