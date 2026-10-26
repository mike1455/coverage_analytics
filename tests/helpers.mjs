// Общие помощники node-тестов: чтение фикстур через тот же CSV-парсер, что в браузере.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseCsvText } from '../core/csv.js';
import {
  RequestIndex, houseReader, entranceReader, mergeHouse, mergeEntrance, countEntranceNumber, finalizeRecord,
} from '../core/edc.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIX = join(ROOT, 'tests', 'fixtures', 'synthetic');

export function readCsv(path) {
  return parseCsvText(readFileSync(path, 'utf8'));
}

/** Объединение трёх сырых CSV ядром приложения (как в worker, но синхронно). */
export function mergeRaw(dir = FIX, { matchByNumber = false } = {}) {
  const req = readCsv(join(dir, '03_заявки_2026.csv'));
  const index = new RequestIndex();
  index.setHeader(req.header);
  req.rows.forEach((r, i) => index.addRow(r, i + 2));
  const h = readCsv(join(dir, '01_дома.csv'));
  const hr = houseReader(h.header, false);
  const houses = h.rows.map((r, i) => finalizeRecord(mergeHouse(hr.read(r, i + 2), index)));
  const e = readCsv(join(dir, '02_подъезды.csv'));
  const er = entranceReader(e.header, false);
  const ents = e.rows.map((r, i) => er.read(r, i + 2));
  let counts = null;
  if (matchByNumber) { counts = new Map(); ents.forEach((x) => countEntranceNumber(x, counts)); }
  const counters = {};
  ents.forEach((x) => mergeEntrance(x, index, { matchByNumber, numberCounts: counts, counters }));
  return { index, houses, entrances: ents, counters };
}
