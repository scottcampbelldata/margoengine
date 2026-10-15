import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../docs/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Use GET or HEAD.');
    return;
  }
  let file;
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const demo = /^\/demos\/(dof|tonemap)(?:\/|$)/.test(pathname),
      fileRoot = demo ? resolve(root, '../site/dist') : root;
    if (demo && pathname.endsWith('/')) pathname += 'index.html';
    file = resolve(fileRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(resolve(fileRoot) + sep) || !types[extname(file)]) {
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
      'Content-Type': types[extname(file)] + '; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Could not read this file.');
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.on('error', (error) => {
    console.error('Could not start the catalog:', error.message);
    process.exitCode = 1;
  });
  server.listen(5184, '127.0.0.1', () => console.log('Margo Engine module catalog: http://127.0.0.1:5184'));
}
