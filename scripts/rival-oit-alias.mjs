// Vite alias for the OIT rival. The module name stays in this file, outside packages/.

/** Lets the page load @babylonjs/core from outside the repository. */
export function oitRivalPlugin(modules, repo) {
  const root = `${modules}\\@babylonjs\\core`;
  return {
    name: 'allow-rival-oit',
    config() {
      return {
        resolve: {
          alias: [{ find: /^@babylonjs\/core\/(.*)$/, replacement: `${root}\\$1` }],
        },
        server: { fs: { allow: [repo, modules] } },
      };
    },
  };
}
