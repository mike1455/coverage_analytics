// Тесты правил аналитики: выбор записи ЕДЦ, классификация покрытия, сопоставление МЖИ↔ЕДЦ, KPI и рейтинги.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickCandidate, classify, Joiner, kpiOf, groupKpi, rankGroups, reqValue, hexCells, MIN_SAMPLE,
  houseStatus, servedNoRequests, metricValue, quantileBreaks, classOf,
} from '../analytics.js';

const q = (total, extra = {}) => { const a = new Array(10).fill(0); a[0] = total; a[2] = extra.open || 0; a[3] = extra.critical || 0; a[6] = extra.q1 || 0; a[9] = extra.q4 || 0; return a; };
const edc = (o) => ({ r: o.r, ro: o.r, i: o.r, un: o.un || '', ur: o.un || '', fi: o.fi || '', a: o.a || 'адрес', ht: o.htn === 'жилое' ? 'Жилое' : o.htn || '', htn: o.htn ?? 'жилое', il: true, ac: 'ac' in o ? o.ac : true, et: o.et ?? 4, el: o.el ?? 4, rel: o.rel ?? 1, q: o.q || q(0), qg: o.q ? 1 : 0 });
const mji = (u, okrug = 'ЦАО', extra = {}) => ({ u, ur: u, code: u, okrug, area: extra.area || 'Район', address: `МЖИ ${u}`, fias: extra.fias || '', fiasValid: !!extra.fias, fiasDup: !!extra.fiasDup, uk: '', noUnom: false });

test('правило выбора записи ЕДЦ: единственная → актуальная → актуальная жилая → конфликт', () => {
  const a = edc({ r: 'a', ac: true }); const b = edc({ r: 'b', ac: false });
  assert.equal(pickCandidate([a]).pick.r, 'a');
  assert.equal(pickCandidate([a, b]).pick.r, 'a');
  const c = edc({ r: 'c', ac: true, htn: 'нежилое' });
  assert.equal(pickCandidate([a, c]).pick.r, 'a');
  const d = edc({ r: 'd', ac: true });
  assert.equal(pickCandidate([a, d]).pick, null);
  assert.equal(pickCandidate([b, edc({ r: 'e', ac: false })]).pick, null);
});

test('классификация: неизвестно ≠ нет, неактуальный/нежилой - отдельный слой', () => {
  assert.equal(classify(edc({ r: 'x', et: 3, el: 3 })).cov, 'full');
  assert.equal(classify(edc({ r: 'x', et: 3, el: 1 })).cov, 'partial');
  assert.equal(classify(edc({ r: 'x', et: 3, el: 0 })).cov, 'none');
  assert.deepEqual(classify(edc({ r: 'x', et: 0, el: 0 })), { cov: 'na', na: 'no_entrances' });
  assert.deepEqual(classify(edc({ r: 'x', ac: false })), { cov: 'excluded', na: 'edc_not_actual' });
  assert.deepEqual(classify(edc({ r: 'x', ac: null })), { cov: 'na', na: 'edc_actual_unknown' });
  assert.deepEqual(classify(edc({ r: 'x', htn: 'нежилое' })), { cov: 'excluded', na: 'edc_not_residential' });
  assert.deepEqual(classify(edc({ r: 'x', htn: 'other' })), { cov: 'na', na: 'edc_type_unknown' });
});

test('сопоставление: УНОМ, конфликт, ФИАС только при однозначности и незанятой записи', () => {
  const M = [mji('1'), mji('2'), mji('3', 'САО', { fias: 'F3' }), mji('4', 'САО', { fias: 'F4' }), mji('5', 'ЮАО', { fias: 'FD', fiasDup: true })];
  const j = new Joiner(M);
  j.consider(edc({ r: 'e1', un: '1' }));
  j.consider(edc({ r: 'e2a', un: '2' }));
  j.consider(edc({ r: 'e2b', un: '2' }));                // два актуальных жилых → конфликт
  j.consider(edc({ r: 'e3', un: '999', fi: 'F3' }));     // ФИАС-резерв: УНОМ другой, но не из МЖИ
  j.consider(edc({ r: 'e4', un: '1', fi: 'F4' }));       // ФИАС совпал, но запись уже «занята» УНОМ дома 1
  j.consider(edc({ r: 'e5', un: '', fi: 'FD' }));        // повторяющийся в МЖИ ФИАС не используется
  const { rows, edcStats } = j.finish();
  const by = Object.fromEntries(rows.map((r) => [r.u, r]));
  assert.equal(by['1'].m, 'conflict', 'у УНОМ 1 две записи (e1 и e4) - обе актуальные жилые');
  assert.equal(by['2'].m, 'conflict');
  assert.deepEqual(by['2'].cands.sort(), ['e2a', 'e2b']);
  assert.equal(by['3'].m, 'matched');
  assert.equal(by['3'].mm, 'fias');
  assert.equal(by['4'].m, 'none');
  assert.equal(by['5'].m, 'none');
  assert.equal(edcStats.edcHouses, 6);
  assert.equal(edcStats.edcUnomDupValues, 2);
});

test('ручной выбор приоритетнее, «нет соответствия» и отсутствующая запись', () => {
  const M = [mji('1'), mji('2'), mji('3')];
  const j = new Joiner(M);
  j.consider(edc({ r: 'a', un: '1' }));
  j.consider(edc({ r: 'b', un: '1' }));
  j.consider(edc({ r: 'c', un: '2' }));
  const ov = new Map([['1', { u: '1', r: 'b', reason: 'тест' }], ['2', { u: '2', r: null }], ['3', { u: '3', r: 'нет-такой' }]]);
  const { rows } = j.finish(ov, new Map());
  const by = Object.fromEntries(rows.map((r) => [r.u, r]));
  assert.equal(by['1'].m, 'matched');
  assert.equal(by['1'].mm, 'manual');
  assert.equal(by['1'].e.r, 'b');
  assert.equal(by['2'].m, 'override_none');
  assert.equal(by['3'].m, 'override_missing');
});

test('одна запись ЕДЦ не может представлять два дома МЖИ: ручной выбор вытесняет автоматический', () => {
  const j = new Joiner([mji('1'), mji('2')]);
  j.consider(edc({ r: 'a', un: '1' }));
  const { rows } = j.finish(new Map([['2', { u: '2', r: 'a' }]]), new Map([['a', edc({ r: 'a', un: '1' })]]));
  const by = Object.fromEntries(rows.map((r) => [r.u, r]));
  assert.equal(by['2'].mm, 'manual');
  assert.equal(by['1'].m, 'conflict');
});

test('KPI: заявки только домового уровня; неоценённые не считаются «без привязки»', () => {
  const M = [mji('1'), mji('2'), mji('3'), mji('4', 'САО')];
  const j = new Joiner(M);
  j.consider(edc({ r: 'a', un: '1', et: 4, el: 4, q: q(10, { open: 2, critical: 1, q1: 4, q4: 6 }) }));
  j.consider(edc({ r: 'b', un: '2', et: 2, el: 0, q: q(5) }));
  j.consider(edc({ r: 'c', un: '3', et: 0, el: 0, q: q(7) }));          // без подъездов → не оценён, но заявки считаются
  const { rows } = j.finish();
  const k = kpiOf(rows);
  assert.equal(k.mkd, 4);
  assert.equal(k.matched, 3);
  assert.equal(k.evaluated, 2);
  assert.equal(k.full, 1);
  assert.equal(k.none, 1);
  assert.equal(k.fullShare, 0.5);
  assert.equal(k.entrTotal, 6);
  assert.equal(k.entrLinked, 4);
  assert.equal(k.req.total, 22);
  assert.equal(k.na.not_matched, 1);
  assert.equal(k.na.no_entrances, 1);
  assert.equal(reqValue(rows[0], 'total', 'q1'), 4);
  assert.equal(reqValue(rows[0], 'open', 'q1'), null, 'квартальной разбивки «без даты закрытия» нет');
});

test('рейтинг: малая выборка и «Без округа» не получают места', () => {
  const M = [];
  const j = new Joiner(M);
  for (let i = 0; i < MIN_SAMPLE; i++) M.push(mji(`a${i}`, 'ЦАО'));
  for (let i = 0; i < 5; i++) M.push(mji(`b${i}`, 'САО'));
  M.push(mji('z', 'Без округа'));
  const jj = new Joiner(M);
  M.forEach((h, i) => jj.consider(edc({ r: `r${i}`, un: h.u, et: 2, el: i % 2 ? 2 : 0 })));
  const groups = groupKpi(jj.finish().rows, 'okrug');
  const ranked = Object.fromEntries(rankGroups(groups, 'fullShare').map((x) => [x.key, x.rank]));
  assert.equal(ranked['ЦАО'], 1);
  assert.equal(ranked['САО'], null);
  assert.equal(ranked['Без округа'], null);
  const byMkd = Object.fromEntries(rankGroups(groups, 'mkd').map((x) => [x.key, x.rank]));
  assert.equal(byMkd['САО'], 2);
  assert.ok(j);
});

test('статус дома: обслуживается (зелёный), частично (розовый), не обслуживается (красный)', () => {
  const M = [mji('1'), mji('2'), mji('3'), mji('4'), mji('5'), mji('6'), mji('7'), mji('8')];
  const j = new Joiner(M);
  j.consider(edc({ r: 'a', un: '1', et: 3, el: 3, q: q(5, { q1: 2 }) }));
  j.consider(edc({ r: 'b', un: '2', et: 4, el: 1 }));
  j.consider(edc({ r: 'c', un: '3', et: 2, el: 0 }));
  j.consider(edc({ r: 'd', un: '5', ac: false, q: q(7) }));
  j.consider(edc({ r: 'e1', un: '6' }));
  j.consider(edc({ r: 'e2', un: '6' }));
  j.consider(edc({ r: 'f', un: '7', et: 0, el: 0, rel: 2 }));
  j.consider(edc({ r: 'g', un: '8', et: 0, el: 0, rel: 0 }));
  const { rows } = j.finish();
  assert.deepEqual(rows.map(houseStatus), ['full', 'partial', 'none', 'none', 'excluded', 'unknown', 'full', 'unknown']);
  const k = kpiOf(rows);
  assert.equal(k.served, 3);
  assert.equal(k.hs.none, 2, 'не обслуживается: нет привязки и нет в ЕДЦ');
  assert.equal(k.notInEdc, 1);
  assert.equal(k.servedShare, 3 / 8);
  assert.equal(k.activeShare, 1 / 3);
  assert.equal(k.servedNoReq, 2, 'обслуживаются, но заявок нет');
  assert.deepEqual(rows.map(servedNoRequests), [false, true, false, false, false, false, true, false]);
  assert.equal(metricValue(k, 'reqPerHouse'), 5 / 3, 'заявки неактуального дома не входят в «на дом»');
  assert.equal(metricValue(k, 'reqPerHouse', 'q1'), 2 / 3);
  assert.equal(metricValue(k, 'requests'), 12, 'всего заявок: все сопоставленные дома');
  assert.equal(metricValue(k, 'notServed'), 2);
  const none = kpiOf(new Joiner([mji('1')]).finish().rows);
  assert.equal(none.servedShare, null, 'без выгрузок ЕДЦ доля обслуживаемых не считается');
  assert.equal(metricValue(none, 'notServed'), null);
});

test('квантильные классы', () => {
  const b = quantileBreaks([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  assert.deepEqual(b, [3, 5, 7, 9]);
  assert.equal(classOf(1, b), 0);
  assert.equal(classOf(5, b), 2);
  assert.equal(classOf(10, b), 4);
  assert.deepEqual(quantileBreaks([4, 4, 4]), [], 'одинаковые значения: один класс');
});

test('сетка шестиугольников: только дома с координатами, соседние дома в одной ячейке', () => {
  const j = new Joiner([mji('1'), mji('2'), mji('3')]);
  j.consider(edc({ r: 'a', un: '1', q: q(10) }));
  j.consider(edc({ r: 'b', un: '2', q: q(4) }));
  j.consider(edc({ r: 'c', un: '3', q: q(1) }));
  const { rows } = j.finish();
  const geo = new Map([['1', { lat: 55.75, lon: 37.6 }], ['2', { lat: 55.7502, lon: 37.6003 }], ['3', { lat: 55.80, lon: 37.70 }]]);
  const { cells, geoRows } = hexCells(rows, geo, 500);
  assert.equal(geoRows, 3);
  assert.equal(cells.length, 2);
  const big = cells.find((c) => c.k.mkd === 2);
  assert.equal(metricValue(big.k, 'reqPerHouse'), 7);
  assert.equal(big.ring.length, 6);
  const far = cells.find((c) => c.k.mkd === 1);
  assert.ok(Math.abs(far.lat - 55.80) < 0.006 && Math.abs(far.lon - 37.70) < 0.01, 'центр ячейки рядом с домом');
});
