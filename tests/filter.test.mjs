// Фильтры столбцов таблиц: условия для чисел, поиск по словам, сортировка.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numFilter, textFilter, applyTableFilters } from '../core/filter.js';

test('числовые условия', () => {
  assert.equal(numFilter(''), null);
  assert.equal(numFilter('  '), null);
  assert.ok(numFilter('>90')(91) && !numFilter('>90')(90));
  assert.ok(numFilter('>= 90')(90));
  assert.ok(numFilter('≤5')(5) && !numFilter('≤5')(6));
  assert.ok(numFilter('<1 000')(999) && !numFilter('<1 000')(1000));
  assert.ok(numFilter('10-20')(10) && numFilter('10-20')(20) && !numFilter('10-20')(21));
  assert.ok(numFilter('20..10')(15));
  assert.ok(numFilter('=5')(5) && !numFilter('=5')(5.2));
  assert.ok(numFilter('5')(5) && !numFilter('5')(6));
  assert.ok(!numFilter('>0')(null), 'пустое значение не проходит фильтр');
  assert.deepEqual(numFilter('больше 5'), { error: true });
  assert.deepEqual(numFilter('>'), { error: true });
});

test('проценты вводятся в процентах, голое число с точностью до введённых знаков', () => {
  assert.ok(numFilter('>90%', 100)(0.905));
  assert.ok(!numFilter('>90', 100)(0.9));
  assert.ok(numFilter('90', 100)(0.8951) && numFilter('90', 100)(0.9049) && !numFilter('90', 100)(0.906));
  assert.ok(numFilter('90,3', 100)(0.903) && !numFilter('90,3', 100)(0.9036));
  assert.ok(numFilter('50-60', 100)(0.55));
});

test('текстовый фильтр ищет все слова без учёта регистра и ё', () => {
  const t = textFilter('сао север');
  assert.ok(t('САО Северный административный округ'));
  assert.ok(!t('СВАО Северо-Восточный'));
  assert.ok(textFilter('ЕЛ')('Ёлки'));
  assert.equal(textFilter(' , '), null);
});

test('фильтры и сортировка вместе, пустые значения внизу', () => {
  const rows = [
    { k: 'ЦАО', n: 10, p: 0.95 }, { k: 'САО', n: 30, p: null }, { k: 'ЮАО', n: 20, p: 0.5 }, { k: 'ВАО', n: 5, p: 0.91 },
  ];
  const columns = [
    { key: 'k', type: 'text', value: (r) => r.k },
    { key: 'n', type: 'num', value: (r) => r.n },
    { key: 'p', type: 'num', scale: 100, value: (r) => r.p },
  ];
  let res = applyTableFilters(rows, columns, { f: { p: '>90' }, sort: 'n', dir: -1 });
  assert.deepEqual(res.rows.map((r) => r.k), ['ЦАО', 'ВАО']);
  res = applyTableFilters(rows, columns, { sort: 'p', dir: -1 });
  assert.deepEqual(res.rows.map((r) => r.k), ['ЦАО', 'ВАО', 'ЮАО', 'САО']);
  res = applyTableFilters(rows, columns, { sort: 'p', dir: 1 });
  assert.deepEqual(res.rows.map((r) => r.k), ['ЮАО', 'ВАО', 'ЦАО', 'САО']);
  res = applyTableFilters(rows, columns, { sort: 'k', dir: 1, f: { n: 'abc' } });
  assert.deepEqual(res.rows.map((r) => r.k), ['ВАО', 'САО', 'ЦАО', 'ЮАО'], 'непонятное условие не отбрасывает строки');
  assert.ok(res.errors.has('n'));
  res = applyTableFilters(rows, columns, { f: { k: 'ао', n: '10-25' } });
  assert.deepEqual(res.rows.map((r) => r.k), ['ЦАО', 'ЮАО'], 'без сортировки исходный порядок');
});
