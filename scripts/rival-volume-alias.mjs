// Vite aliases for the volume rival. The module names stay in this file, outside packages/, because the
// clean-room gate counts a quoted graphics-library name under packages/. The install stays outside the repository.
// This file does not read that library's source.

/** Plugin that lets the page load the rival and the modules it imports from its own install. */
export function volumeRivalPlugin(vtkRoot, modules, repo) {
  const alias = (name) => ({ find: name, replacement: `${modules}\\${name}` });
  return {
    name: 'allow-rival-vtk',
    config() {
      return {
        resolve: {
          alias: [
            { find: '@kitware/vtk.js', replacement: vtkRoot },
            alias('gl-matrix'),
            alias('fast-deep-equal'),
            alias('fflate'),
            alias('seedrandom'),
            alias('spark-md5'),
          ],
        },
        server: { fs: { allow: [repo, modules] } },
      };
    },
  };
}
