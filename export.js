// Выгрузка в Excel всего, что загружено и посчитано: сводка, округа, районы, дома с координатами.

import { fmt, download } from './ui.js';
import { buildXlsx } from './core/xlsxwrite.js';
import { Q } from './core/edc.js';
import { okrugByCode, NO_OKRUG, OKRUG_CODES } from './core/okrugs.js';
import {
  kpiOf, emptyKpi, addToKpi, finalizeKpi, metricValue, houseStatus, HS_LABEL, HS_HINT, MATCH_LABEL, COV_LABEL, NA_REASON,
} from './analytics.js';

const GEO_SOURCE = { manual: 'вручную', verified: 'проверено', auto: 'геокодер, требует проверки', imported: 'из файла', osm: 'OpenStreetMap', yandex: 'Яндекс Геокодер', mosreg: 'Адресный реестр Москвы' };

/** Столбцы показателей группы (округа или района). */
const GROUP_COLUMNS = [
  ['Домов МЖИ', 'int', (k) => k.mkd],
  ['Обслуживаются', 'int', (k) => (k.hasEdc ? k.served : null)],
  ['% обслуживается', 'pct', (k) => k.servedShare],
  ['Все подъезды', 'int', (k) => (k.hasEdc ? k.hs.full : null)],
  ['Часть подъездов', 'int', (k) => (k.hasEdc ? k.hs.partial : null)],
  ['Не обслуживаются', 'int', (k) => (k.hasEdc ? k.hs.none : null)],
  ['из них нет в ЕДЦ', 'int', (k) => (k.hasEdc ? k.notInEdc : null)],
  ['Нет данных', 'int', (k) => (k.hasEdc ? k.hs.unknown : null)],
  ['Неактуальные или нежилые', 'int', (k) => (k.hasEdc ? k.hs.excluded : null)],
  ['Подъездов', 'int', (k) => (k.hasEdc ? k.entrTotal : null)],
  ['Подъездов обслуживается', 'int', (k) => (k.hasEdc ? k.entrLinked : null)],
  ['% подъездов', 'pct', (k) => k.entrShare],
  ['Заявок 2026', 'int', (k) => (k.hasEdc ? k.req.total : null)],
  ['I кв.', 'int', (k) => (k.hasEdc ? k.req.q1 : null)],
  ['II кв.', 'int', (k) => (k.hasEdc ? k.req.q2 : null)],
  ['III кв.', 'int', (k) => (k.hasEdc ? k.req.q3 : null)],
  ['IV кв. (неполный)', 'int', (k) => (k.hasEdc ? k.req.q4 : null)],
  ['Без даты закрытия', 'int', (k) => (k.hasEdc ? k.req.open : null)],
  ['Критических', 'int', (k) => (k.hasEdc ? k.req.critical : null)],
  ['Заявок на обслуживаемый дом', 'num1', (k) => metricValue(k, 'reqPerHouse')],
  ['% домов с заявками', 'pct', (k) => k.activeShare],
  ['С координатами', 'int', (k) => k.geo],
];

function groupSheet(name, keyCols, groups) {
  return {
    name,
    columns: [...keyCols.map(([header, width]) => ({ header, width })), ...GROUP_COLUMNS.map(([header, f]) => ({ header, fmt: f, width: header.length > 14 ? 16 : 12 }))],
    rows: groups.map((g) => [...g.keys, ...GROUP_COLUMNS.map(([, , v]) => v(g.k))]),
  };
}

/**
 * Собрать книгу Excel.
 * @param {object} p {rows, geo: Map, scope: string, dates: {mji, edc}}
 */
export function buildWorkbook({ rows, geo, scope, dates }) {
  const geoSet = new Set(geo.keys());
  const k = kpiOf(rows, geoSet);
  const okr = new Map();
  const areas = new Map();
  for (const r of rows) {
    const o = r.okrug || NO_OKRUG;
    if (!okr.has(o)) okr.set(o, emptyKpi());
    addToKpi(okr.get(o), r, geoSet);
    const ak = `${o}|${r.area || ''}`;
    if (!areas.has(ak)) areas.set(ak, { okrug: o, area: r.area || '(район не указан)', k: emptyKpi() });
    addToKpi(areas.get(ak).k, r, geoSet);
  }
  const order = (c) => { const i = OKRUG_CODES.indexOf(c); return i === -1 ? 99 : i; };
  const okrugGroups = [...okr.entries()].sort((a, b) => order(a[0]) - order(b[0]))
    .map(([code, kk]) => ({ keys: [code, okrugByCode(code)?.full || code], k: finalizeKpi(kk) }));
  const areaGroups = [...areas.values()].sort((a, b) => order(a.okrug) - order(b.okrug) || a.area.localeCompare(b.area, 'ru'))
    .map((a) => ({ keys: [a.okrug, a.area], k: finalizeKpi(a.k) }));

  const line = (label, value, f = 'int', hint = '') => [label, { v: value, fmt: f }, hint];
  const summaryRows = [
    line('Область', scope, 'text'),
    line('Реестр МЖИ, дата среза', dates.mji || 'не загружен', 'text'),
    line('Выгрузки ЕДЦ, дата среза', dates.edc || 'не загружены', 'text'),
    line('Файл сформирован', fmt.dateTime(new Date().toISOString()), 'text'),
    line('Домов в реестре МЖИ', k.mkd),
    line(HS_LABEL.full, k.hs.full, 'int', HS_HINT.full),
    line(HS_LABEL.partial, k.hs.partial, 'int', HS_HINT.partial),
    line('Обслуживаются, но заявок 2026 нет', k.servedNoReq, 'int', 'Обслуживание настроено, а заявок по дому нет: нет обращений или заявки заведены на другую запись ЕДЦ.'),
    line(HS_LABEL.none, k.hs.none, 'int', HS_HINT.none),
    line('из них нет в ЕДЦ', k.notInEdc),
    line(HS_LABEL.unknown, k.hs.unknown, 'int', HS_HINT.unknown),
    line(HS_LABEL.excluded, k.hs.excluded, 'int', HS_HINT.excluded),
    line('Доля обслуживаемых домов', k.servedShare, 'pct'),
    line('Доля обслуживаемых подъездов', k.entrShare, 'pct'),
    line('Заявок 2026 (домовой уровень)', k.req.total),
    line('Заявок I квартал', k.req.q1), line('Заявок II квартал', k.req.q2), line('Заявок III квартал', k.req.q3), line('Заявок IV квартал (неполный)', k.req.q4),
    line('Заявок на обслуживаемый дом', metricValue(k, 'reqPerHouse'), 'num1'),
    line('Доля обслуживаемых домов с заявками', k.activeShare, 'pct'),
    line('Домов с координатами', k.geo),
  ];
  const summary = {
    name: 'Сводка', title: `Обслуживание домов в ЕДЦ и заявки 2026: ${scope}`, filter: false,
    columns: [{ header: 'Показатель', width: 44 }, { header: 'Значение', width: 18 }, { header: 'Пояснение', width: 100 }],
    rows: summaryRows,
  };

  const houseCols = [
    ['UNOM', 10], ['Код МЖИ', 10], ['Округ', 8], ['Район', 22], ['Адрес МЖИ', 48], ['ФИАС', 38], ['Управляющая организация', 34],
    ['Статус', 30], ['Сопоставление с ЕДЦ', 16], ['Способ', 9], ['Адрес ЕДЦ', 48], ['Тип дома ЕДЦ', 12], ['actual', 8],
    ['Настроек обслуживания', 12, 'int'], ['Подъездов', 10, 'int'], ['Подъездов обслуживается', 12, 'int'], ['Привязки подъездов', 26], ['Причина «нет данных»', 34],
    ['Заявок 2026', 10, 'int'], ['I кв.', 8, 'int'], ['II кв.', 8, 'int'], ['III кв.', 8, 'int'], ['IV кв. (неполный)', 10, 'int'],
    ['Без даты закрытия', 10, 'int'], ['Критических', 10, 'int'], ['Широта', 11], ['Долгота', 11], ['Источник координат', 20],
  ];
  const houses = {
    name: 'Дома',
    columns: houseCols.map(([header, width, f]) => ({ header, width, fmt: f || 'text' })),
    rows: rows.map((r) => {
      const g = geo.get(r.u);
      const q = r.q || null;
      const e = r.e;
      return [r.ur, r.code, r.okrug, r.area, r.address, r.fiasRaw, r.uk,
        HS_LABEL[houseStatus(r)], MATCH_LABEL[r.m] || r.m, { unom: 'УНОМ', fias: 'ФИАС', manual: 'вручную' }[r.mm] || '', e ? e.a : '', e ? e.ht : '', e ? String(e.ac) : '',
        e ? e.rel : null, e ? e.et : null, e ? Math.min(e.el, e.et) : null, COV_LABEL[r.cov] || '', NA_REASON[r.na] || '',
        q ? q[Q.total] : null, q ? q[Q.q1] : null, q ? q[Q.q2] : null, q ? q[Q.q3] : null, q ? q[Q.q4] : null, q ? q[Q.open] : null, q ? q[Q.critical] : null,
        g ? Number(g.lat.toFixed(6)) : null, g ? Number(g.lon.toFixed(6)) : null, g ? GEO_SOURCE[g.status] || g.status : ''];
    }),
  };
  return buildXlsx([
    summary,
    groupSheet('Округа', [['Округ', 8], ['Название', 36]], okrugGroups),
    groupSheet('Районы', [['Округ', 8], ['Район', 28]], areaGroups),
    houses,
  ]);
}

/** Скачать книгу Excel по текущей области. */
export function downloadWorkbook(p) {
  const bytes = buildWorkbook(p);
  const safe = p.scope.replace(/[^\wа-яё -]+/gi, '_').trim();
  download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    `Аналитика_покрытия_${safe}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  return bytes.length;
}
