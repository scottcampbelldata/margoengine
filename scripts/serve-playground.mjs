// Serves the repository for the playground (docs/playground.md): the page at /site/playground/ and the built packages
// under /node_modules/, so `?packages=/node_modules/` runs code against this checkout. Every response allows any origin
// because the sandboxed frame has an opaque origin and fetches its modules cross-origin. Run `npm run build:packages`
// first, then `npm run playground` and open the URL it prints. Read-only: GET and HEAD of files under the repository.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ktx2': 'image/ktx2',
  '.hdr': 'image/vnd.radiance',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Use GET or HEAD.');
    return;
  }
  let file;
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    file = resolve(root, `.${pathname}`);
    if (!file.startsWith(root + sep) || !types[extname(file)] || /[\\/]\.git[\\/]/.test(file)) {
      response.writeHead(404).end('Not found.');
      return;
    }
  } catch {
    response.writeHead(400).end('Invalid URL.');
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[extname(file)],
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Could not read this file.');
  }
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT ?? 5180);
  server.listen(port, '127.0.0.1', () =>
    console.log(`Playground: http://127.0.0.1:${port}/site/playground/?packages=/node_modules/`),
  );
}
