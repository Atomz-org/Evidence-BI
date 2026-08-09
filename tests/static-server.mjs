import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2]);
const PORT = Number(process.argv[3] ?? 4321);

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.parquet': 'application/octet-stream',
	'.wasm': 'application/wasm',
	'.woff2': 'font/woff2',
	'.arrow': 'application/octet-stream'
};

http
	.createServer((req, res) => {
		const url = decodeURIComponent(req.url.split('?')[0]);
		let file = path.join(ROOT, url);

		try {
			if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
			if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
			if (!fs.existsSync(file)) {
				res.writeHead(404);
				res.end('not found');
				return;
			}
			// No COOP/COEP: `require-corp` without matching CORP headers on every
			// subresource blocks the duckdb-wasm worker outright.
			res.writeHead(200, {
				'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
				'cross-origin-resource-policy': 'cross-origin'
			});
			fs.createReadStream(file).pipe(res);
		} catch (e) {
			res.writeHead(500);
			res.end(String(e));
		}
	})
	.listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} on ${PORT}`));
