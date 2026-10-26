// Офлайн-карта: файл, который пишет tools/basemap.py, читается независимой реализацией PMTiles
// из protomaps-leaflet (та же, что работает в приложении), в том числе с листовыми каталогами.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { ROOT } from './helpers.mjs';

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const PY_ARGS = process.platform === 'win32' && !process.env.PYTHON ? ['-3'] : [];

function loadReader() {
  globalThis.window = globalThis.window || globalThis;
  const code = readFileSync(join(ROOT, 'vendor', 'protomaps', 'protomaps-leaflet.js'), 'utf8');
  return new Function(`${code}; return protomapsL;`)();
}

function serveFile(file) {
  const buf = readFileSync(file);
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      const a = m ? Number(m[1]) : 0;
      const b = m ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
      resp.writeHead(m ? 206 : 200, { 'Content-Length': b - a + 1, ...(m ? { 'Content-Range': `bytes ${a}-${b}/${buf.length}` } : {}) });
      resp.end(buf.subarray(a, b + 1));
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

const SCRIPT = `
import sys, json, test_tools as t
src, out, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
import contextlib, io
with contextlib.redirect_stdout(io.StringIO()) as buf:
    t.write_e2e_source(src)
samples = json.loads(buf.getvalue())
if limit:
    t.BM.ROOT_LIMIT = t.BM.HEADER_LEN + limit
t.BM.extract(src, out=out, maxzoom=11)
hd = t.BM.parse_header(open(out, "rb").read(t.BM.HEADER_LEN))
print(json.dumps({"samples": samples, "leaf_length": hd["leaf_length"]}))
`;

for (const [name, limit] of [['только корневой каталог', 0], ['с листовыми каталогами', 120]]) {
  test(`вырезка карты читается protomaps-leaflet: ${name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mca-basemap-'));
    try {
      const out = join(dir, 'moscow.pmtiles');
      const res = JSON.parse(execFileSync(PY, [...PY_ARGS, '-c', SCRIPT, join(dir, 'planet.pmtiles'), out, String(limit)], { cwd: join(ROOT, 'tests') }).toString());
      assert.equal(res.leaf_length > 0, limit > 0);
      const srv = await serveFile(out);
      try {
        const { PmtilesSource } = loadReader();
        const src = new PmtilesSource(`http://127.0.0.1:${srv.address().port}/moscow.pmtiles`, false);
        for (const [z, x, y, b64] of res.samples) {
          const t = await src.p.getZxy(z, x, y);
          assert.equal(t ? Buffer.from(t.data).toString('base64') : null, b64, `${z}/${x}/${y}`);
        }
      } finally {
        srv.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
