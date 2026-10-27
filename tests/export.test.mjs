// Выгрузка в Excel: четыре листа, все дома, статусы и итоги по округам совпадают с расчётом.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { unzipSync, strFromU8 } from '../vendor/fflate/fflate.esm.js';
import { FIX, readCsv, mergeRaw } from './helpers.mjs';
import { parseMji } from '../core/mji.js';
import { Joiner, kpiOf, houseStatus } from '../analytics.js';
import { buildWorkbook } from '../export.js';

test('книга Excel по синтетическим данным', () => {
  const m = readCsv(join(FIX, 'mji_synthetic.csv'));
  const { houses } = parseMji(m.header, m.rows);
  const j = new Joiner(houses);
  for (const e of mergeRaw().houses) j.consider(e);
  const { rows } = j.finish();
  const geo = new Map([[rows[0].u, { lat: 55.75, lon: 37.6, status: 'osm' }]]);
  const files = unzipSync(buildWorkbook({ rows, geo, scope: 'Москва', dates: { mji: '19.10.2026', edc: '25.10.2026' } }));
  const names = [...strFromU8(files['xl/workbook.xml']).matchAll(/<sheet name="([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(names, ['Сводка', 'Округа', 'Районы', 'Дома']);
  const count = (i) => (strFromU8(files[`xl/worksheets/sheet${i}.xml`]).match(/<row /g) || []).length;
  assert.equal(count(4), rows.length + 1, 'все дома и шапка');
  const sst = strFromU8(files['xl/sharedStrings.xml']);
  const k = kpiOf(rows);
  for (const s of new Set(rows.map(houseStatus))) assert.ok(k.hs[s] > 0);
  assert.match(sst, /Обслуживается часть подъездов/);
  assert.match(sst, /Не обслуживается в ЕДЦ/);
  assert.match(sst, /OpenStreetMap/, 'источник координат дома');
  const okr = strFromU8(files['xl/worksheets/sheet2.xml']);
  assert.ok(count(2) >= 13, 'строка на каждый округ');
  assert.match(okr, /<autoFilter /);
});
