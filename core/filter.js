// Фильтры для столбцов таблиц: текст ищется по словам, числа задаются условием.
import { lowerYo } from './util.js';

const NUM = '(-?\\d+(?:\\.\\d+)?)';
const OPS = { '>': (v, x) => v > x, '<': (v, x) => v < x, '>=': (v, x) => v >= x, '<=': (v, x) => v <= x, '=': (v, x) => v === x };

/**
 * Условие для числового столбца: «>90», «<=50», «10-20», «10..20», «=5», «5».
 * Голое число совпадает с точностью до введённых знаков: «90» для процентов это 89,5..90,49.
 * @param {string} text что ввёл пользователь
 * @param {number} scale множитель значения (100 для долей, которые показываются в процентах)
 * @returns {null | {error: true} | ((v: number|null) => boolean)} null, если фильтр пуст
 */
export function numFilter(text, scale = 1) {
  const s = String(text || '').replace(/\s+/g, '').replace(/,/g, '.').replace(/%/g, '').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/\u2013|\u2014/g, '-');
  if (!s) return null;
  const k = (v) => v * scale;
  let m = s.match(new RegExp(`^(>=|<=|>|<|=)${NUM}$`));
  if (m) {
    const x = Number(m[2]);
    return (v) => v !== null && v !== undefined && Number.isFinite(v) && OPS[m[1]](k(v), x);
  }
  m = s.match(new RegExp(`^${NUM}(?:-|\\.\\.)${NUM}$`));
  if (m) {
    const a = Math.min(Number(m[1]), Number(m[2]));
    const b = Math.max(Number(m[1]), Number(m[2]));
    return (v) => v !== null && v !== undefined && Number.isFinite(v) && k(v) >= a && k(v) <= b;
  }
  m = s.match(new RegExp(`^${NUM}$`));
  if (m) {
    const x = Number(m[1]);
    const half = 0.5 / 10 ** ((m[1].split('.')[1] || '').length);
    return (v) => v !== null && v !== undefined && Number.isFinite(v) && k(v) >= x - half - 1e-9 && k(v) < x + half - 1e-9;
  }
  return { error: true };
}

/** Текстовый фильтр: все слова запроса должны встретиться в строке. null, если фильтр пуст. */
export function textFilter(text) {
  const words = lowerYo(text).split(/[\s,]+/).filter(Boolean);
  if (!words.length) return null;
  return (v) => {
    const hay = lowerYo(v);
    return words.every((w) => hay.includes(w));
  };
}

/**
 * Отфильтровать и отсортировать строки таблицы.
 * @param {object[]} rows
 * @param {{key: string, type?: 'text'|'num', scale?: number, value: (r) => any, search?: (r) => string}[]} columns
 * @param {{sort?: string, dir?: number, f?: Record<string, string>}} state
 * @returns {{rows: object[], errors: Set<string>}} errors: столбцы с непонятным условием
 */
export function applyTableFilters(rows, columns, state) {
  const errors = new Set();
  const tests = [];
  for (const c of columns) {
    const text = state.f && state.f[c.key];
    if (!text) continue;
    if (c.type === 'text') {
      const t = textFilter(text);
      if (t) tests.push((r) => t(c.search ? c.search(r) : c.value(r)));
    } else {
      const t = numFilter(text, c.scale || 1);
      if (t && t.error) errors.add(c.key);
      else if (t) tests.push((r) => t(c.value(r)));
    }
  }
  let out = tests.length ? rows.filter((r) => tests.every((t) => t(r))) : [...rows];
  const col = state.sort && columns.find((c) => c.key === state.sort);
  if (col) {
    const dir = state.dir || 1;
    const empty = (v) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));
    out = out.map((r, i) => ({ r, i, v: col.value(r) })).sort((a, b) => {
      if (empty(a.v) || empty(b.v)) return (empty(a.v) - empty(b.v)) || a.i - b.i; // пустые всегда внизу
      const d = typeof a.v === 'string' ? a.v.localeCompare(b.v, 'ru', { numeric: true }) : a.v - b.v;
      return d * dir || a.i - b.i;
    }).map((x) => x.r);
  }
  return { rows: out, errors };
}
