// Реестр МЖИ: разбор строк XLSX/CSV, нормализация, проверки качества.

import { resolveColumns, getter } from './headers.js';
import { normUnom, normFias, str } from './util.js';
import { normOkrug, NO_OKRUG } from './okrugs.js';

export const MJI_SPEC = {
  code: ['Код', 'code'],
  okrug: ['Округ', 'District', 'АО'],
  area: ['Район', 'Area', 'Район/поселение'],
  address: ['Наименование/адрес', 'Адрес', 'Наименование', 'Address'],
  fias: ['ФИАС', 'FIAS', 'Код ФИАС'],
  unom: ['UNOM', 'УНОМ'],
  uk: ['Управляющая организация', 'УО', 'Управляющая компания'],
};
export const MJI_REQUIRED = ['okrug', 'area', 'address', 'unom'];

/**
 * @param {string[]} header
 * @param {Iterable<{row:string[], line:number}>|string[][]} rows
 * @returns {{houses: object[], report: object}}
 */
export function parseMji(header, rows) {
  const cols = resolveColumns(header, MJI_SPEC, MJI_REQUIRED);
  if (cols.missing.length) {
    return {
      houses: [],
      report: fatal(`Нет обязательных колонок МЖИ: ${cols.missing.map((f) => MJI_SPEC[f][0]).join(', ')}. ` +
        `В файле: ${header.join(' | ')}`),
    };
  }
  const g = getter(cols.index);
  const houses = [];
  const byUnom = new Map();
  const dupUnom = [];
  const fiasCount = new Map();
  const r = {
    errors: [], warnings: [], rowsTotal: 0, noUnom: 0, noFias: 0, invalidFias: 0, invalidFiasExamples: [],
    noUk: 0, noOkrug: 0, unknownOkrug: [], noArea: 0, dupFiasValues: 0, dupFiasRows: 0,
    byOkrug: {}, areas: 0, columns: cols,
  };
  const areas = new Set();
  let line = 1;
  for (const row of rows) {
    line++;
    if (!row || row.every((c) => str(c) === '')) continue;
    r.rowsTotal++;
    const unomRaw = g(row, 'unom');
    const u = normUnom(unomRaw);
    const f = normFias(g(row, 'fias'));
    const okrugRaw = g(row, 'okrug');
    const okrug = normOkrug(okrugRaw);
    const area = g(row, 'area');
    const h = {
      u: u || `#line:${line}`,
      ur: unomRaw,
      code: g(row, 'code'),
      okrug: okrug || NO_OKRUG,
      okrugRaw,
      area: area || '',
      address: g(row, 'address'),
      fias: f.value,
      fiasRaw: f.raw,
      fiasValid: f.valid,
      uk: g(row, 'uk'),
      noUnom: !u,
      line,
    };
    if (!u) r.noUnom++;
    if (f.empty) r.noFias++;
    else if (!f.valid) {
      r.invalidFias++;
      if (r.invalidFiasExamples.length < 10) r.invalidFiasExamples.push(`${f.raw} (UNOM ${unomRaw || '-'})`);
    } else fiasCount.set(f.value, (fiasCount.get(f.value) || 0) + 1);
    if (!h.uk) r.noUk++;
    if (!okrugRaw) r.noOkrug++;
    else if (!okrug && !r.unknownOkrug.includes(okrugRaw)) r.unknownOkrug.push(okrugRaw);
    if (!area) r.noArea++;
    else areas.add(`${h.okrug}|${area}`);
    if (u) {
      if (byUnom.has(u)) dupUnom.push({ unom: unomRaw, lines: [byUnom.get(u).line, line] });
      else byUnom.set(u, h);
    }
    r.byOkrug[h.okrug] = (r.byOkrug[h.okrug] || 0) + 1;
    houses.push(h);
  }
  for (const n of fiasCount.values()) if (n > 1) { r.dupFiasValues++; r.dupFiasRows += n - 1; }
  r.areas = new Set([...areas].map((a) => a.split('|')[1])).size;
  // Помечаем дубли ФИАС: такой ФИАС нельзя использовать как ключ сопоставления.
  for (const h of houses) h.fiasDup = !!(h.fias && fiasCount.get(h.fias) > 1);

  if (r.rowsTotal === 0) r.errors.push('Файл МЖИ не содержит строк данных.');
  if (dupUnom.length) {
    r.errors.push(`UNOM повторяется в ${dupUnom.length} строках (первичный ключ МЖИ должен быть уникальным). ` +
      `Примеры: ${dupUnom.slice(0, 5).map((d) => `${d.unom} (строки ${d.lines.join(', ')})`).join('; ')}`);
  }
  if (r.noUnom) r.warnings.push(`${r.noUnom} строк без UNOM. Они сохраняются, но не участвуют в сопоставлении с ЕДЦ.`);
  if (r.noFias) r.warnings.push(`${r.noFias} строк без ФИАС.`);
  if (r.invalidFias) r.warnings.push(`${r.invalidFias} строк с некорректным ФИАС (не UUID), например: ${r.invalidFiasExamples.slice(0, 4).join('; ')}. Такие значения не используются как ключ.`);
  if (r.dupFiasValues) r.warnings.push(`${r.dupFiasValues} значений ФИАС повторяются (${r.dupFiasRows} повторных строк), по ним сопоставление по ФИАС не выполняется.`);
  if (r.noOkrug) r.warnings.push(`${r.noOkrug} строк без округа, они не включаются в рейтинг округа.`);
  if (r.unknownOkrug.length) r.warnings.push(`Нераспознанные значения округа: ${r.unknownOkrug.slice(0, 10).join(', ')}.`);
  if (r.noUk) r.warnings.push(`${r.noUk} строк без управляющей организации.`);
  return { houses, report: r };
}

function fatal(msg) {
  return { errors: [msg], warnings: [], rowsTotal: 0 };
}
