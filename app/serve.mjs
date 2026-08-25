// ============================================================================
// serve.mjs - a dependency-free static server for the Numpla shell.
//
//   node app/serve.mjs   ->  http://localhost:5173
//
// It exists for one reason: WebAssembly streaming instantiation refuses any
// response whose Content-Type is not exactly `application/wasm`, and the usual
// stand-ins (python -m http.server) get that wrong. So do ES modules and
// `text/javascript`. Everything else here is incidental.
//
// Node builtins only: node:http, node:fs, node:path.
// ============================================================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '127.0.0.1';
// Directory of this file. Done by hand (rather than node:url's fileURLToPath)
// to keep the import list to http/fs/path; handles the Windows /C:/ prefix and
// percent-escapes such as %20.
const ROOT = path.dirname(
  decodeURIComponent(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1')
);

const TYPES = new Map(Object.entries({
  '.wasm': 'application/wasm',              // non-negotiable
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/plain; charset=utf-8',
}));

const typeFor = (file) =>
  TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream';

function send(res, code, body, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }

  if (pathname.endsWith('/')) pathname += 'index.html';

  // Resolve inside ROOT and refuse anything that escapes it.
  const target = path.resolve(ROOT, '.' + pathname);
  const rel = path.relative(ROOT, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(target, (err, stat) => {
    if (err || !stat.isFile()) {
      send(res, 404, `404  ${pathname}\n\n` +
        (pathname.startsWith('/pkg/')
          ? 'The WASM package is not built yet. Run:\n' +
            '  wasm-pack build --target web --out-dir ../../app/pkg crates/numpla-wasm\n'
          : ''));
      return;
    }

    const headers = {
      'Content-Type': typeFor(target),
      'Content-Length': stat.size,
      // local-first dev server: never serve a stale module or a stale .wasm
      'Cache-Control': 'no-store',
    };

    res.writeHead(200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(target);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`numpla  ->  http://${HOST}:${PORT}`);
  console.log(`serving ${ROOT}`);
  if (!fs.existsSync(path.join(ROOT, 'pkg', 'numpla_wasm.js'))) {
    console.log(
      '\nnote: app/pkg/numpla_wasm.js is missing - the shell will show a\n' +
      '      build hint on its loading screen until you run:\n' +
      '      wasm-pack build --target web --out-dir ../../app/pkg crates/numpla-wasm'
    );
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`port ${PORT} is already in use. Try: PORT=5174 node app/serve.mjs`);
    process.exit(1);
  }
  throw err;
});
