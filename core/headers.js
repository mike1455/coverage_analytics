// Устойчивое сопоставление заголовков CSV с логическими полями.
// PostgreSQL обрезает псевдонимы колонок до 63 байт (≈31 кириллический символ), поэтому
// заголовок из файла может быть префиксом полного имени: «Последняя версия записи адреса (is_l».

import { normHeader } from './util.js';

const MIN_PREFIX = 8;

/**
 * @param {string[]} headers - заголовки из файла
 * @param {Object<string, string[]>} spec - логическое поле → варианты полного имени
 * @param {string[]} required - обязательные логические поля
 * @returns {{index: Object<string, number>, missing: string[], ambiguous: string[], unknown: string[]}}
 */
export function resolveColumns(headers, spec, required = []) {
  const hs = headers.map(normHeader);
  const index = {};
  const ambiguous = [];
  const claimed = new Map(); // headerIdx → field

  // 1) точные совпадения
  for (const [field, names] of Object.entries(spec)) {
    const ns = names.map(normHeader);
    const hit = hs.findIndex((h) => ns.includes(h));
    if (hit !== -1) { index[field] = hit; claimed.set(hit, field); }
  }
  // 2) усечённые заголовки: заголовок - префикс полного имени (и не занят точным совпадением)
  for (const [field, names] of Object.entries(spec)) {
    if (field in index) continue;
    const ns = names.map(normHeader);
    const hits = [];
    hs.forEach((h, i) => {
      if (claimed.has(i) || h.length < MIN_PREFIX) return;
      if (ns.some((n) => n.startsWith(h))) hits.push(i);
    });
    if (hits.length === 1) {
      // заголовок не должен одновременно быть префиксом другого поля спецификации
      const h = hs[hits[0]];
      const rivals = Object.entries(spec).filter(([f, names2]) => f !== field && !(f in index) &&
        names2.map(normHeader).some((n) => n.startsWith(h)));
      if (rivals.length) { ambiguous.push(`${headers[hits[0]]}: подходит к ${[field, ...rivals.map((r) => r[0])].join(', ')}`); continue; }
      index[field] = hits[0];
      claimed.set(hits[0], field);
    } else if (hits.length > 1) {
      ambiguous.push(`${field}: ${hits.map((i) => headers[i]).join(' | ')}`);
    }
  }
  const missing = required.filter((f) => !(f in index));
  const unknown = headers.filter((h, i) => !claimed.has(i));
  return { index, missing, ambiguous, unknown };
}

export function getter(index) {
  return (row, field) => {
    const i = index[field];
    if (i === undefined) return '';
    const v = row[i];
    return v === undefined || v === null ? '' : String(v).trim();
  };
}
