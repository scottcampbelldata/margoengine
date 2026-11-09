// Vite aliases and the quadtree bytes for the tiles rival. Module names stay in this file, outside packages/.

/** Plugin that serves the tileset and lets the page load 3d-tiles-renderer from outside the repository. */
export function tilesRivalPlugin(modules, repo, scene) {
  const { jsonBytes, glb } = scene;
  return {
    name: 'allow-rival-tiles',
    config() {
      return {
        resolve: {
          alias: [
            {
              find: '3d-tiles-renderer',
              replacement: `${modules}\\3d-tiles-renderer\\build\\index.js`,
            },
            // Exact package entry only. A prefix alias would swallow three/examples imports.
            { find: /^three$/, replacement: `${modules}\\three\\build\\three.module.js` },
            { find: /^three\/(.*)$/, replacement: `${modules}\\three\\$1` },
          ],
        },
        server: { fs: { allow: [repo, modules] } },
      };
    },
    configureServer(server) {
      server.middlewares.use('/rival-data', (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0].replace(/^\//, ''));
        let bytes;
        let type;
        if (name === 'tileset.json') {
          bytes = jsonBytes;
          type = 'application/json';
        } else if (/^tiles\/\d+\/\d+\/\d+\.glb$/.test(name)) {
          bytes = glb;
          type = 'model/gltf-binary';
        } else return next();
        res.setHeader('Content-Type', type);
        res.setHeader('Content-Length', String(bytes.byteLength));
        res.end(bytes);
      });
    },
  };
}
