// Выгрузки ЕДЦ: SQL № 2 (дома), № 3 (подъезды), № 4 (агрегаты заявок 2026) и
// объединённые CSV из merge_edc_houses.py / merge_edc_entrances.py (инструкция S2).
// Алгоритм объединения повторяет S2 один в один - см. tests/parity.test.mjs.

import { resolveColumns, getter } from './headers.js';
import {
  normUuid, normUnom, normFias, parseBool, parseCount, lowerYo, recordHash, dateKey, ImportError, fnv1a,
} from './util.js';
import { ob, htNorm } from './compact.js';

export const STATS_COLUMNS = [
  'Заявок 2026 всего',
  'Заявок 2026 с датой закрытия',
  'Заявок 2026 без даты закрытия',
  'Критических заявок 2026',
  'Заявок без корневого ID адреса',
  'Заявок без корневого ID подъезда',
  'Заявок I квартал 2026',
  'Заявок II квартал 2026',
  'Заявок III квартал 2026',
  'Заявок IV квартал 2026',
];
export const LAST_DATE_COLUMN = 'Дата последней заявки в 2026';
// Индексы в массиве q
export const Q = { total: 0, closed: 1, open: 2, critical: 3, noRootAddr: 4, noRootEntr: 5, q1: 6, q2: 7, q3: 8, q4: 9 };

const STATS_SPEC = Object.fromEntries(STATS_COLUMNS.map((c, i) => [`n${i}`, [c]]));
const STATS_FIELDS = STATS_COLUMNS.map((c, i) => `n${i}`);

export const MERGED_SPEC = {
  m_method: ['Статистика 2026: способ сопоставления'],
  m_groups: ['Статистика 2026: групп сопоставлено'],
  m_unom: ['Статистика 2026: УНОМ из заявок'],
  m_mismatch: ['Статистика 2026: расхождение УНОМ'],
  ...STATS_SPEC,
  last: [LAST_DATE_COLUMN],
};

const ADDRESS_SPEC = {
  address: ['Адрес'],
  unom: ['УНОМ'],
  fias: ['ФИАС'],
  root: ['Корневой ID адреса'],
  rec: ['ID записи адреса'],
  type: ['Тип дома (house_type из ЕДЦ)'],
  affiliation: ['Принадлежность (affiliation из ЕДЦ)'],
  isLast: ['Последняя версия записи адреса (is_last)'],
  actual: ['Актуальность адресного объекта (actual)'],
  resHT: ['Жилой по house_type (предварительно)'],
  resActual: ['Жилой и актуальный по ЕДЦ (предварительно)'],
  hasAddr: ['Есть текстовый адрес'],
  editDate: ['Дата изменения адресной записи'],
};

export const HOUSES_SPEC = {
  ...ADDRESS_SPEC,
  hasSetting: ['Есть настройка обслуживания ЕДЦ'],
  relCount: ['Количество настроек обслуживания'],
  orgCount: ['Количество организаций'],
  orgIds: ['Перечень организаций (UUID через ;)'],
  authCount: ['Количество полномочий'],
  authIds: ['Перечень полномочий (UUID через ;)'],
  paidCount: ['Количество платных дефектов из списка 30'],
  paidIds: ['Перечень ID платных дефектов через ;'],
  allFlag: ['Признак обслуживания всех подъездов'],
  entrTotal: ['Количество подъездов в реестре ЕДЦ'],
  entrActTrue: ['Подъездов actual=true (если поле существует)'],
  entrActFalse: ['Подъездов actual=false (если поле существует)'],
  entrActUnknown: ['Подъездов с неизвестным actual'],
  entrLinked: ['Подъездов с найденной привязкой'],
  entrUnlinked: ['Подъездов без найденной привязки'],
  servedList: ['Подъезды с привязкой через ;'],
  unservedList: ['Подъезды без найденной привязки через ;'],
  coverageText: ['Покрытие подъездов по данным ЕДЦ'],
};
export const HOUSES_REQUIRED = ['address', 'unom', 'root', 'rec', 'type', 'actual', 'entrTotal', 'entrLinked'];

export const ENTRANCES_SPEC = {
  ...ADDRESS_SPEC,
  label: ['Подъезд (номер либо ID)'],
  eroot: ['Корневой ID подъезда'],
  eIsLast: ['is_last подъезда (если поле существует)'],
  eActual: ['actual подъезда (если поле существует)'],
  eStatus: ['Статус обслуживания подъезда (по данным ЕДЦ)'],
  eRelCount: ['Количество настроек обслуживания подъезда'],
  eOrgCount: ['Количество организаций подъезда'],
  eOrgIds: ['Организации подъезда (UUID через ;)'],
  eAuthIds: ['Полномочия подъезда (UUID через ;)'],
  ePaidCount: ['Платных дефектов подъезда из списка 30'],
  ePaidIds: ['ID платных дефектов подъезда через ;'],
  eBasis: ['Основание обслуживания подъезда'],
};
export const ENTRANCES_REQUIRED = ['unom', 'root', 'rec', 'eroot', 'label'];

export const REQUESTS_SPEC = {
  level: ['Уровень агрегации'],
  akey: ['ID адреса для сопоставления'],
  atype: ['Тип ключа адреса'],
  ekey: ['Ключ подъезда для сопоставления'],
  etype: ['Тип ключа подъезда'],
  unoms: ['УНОМ из заявок'],
  ...STATS_SPEC,
  last: [LAST_DATE_COLUMN],
};
export const REQUESTS_REQUIRED = Object.keys(REQUESTS_SPEC);

/** Определение типа файла по заголовкам. */
export function detectKind(header) {
  const hs = header.map((h) => lowerYo(h).replace(/^﻿/, ''));
  const has = (s) => hs.some((h) => h === lowerYo(s));
  const pre = (s) => hs.some((h) => h.startsWith(lowerYo(s)) || lowerYo(s).startsWith(h) && h.length >= 8);
  const merged = has('Статистика 2026: способ сопоставления');
  // Выгрузки, которые для импорта не нужны (контрольные SQL № 1 и № 5, отдельная выборка SQL № 6)
  if (has('Тип дома в ЕДЦ (house_type)') || pre('Число последних версий адресных записей')) return 'sql1';
  if (has('Взято строк привязок')) return 'sql5';
  if (has('Есть привязка платного дефекта') || (has('ID платных дефектов') && has('ID обслуживающих организаций'))) return 'sql6';
  if (has('Уровень агрегации') && has('ID адреса для сопоставления')) return 'requests';
  if (has('Корневой ID подъезда') && has('Подъезд (номер либо ID)')) return merged ? 'entrances_merged' : 'entrances';
  if (has('Корневой ID адреса') && pre('Количество подъездов в реестре ЕДЦ')) return merged ? 'houses_merged' : 'houses';
  if ((has('UNOM') || has('УНОМ')) && has('Округ')) return 'mji';
  return 'unknown';
}

export const KIND_LABEL = {
  mji: 'Реестр МЖИ',
  houses: 'SQL № 2, все адреса (01_дома.csv)',
  entrances: 'SQL № 3, адреса и подъезды (02_подъезды.csv)',
  requests: 'SQL № 4, заявки 2026 (03_заявки_2026.csv)',
  houses_merged: 'Объединённый «Дома_ЕДЦ_2026_с_заявками.csv»',
  entrances_merged: 'Объединённый «Подъезды_ЕДЦ_2026_с_заявками.csv»',
  geo: 'Геоданные (CSV/GeoJSON)',
  sql1: 'SQL № 1, контрольный, для импорта не нужен',
  sql5: 'SQL № 5, контрольный, для импорта не нужен',
  sql6: 'SQL № 6, платные дефекты, для импорта не нужен',
  doc: 'Документ, для импорта не нужен',
  unknown: 'Не распознан',
};

/** Файлы, которые мастер импорта пропускает с пояснением (а не считает ошибкой). */
export const SKIP_KINDS = new Set(['sql1', 'sql5', 'sql6', 'doc']);

// ---------- ключи (как в S2) ----------

export function addressKeys(root, rec) {
  const keys = [];
  if (root) keys.push(['address.root_id', root]);
  if (rec) keys.push(['address.id', rec]);
  return keys;
}

export function statsAddressKind(v) {
  const val = String(v || '').trim().toLowerCase();
  if (val === 'address.root_id') return 'address.root_id';
  if (val.startsWith('address.id')) return 'address.id';
  return 'UNSUPPORTED:' + String(v || '').trim();
}

export function statsEntranceKind(v) {
  const val = lowerYo(v);
  if (val === 'entrances.root_id') return 'entrances.root_id';
  if (val.startsWith('entrances.id')) return 'entrances.id';
  if (val === 'только номер подъезда') return 'NUMBER';
  if (val === 'подъезд не указан') return 'UNKNOWN';
  return 'UNSUPPORTED:' + String(v || '').trim();
}

export function cleanEntranceNumber(v) {
  return String(v || '').trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}

export const isIdLabel = (label) => !label || String(label).startsWith('[ID подъезда:');

// ---------- индекс агрегатов заявок (аналог StatsDB из S2) ----------

export class RequestIndex {
  constructor() {
    this.recs = []; // {level, at, ak, et, ek, unom, last, n:[10]}
    this.map = { 'Дом': new Map(), 'Подъезд': new Map() };
    this.used = new Set();
    this.loaded = { 'Дом': 0, 'Подъезд': 0 };
    this.otherLevel = 0;
    this.noAddressKey = 0;
    this.byKeyType = new Map();
    this.cols = null;
    this.rawKeys = new Map(); // ключ → отпечаток всей строки и её номер (чтобы отличить повтор строки от другого написания)
    this.mergedVariants = 0;
    this.mergedExamples = [];
  }

  setHeader(header) {
    this.cols = resolveColumns(header, REQUESTS_SPEC, REQUESTS_REQUIRED);
    if (this.cols.missing.length) {
      throw new ImportError(`В CSV заявок (SQL № 4) нет обязательных колонок: ${this.cols.missing.map((f) => REQUESTS_SPEC[f][0]).join('; ')}`);
    }
    this.g = getter(this.cols.index);
    this.width = header.length;
  }

  addRow(row, line) {
    const g = this.g;
    if (row.length > this.width) {
      throw new ImportError(`Строка ${line} в CSV заявок имеет больше полей, чем заголовок. Проверьте разделитель.`);
    }
    const level = g(row, 'level');
    if (level !== 'Дом' && level !== 'Подъезд') { this.otherLevel++; return; }
    const at = statsAddressKind(g(row, 'atype'));
    const ak = normUuid(g(row, 'akey'));
    let et = '';
    let ek = '';
    if (level === 'Подъезд') {
      et = statsEntranceKind(g(row, 'etype'));
      ek = g(row, 'ekey');
      if (et === 'NUMBER') ek = cleanEntranceNumber(ek.toUpperCase().startsWith('NUMBER:') ? ek.slice(7) : ek);
      else if (et === 'entrances.root_id' || et === 'entrances.id') ek = normUuid(ek);
    }
    if (!ak) this.noAddressKey++;
    const n = STATS_FIELDS.map((f, i) => parseCount(g(row, f), STATS_COLUMNS[i], line));
    const key = level === 'Дом' ? `${at}\u0001${ak}` : `${at}\u0001${ak}\u0001${et}\u0001${ek}`;
    const joined = row.join('\u0001');
    const fp = `${fnv1a(joined)}.${joined.length}`;
    const m = this.map[level];
    if (m.has(key)) {
      const [prevFp, prevLine] = this.rawKeys.get(key) || [];
      if (prevFp === fp) {
        throw new ImportError(`Строка ${line} в CSV заявок полностью повторяет ключ более ранней строки ${prevLine}: уровень=${level}, ` +
          `тип адреса=${at}, ID=${ak}, тип подъезда=${et}, ключ=${ek}. Похоже, файл содержит одну и ту же строку дважды: выгрузите SQL № 4 заново.`);
      }
      // Тот же подъезд или адрес, записанный иначе («1А» и «1а», лишний пробел, регистр UUID)
      // или разбитый SQL на несколько строк (например, по разным УНОМ): заявки складываются
      const r = this.recs[m.get(key)];
      for (let i = 0; i < n.length; i++) r.n[i] += n[i];
      const last = ob(g(row, 'last'));
      if (last > r.last) r.last = last;
      const un = ob(g(row, 'unoms'));
      if (un && !String(r.unom).split(/[,;]\s*/).includes(un)) r.unom = r.unom ? `${r.unom}, ${un}` : un;
      this.mergedVariants++;
      if (this.mergedExamples.length < 10) this.mergedExamples.push(`${level === 'Дом' ? ak : ek}: «${(level === 'Дом' ? g(row, 'akey') : g(row, 'ekey')).trim()}»`);
      return;
    }
    this.rawKeys.set(key, [fp, line]);
    const idx = this.recs.length;
    this.recs.push({ level, at, ak, et, ek, unom: ob(g(row, 'unoms')), last: ob(g(row, 'last')), n });
    m.set(key, idx);
    this.loaded[level]++;
    const kt = `${level}|${at}|${et}`;
    this.byKeyType.set(kt, (this.byKeyType.get(kt) || 0) + 1);
  }

  matchHouse(addrKeys) {
    const found = [];
    for (const [at, ak] of addrKeys) {
      const idx = this.map['Дом'].get(`${at}\u0001${ak}`);
      if (idx !== undefined && !found.includes(idx)) found.push(idx);
    }
    found.forEach((i) => this.used.add(i));
    return found.map((i) => this.recs[i]);
  }

  matchEntrance(addrKeys, et, ek) {
    const found = [];
    for (const [at, ak] of addrKeys) {
      const idx = this.map['Подъезд'].get(`${at}\u0001${ak}\u0001${et}\u0001${ek}`);
      if (idx !== undefined && !found.includes(idx)) found.push(idx);
    }
    found.forEach((i) => this.used.add(i));
    return found;
  }

  rec(i) { return this.recs[i]; }

  /** Несопоставленные агрегаты: по типам ключей, примеры (до 20), сумма заявок. */
  unmatchedReport(level) {
    const groups = new Map();
    const examples = [];
    let requests = 0;
    let count = 0;
    this.recs.forEach((r, i) => {
      if (r.level !== level || this.used.has(i)) return;
      count++;
      requests += r.n[0];
      const k = `${r.at} / ${r.et || '(дом)'}`;
      const gr = groups.get(k) || { count: 0, requests: 0 };
      gr.count++; gr.requests += r.n[0];
      groups.set(k, gr);
      if (examples.length < 20) examples.push(`${r.at} | ${r.ak} | ${r.et} | ${r.ek} | заявок: ${r.n[0]}`);
    });
    const usedAtLevel = [...this.used].filter((i) => this.recs[i].level === level).length;
    return {
      loaded: this.loaded[level], used: usedAtLevel, unmatched: count, unmatchedRequests: requests,
      groups: [...groups.entries()].sort((a, b) => b[1].count - a[1].count).map(([k, v]) => ({ key: k, ...v })),
      examples,
    };
  }

  /** Сумма заявок домового уровня во всём CSV (контроль: «всего заявок в выгрузке»). */
  houseLevelTotal() {
    let s = 0;
    for (const r of this.recs) if (r.level === 'Дом') s += r.n[0];
    return s;
  }
}

/** Сложение агрегатов: как combine_statistics в S2. */
export function combineStatistics(recs, inputUnom) {
  const totals = new Array(STATS_COLUMNS.length).fill(0);
  let latest = '';
  const unoms = new Set();
  for (const r of recs) {
    r.n.forEach((v, i) => { totals[i] += v; });
    if (r.last && (!latest || dateKey(r.last) > dateKey(latest))) latest = r.last;
    for (const c of String(r.unom || '').split(';')) if (c.trim()) unoms.add(c.trim());
  }
  const normSet = new Set([...unoms].map(normUnom));
  const mismatch = !!(inputUnom && unoms.size && !normSet.has(normUnom(inputUnom)));
  return { totals, latest, unoms: [...unoms].sort().join('; '), mismatch };
}

// ---------- компактные записи для IndexedDB ----------

function baseAddress(g) {
  const root = normUuid(g('root'));
  const rec = normUuid(g('rec'));
  const f = normFias(g('fias'));
  return {
    r: root || rec,
    ro: root,
    i: rec,
    un: normUnom(g('unom')),
    ur: ob(g('unom')),
    fi: f.value,
    fr: f.raw,
    a: g('address'),
    ht: g('type'),
    htn: htNorm(g('type')),
    af: g('affiliation'),
    il: parseBool(g('isLast')),
    ac: parseBool(g('actual')),
    ed: ob(g('editDate')),
  };
}

/** Читатель строк «домов» (SQL № 2 или объединённый). */
export function houseReader(header, merged) {
  const spec = merged ? { ...HOUSES_SPEC, ...MERGED_SPEC } : HOUSES_SPEC;
  const required = merged ? [...HOUSES_REQUIRED, ...Object.keys(MERGED_SPEC)] : HOUSES_REQUIRED;
  const cols = resolveColumns(header, spec, required);
  if (cols.missing.length) {
    throw new ImportError(`В CSV домов нет обязательных колонок: ${cols.missing.map((f) => spec[f][0]).join('; ')}.` +
      (merged ? ' Ожидался объединённый файл (merge_edc_houses.py).' : ''));
  }
  if (!merged && Object.keys(MERGED_SPEC).some((f) => cols.index[f] !== undefined)) {
    throw new ImportError('CSV домов уже содержит колонки статистики. Это объединённый файл, выберите режим «2 объединённых CSV».');
  }
  const gi = getter(cols.index);
  const width = header.length;
  return {
    cols,
    read(row, line) {
      if (row.length > width) throw new ImportError(`Строка ${line} CSV домов содержит лишние колонки. Проверьте разделитель/кавычки.`);
      const g = (f) => gi(row, f);
      const rec = baseAddress(g);
      if (!rec.r) throw new ImportError(`Дом в строке ${line} без «Корневой ID адреса» и «ID записи адреса».`);
      Object.assign(rec, {
        rel: parseCount(g('relCount'), 'Количество настроек обслуживания', line),
        org: parseCount(g('orgCount'), 'Количество организаций', line),
        au: parseCount(g('authCount'), 'Количество полномочий', line),
        pd: parseCount(g('paidCount'), 'Количество платных дефектов', line),
        pids: ob(g('paidIds')),
        allf: g('allFlag'),
        et: parseCount(g('entrTotal'), 'Количество подъездов в реестре ЕДЦ', line),
        eat: parseCount(g('entrActTrue'), 'Подъездов actual=true', line),
        eaf: parseCount(g('entrActFalse'), 'Подъездов actual=false', line),
        eau: parseCount(g('entrActUnknown'), 'Подъездов с неизвестным actual', line),
        el: parseCount(g('entrLinked'), 'Подъездов с найденной привязкой', line),
        eu: parseCount(g('entrUnlinked'), 'Подъездов без найденной привязки', line),
        ct: g('coverageText'),
      });
      if (rec.el > rec.et) throw new ImportError(`Строка ${line}: подъездов с привязкой (${rec.el}) больше, чем подъездов всего (${rec.et}).`);
      if (merged) Object.assign(rec, mergedStats(g, line));
      return rec;
    },
  };
}

/** Читатель строк подъездов (SQL № 3 или объединённый). */
export function entranceReader(header, merged) {
  const spec = merged ? { ...ENTRANCES_SPEC, ...MERGED_SPEC } : ENTRANCES_SPEC;
  const required = merged ? [...ENTRANCES_REQUIRED, ...Object.keys(MERGED_SPEC)] : ENTRANCES_REQUIRED;
  const cols = resolveColumns(header, spec, required);
  if (cols.missing.length) {
    throw new ImportError(`В CSV подъездов нет обязательных колонок: ${cols.missing.map((f) => spec[f][0]).join('; ')}.` +
      (merged ? ' Ожидался объединённый файл (merge_edc_entrances.py).' : ''));
  }
  if (!merged && Object.keys(MERGED_SPEC).some((f) => cols.index[f] !== undefined)) {
    throw new ImportError('CSV подъездов уже содержит колонки статистики. Это объединённый файл, выберите режим «2 объединённых CSV».');
  }
  const gi = getter(cols.index);
  const width = header.length;
  return {
    cols,
    read(row, line) {
      if (row.length > width) throw new ImportError(`Строка ${line} CSV подъездов содержит лишние колонки. Проверьте разделитель/кавычки.`);
      const g = (f) => gi(row, f);
      const root = normUuid(g('root'));
      const recId = normUuid(g('rec'));
      const label = g('label');
      const e = {
        h: root || recId,
        ro: root,
        i: recId,
        un: normUnom(g('unom')),
        ur: ob(g('unom')),
        a: g('address'),
        e: normUuid(g('eroot')),
        lb: label,
        num: !isIdLabel(label),
        eil: g('eIsLast'),
        eac: g('eActual'),
        st: g('eStatus'),
        rel: parseCount(g('eRelCount'), 'Количество настроек обслуживания подъезда', line),
        org: parseCount(g('eOrgCount'), 'Количество организаций подъезда', line),
        pd: parseCount(g('ePaidCount'), 'Платных дефектов подъезда', line),
        pids: g('ePaidIds'),
        bs: g('eBasis'),
      };
      if (!e.h) throw new ImportError(`Подъезд в строке ${line} без ключа адреса.`);
      if (merged) Object.assign(e, mergedStats(g, line));
      return e;
    },
  };
}

function mergedStats(g, line) {
  return {
    q: STATS_FIELDS.map((f, i) => parseCount(g(f), STATS_COLUMNS[i], line)),
    qd: ob(g('last')),
    qm: g('m_method'),
    qg: parseCount(g('m_groups'), 'Статистика 2026: групп сопоставлено', line),
    qu: ob(g('m_unom')),
    qx: lowerYo(g('m_mismatch')) === 'да',
  };
}

/** Применить найденные агрегаты к записи (аналог extras() в S2). */
export function applyStats(rec, recs, status, inputUnom) {
  const c = combineStatistics(recs, inputUnom);
  rec.q = c.totals;
  rec.qd = c.latest;
  rec.qm = status;
  rec.qg = recs.length;
  rec.qu = c.unoms;
  rec.qx = c.mismatch;
  return rec;
}

/** Объединение одного дома по правилам merge_edc_houses.py. */
export function mergeHouse(rec, index) {
  const found = index.matchHouse(addressKeys(rec.ro, rec.i));
  return applyStats(rec, found, found.length ? 'Совпало по UUID адреса' : 'Не найдено агрегата по UUID адреса', rec.ur);
}

/**
 * Объединение одного подъезда по правилам merge_edc_entrances.py.
 * numberCounts - Map `${type}|${key}|${number}` → количество (только при matchByNumber).
 */
export function mergeEntrance(e, index, { matchByNumber = false, numberCounts = null, counters = null } = {}) {
  const addr = addressKeys(e.ro, e.i);
  const ctr = counters || {};
  if (!e.e) {
    ctr.stub = (ctr.stub || 0) + 1;
    return applyStats(e, [], 'Нет подъезда в реестре: статистика не распределяется', e.ur);
  }
  const uuidIdx = index.matchEntrance(addr, 'entrances.root_id', e.e);
  const all = [...uuidIdx];
  if (uuidIdx.length) ctr.uuid = (ctr.uuid || 0) + 1;
  if (matchByNumber && e.lb && !isIdLabel(e.lb)) {
    const number = cleanEntranceNumber(e.lb);
    if (number && addr.every(([a, k]) => (numberCounts.get(`${a}|${k}|${number}`) || 0) === 1)) {
      const numbered = index.matchEntrance(addr, 'NUMBER', number).filter((i) => !all.includes(i));
      all.push(...numbered);
      if (numbered.length) ctr.number = (ctr.number || 0) + 1;
    } else {
      ctr.ambiguous = (ctr.ambiguous || 0) + 1;
    }
  }
  let status;
  if (uuidIdx.length && all.length > uuidIdx.length) status = 'UUID подъезда + уникальный номер (номер проверять)';
  else if (uuidIdx.length) status = 'Совпало по UUID подъезда';
  else if (all.length) status = 'Только уникальный номер подъезда (условно)';
  else if (matchByNumber && isIdLabel(e.lb)) status = 'Нет UUID-агрегата; номер неизвестен';
  else status = 'Нет агрегата по UUID подъезда';
  return applyStats(e, all.map((i) => index.rec(i)), status, e.ur);
}

/** Подсчёт номеров подъездов в пределах дома (make_number_uniqueness в S2). */
export function countEntranceNumber(e, counts) {
  if (!e.e || isIdLabel(e.lb)) return;
  const number = cleanEntranceNumber(e.lb);
  for (const [t, k] of addressKeys(e.ro, e.i)) {
    const key = `${t}|${k}|${number}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
}

export function finalizeRecord(rec) {
  rec.hs = recordHash(rec);
  return rec;
}

export const EMPTY_Q = () => new Array(STATS_COLUMNS.length).fill(0);
