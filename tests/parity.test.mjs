// Паритет с эталонными скриптами S2 (merge_edc_houses.py / merge_edc_entrances.py):
// JS-объединение трёх сырых CSV должно давать те же показатели, что Python, строка в строку.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { FIX, readCsv, mergeRaw } from './helpers.mjs';
import { houseReader, entranceReader, STATS_COLUMNS } from '../core/edc.js';

function compare(jsRecs, expectedFile, reader, keyOf) {
  const exp = readCsv(join(FIX, expectedFile));
  const rd = reader(exp.header, true);
  const expected = exp.rows.map((r, i) => rd.read(r, i + 2));
  assert.equal(jsRecs.length, expected.length, 'число строк совпадает с исходным (без размножения JOIN)');
  for (let i = 0; i < expected.length; i++) {
    const a = jsRecs[i];
    const b = expected[i];
    assert.equal(keyOf(a), keyOf(b), `ключ строки ${i + 2}`);
    assert.deepEqual(a.q, b.q, `счётчики строки ${i + 2} (${keyOf(a)})`);
    assert.equal(a.qm, b.qm, `способ сопоставления строки ${i + 2}`);
    assert.equal(a.qg, b.qg, `групп сопоставлено, строка ${i + 2}`);
    assert.equal(a.qu, b.qu, `УНОМ из заявок, строка ${i + 2}`);
    assert.equal(a.qx, b.qx, `расхождение УНОМ, строка ${i + 2}`);
    assert.equal(a.qd, b.qd, `дата последней заявки, строка ${i + 2}`);
  }
  return expected;
}

test('дома: JS = merge_edc_houses.py', () => {
  const { houses } = mergeRaw();
  const exp = compare(houses, 'expected_houses_merged.csv', houseReader, (x) => x.r);
  assert.equal(STATS_COLUMNS.length, exp[0].q.length);
});

test('подъезды: JS = merge_edc_entrances.py (без --match-by-number)', () => {
  const { entrances } = mergeRaw();
  compare(entrances, 'expected_entrances_merged.csv', entranceReader, (x) => `${x.h}|${x.e}`);
});

test('подъезды: JS = merge_edc_entrances.py --match-by-number', () => {
  const { entrances } = mergeRaw(FIX, { matchByNumber: true });
  compare(entrances, 'expected_entrances_merged_by_number.csv', entranceReader, (x) => `${x.h}|${x.e}`);
});

test('несопоставленные агрегаты совпадают с контрольным отчётом S2', () => {
  const { index } = mergeRaw();
  const h = index.unmatchedReport('Дом');
  assert.equal(h.loaded, 147);
  assert.equal(h.unmatched, 3);
  const e = index.unmatchedReport('Подъезд');
  assert.equal(e.loaded, 335);
  assert.equal(e.unmatched, 138); // как в expected_entrances_merged.csv.control.txt
  const byNum = mergeRaw(FIX, { matchByNumber: true }).index.unmatchedReport('Подъезд');
  assert.equal(byNum.unmatched, 123); // как в expected_entrances_merged_by_number.csv.control.txt
});
