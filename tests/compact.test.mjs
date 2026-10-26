// Компактное хранение: pack → unpack без потерь, хэш изменений стабилен, размер записи заметно меньше.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { mergeRaw, FIX, readCsv } from './helpers.mjs';
import { join } from 'node:path';
import { packHouse, unpackHouse, packEntrances, unpackEntrances, ob } from '../core/compact.js';
import { houseReader, entranceReader, finalizeRecord } from '../core/edc.js';
import { recordHash } from '../core/util.js';

const size = (x) => v8.serialize(x).length;

test('дома: pack → unpack без потерь и с тем же хэшем', () => {
  const { houses } = mergeRaw();
  for (const h of houses) {
    const rec = { ...h, s: 'edc-x' };
    const back = unpackHouse(packHouse(rec));
    const { hs: _a, ...x } = rec;
    const { hs: _b, ...y } = back;
    assert.deepEqual(y, x);
    assert.equal(recordHash(y), recordHash(x));
  }
});

test('объединённый CSV (Python S2): pack → unpack без потерь', () => {
  const t = readCsv(join(FIX, 'expected_houses_merged.csv'));
  const rd = houseReader(t.header, true);
  for (let i = 0; i < t.rows.length; i++) {
    const rec = finalizeRecord({ ...rd.read(t.rows[i], i + 2), s: 'edc-x' });
    assert.deepEqual(unpackHouse(packHouse(rec)), rec);
  }
});

test('подъезды дома: одна запись, поля восстанавливаются', () => {
  const { entrances } = mergeRaw();
  const byH = new Map();
  for (const e of entrances) if (e.e) (byH.get(e.h) || byH.set(e.h, []).get(e.h)).push(e);
  let packedSize = 0; let rawSize = 0;
  for (const [h, list] of byH) {
    const p = packEntrances('edc-x', h, list);
    packedSize += size(p);
    rawSize += list.reduce((s, e) => s + size({ s: 'edc-x', ...e }), 0);
    const back = unpackEntrances(p);
    assert.equal(back.length, list.length);
    back.forEach((b, i) => {
      const e = list[i];
      for (const k of ['h', 'e', 'lb', 'num', 'eil', 'eac', 'st', 'rel', 'org', 'pd', 'pids', 'bs', 'q', 'qd', 'qm', 'qg', 'qx']) assert.deepEqual(b[k], e[k], `${k} (${h})`);
    });
  }
  assert.ok(packedSize < rawSize * 0.5, `компактно: ${packedSize} против ${rawSize}`);
});

test('однобайтовые строки: значение не меняется, размер вдвое меньше', () => {
  const two = 'Адрес,016dd319-1e3c-7b08-bb95-28e9c0652a12'.slice(6);
  assert.equal(ob(two), two);
  assert.ok(size(ob(two)) < size(two));
  assert.equal(ob('Жилое'), 'Жилое');
});

test('размер записи дома после упаковки - не больше ~60% исходного', () => {
  const { houses } = mergeRaw();
  const raw = houses.reduce((s, h) => s + size({ s: 'edc-x', ...h }), 0);
  const packed = houses.reduce((s, h) => s + size(packHouse({ s: 'edc-x', ...h })), 0);
  assert.ok(packed < raw * 0.6, `${packed} против ${raw}`);
});
