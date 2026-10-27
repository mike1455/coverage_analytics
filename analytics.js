// Аналитика: сопоставление МЖИ и ЕДЦ, классификация покрытия по привязкам ЕДЦ, KPI и рейтинги.
// Чистые функции без DOM - используются в Web Worker, в интерфейсе и в node-тестах.
//
// Ключевые правила (ТЗ §3):
//  • «Покрытие по привязкам ЕДЦ» ≠ «подтверждённое подключение». Флага подключения нет - метрика прокси.
//  • Оценённый дом = однозначно сопоставлен с ЕДЦ-записью, actual=true, house_type='Жилое', подъездов > 0.
//  • Заявки по округу = сумма агрегатов уровня «Дом». Уровни «Дом» и «Подъезд» никогда не складываются.
//  • Неизвестно ≠ нет: несопоставленные/конфликтные/без подъездов дома не считаются «неподключёнными».

import { Q } from './core/edc.js';
import { OKRUG_CODES, NO_OKRUG } from './core/okrugs.js';

export const MIN_SAMPLE = 30; // меньше - «малая выборка», место в рейтинге не присваивается

export const COV = { full: 'full', partial: 'partial', none: 'none', na: 'na', excluded: 'excluded' };

export const COV_LABEL = {
  full: 'Все подъезды с найденной привязкой',
  partial: 'Частичная привязка подъездов',
  none: 'Нет найденной привязки',
  na: 'Недостаточно данных',
  excluded: 'Неактуальный / нежилой по ЕДЦ',
};

export const NA_REASON = {
  no_edc: 'Данные ЕДЦ не загружены',
  no_unom: 'В МЖИ нет UNOM',
  not_matched: 'Не найден в ЕДЦ по УНОМ/ФИАС',
  conflict: 'Неоднозначное соответствие (несколько записей ЕДЦ)',
  override_none: 'Вручную: соответствия в ЕДЦ нет',
  override_missing: 'Ручное соответствие: записи нет в текущем снимке ЕДЦ',
  edc_not_last: 'Запись ЕДЦ не последняя версия (is_last не true)',
  edc_not_actual: 'Объект ЕДЦ неактуален (actual = false)',
  edc_actual_unknown: 'Актуальность объекта ЕДЦ неизвестна',
  edc_not_residential: 'Тип дома в ЕДЦ «Нежилое»',
  edc_type_unknown: 'Тип дома в ЕДЦ не «Жилое» (не установлен / иной)',
  no_entrances: 'В ЕДЦ нет записей о подъездах',
};

export const MATCH_LABEL = {
  matched: 'Сопоставлен',
  conflict: 'Конфликт',
  none: 'Не найден',
  no_edc: 'Нет данных ЕДЦ',
  override_none: 'Вручную: нет',
  override_missing: 'Ручное: запись отсутствует',
};

const EXCLUDED_REASONS = new Set(['edc_not_actual', 'edc_not_residential']);

// ---------- статус дома: обслуживается ли дом в ЕДЦ ----------
// Главная классификация интерфейса: зелёный - обслуживаются все подъезды, розовый - часть подъездов,
// красный - дом в ЕДЦ не обслуживается (его нет в выгрузке ЕДЦ или ни один подъезд не привязан).
// Активность (заявки) показывается отдельными показателями, а не цветом статуса.

export const HS_ORDER = ['full', 'partial', 'none', 'unknown', 'excluded'];

export const HS_LABEL = {
  full: 'Обслуживается в ЕДЦ',
  partial: 'Обслуживается часть подъездов',
  none: 'Не обслуживается в ЕДЦ',
  unknown: 'Нет данных',
  excluded: 'Неактуальный или нежилой',
};

export const HS_HINT = {
  full: 'Дом найден в ЕДЦ, все известные подъезды привязаны к обслуживанию (или подъезды не указаны, но у дома есть настройка обслуживания).',
  partial: 'Дом найден в ЕДЦ, к обслуживанию привязана только часть подъездов.',
  none: 'Дома нет в выгрузке ЕДЦ (по УНОМ и ФИАС) или ни один его подъезд не привязан к обслуживанию.',
  unknown: 'Выгрузки ЕДЦ не загружены, у дома несколько подходящих записей ЕДЦ или о нём мало данных.',
  excluded: 'В ЕДЦ адрес помечен неактуальным или нежилым.',
};

/** Статус дома для карты, сводки и таблиц. */
export function houseStatus(row) {
  if (row.m === 'none' || row.m === 'override_none') return 'none';
  if (row.m !== 'matched' || !row.e) return 'unknown';
  if (row.cov === COV.excluded) return 'excluded';
  if (row.cov === COV.full || row.cov === COV.partial || row.cov === COV.none) return row.cov;
  return row.e.rel > 0 ? 'full' : 'unknown'; // подъезды неизвестны: решает настройка обслуживания дома
}

export const isServed = (s) => s === 'full' || s === 'partial';

/** Обслуживается, но заявок 2026 года по дому нет (стоит проверить: нет обращений или заявки на другой записи ЕДЦ). */
export const servedNoRequests = (row) => isServed(houseStatus(row)) && !(row.q && row.q[Q.total] > 0);

/**
 * Краткая сводка записи ЕДЦ для кэша сопоставления (таблицы, фильтры, KPI, экспорт).
 * Полную запись карточка дома запрашивает у worker отдельно, поэтому кэш остаётся компактным.
 */
export function edcSummary(e) {
  return {
    r: e.r, ro: e.ro, i: e.i, un: e.un, ur: e.ur, a: e.a, ht: e.ht, htn: e.htn, il: e.il, ac: e.ac,
    rel: e.rel, et: e.et, el: e.el, q: e.q,
  };
}

/** Прозрачное правило выбора записи ЕДЦ среди кандидатов с одним УНОМ/ФИАС. */
export function pickCandidate(cands) {
  if (cands.length === 1) return { pick: cands[0], rule: 'единственная запись ЕДЦ' };
  const act = cands.filter((c) => c.ac === true);
  if (act.length === 1) return { pick: act[0], rule: `единственная актуальная из ${cands.length} записей` };
  if (act.length > 1) {
    const res = act.filter((c) => c.htn === 'жилое');
    if (res.length === 1) return { pick: res[0], rule: `единственная актуальная жилая из ${cands.length} записей` };
    return { pick: null, rule: `${act.length} актуальных записей ЕДЦ, нужен ручной выбор` };
  }
  return { pick: null, rule: `${cands.length} записей ЕДЦ, ни одна не актуальна, нужен ручной выбор` };
}

/** Классификация покрытия для сопоставленного дома. */
export function classify(e) {
  if (e.il === false) return { cov: COV.na, na: 'edc_not_last' };
  if (e.ac === false) return { cov: COV.excluded, na: 'edc_not_actual' };
  if (e.ac !== true) return { cov: COV.na, na: 'edc_actual_unknown' };
  if (e.htn === 'нежилое') return { cov: COV.excluded, na: 'edc_not_residential' };
  if (e.htn !== 'жилое') return { cov: COV.na, na: 'edc_type_unknown' };
  if (!(e.et > 0)) return { cov: COV.na, na: 'no_entrances' };
  if (e.el >= e.et) return { cov: COV.full, na: '' };
  if (e.el > 0) return { cov: COV.partial, na: '' };
  return { cov: COV.none, na: '' };
}

/**
 * Сопоставление МЖИ и ЕДЦ. Использование:
 *   const j = new Joiner(mjiHouses); for (const e of edc) j.consider(e); const res = j.finish(overrides, overrideRecs);
 */
export class Joiner {
  constructor(mji) {
    this.mji = mji;
    this.byUnom = new Map();
    this.byFias = new Map();
    mji.forEach((h, i) => {
      if (!h.noUnom) this.byUnom.set(h.u, i);
      if (h.fias && h.fiasValid && !h.fiasDup) this.byFias.set(h.fias, i);
    });
    this.candU = new Map();
    this.candF = new Map();
    this.edcUnomCount = new Map();
    this.st = {
      edcHouses: 0, actualTrue: 0, actualFalse: 0, actualNull: 0,
      typeRes: 0, typeNonRes: 0, typeOther: 0, typeEmpty: 0, residentialActual: 0,
      noUnom: 0, withSetting: 0, entrances: 0, entrancesLinked: 0,
      requestsAll: 0, requestsMatchedRows: 0, unomMismatch: 0,
      matchedToMji: 0, requestsOnMji: 0, requestsOnConflict: 0, requestsOutsideMji: 0,
      residentialActualOutsideMji: 0,
    };
    this.hasEdc = false;
  }

  consider(e) {
    this.hasEdc = true;
    const st = this.st;
    st.edcHouses++;
    if (e.ac === true) st.actualTrue++; else if (e.ac === false) st.actualFalse++; else st.actualNull++;
    if (e.htn === 'жилое') st.typeRes++; else if (e.htn === 'нежилое') st.typeNonRes++; else if (e.htn) st.typeOther++; else st.typeEmpty++;
    if (e.ac === true && e.htn === 'жилое' && e.il !== false) st.residentialActual++;
    if (e.rel > 0) st.withSetting++;
    st.entrances += e.et || 0;
    st.entrancesLinked += e.el || 0;
    const req = e.q ? e.q[Q.total] : 0;
    st.requestsAll += req;
    if (e.qg > 0) st.requestsMatchedRows++;
    if (e.qx) st.unomMismatch++;
    if (!e.un) st.noUnom++;
    else this.edcUnomCount.set(e.un, (this.edcUnomCount.get(e.un) || 0) + 1);
    let hit = false;
    if (e.un) {
      const i = this.byUnom.get(e.un);
      if (i !== undefined) { push(this.candU, i, edcSummary(e)); hit = true; }
    }
    if (e.fi) {
      const i = this.byFias.get(e.fi);
      if (i !== undefined) { push(this.candF, i, edcSummary(e)); hit = true; }
    }
    if (!hit) {
      st.requestsOutsideMji += req;
      if (e.ac === true && e.htn === 'жилое') st.residentialActualOutsideMji++;
    }
  }

  /**
   * @param {Map<string,{r:string|null}>} overrides - UNOM → ручной выбор (r=null - «нет соответствия»)
   * @param {Map<string,object>} overrideRecs - r → запись ЕДЦ для ручных выборов
   */
  finish(overrides = new Map(), overrideRecs = new Map()) {
    const rows = [];
    const usedBy = new Map(); // r → индекс строки
    const claimedByUnom = (e, idx) => e.un && this.byUnom.has(e.un) && this.byUnom.get(e.un) !== idx;
    this.mji.forEach((h, idx) => {
      const row = baseRow(h);
      const ov = overrides.get(h.u);
      const cu = this.candU.get(idx) || [];
      const cf = (this.candF.get(idx) || []).filter((e) => !claimedByUnom(e, idx));
      row.mc = cu.length || cf.length;
      if (!this.hasEdc && !ov) {
        setNa(row, 'no_edc', 'no_edc');
      } else if (ov) {
        if (ov.r === null) setNa(row, 'override_none', 'override_none');
        else {
          const e = overrideRecs.get(ov.r) || [...cu, ...cf].find((c) => c.r === ov.r);
          if (!e) { setNa(row, 'override_missing', 'override_missing'); row.cands = [ov.r]; }
          else setMatch(row, edcSummary(e), 'manual', ov.reason || 'выбрано вручную');
        }
      } else if (h.noUnom && !cf.length) {
        setNa(row, 'none', 'no_unom');
      } else if (cu.length) {
        const p = pickCandidate(cu);
        if (p.pick) setMatch(row, p.pick, 'unom', p.rule);
        else { setNa(row, 'conflict', 'conflict'); row.mr = p.rule; row.cands = cu.map((c) => c.r); row.candRecs = cu; }
      } else if (cf.length) {
        const p = pickCandidate(cf);
        if (p.pick) setMatch(row, p.pick, 'fias', `ФИАС (резервный ключ): ${p.rule}` + (p.pick.ur ? `; УНОМ в ЕДЦ: ${p.pick.ur}` : ''));
        else { setNa(row, 'conflict', 'conflict'); row.mr = `ФИАС: ${p.rule}`; row.cands = cf.map((c) => c.r); row.candRecs = cf; }
      } else {
        setNa(row, 'none', 'not_matched');
      }
      if (row.e) {
        if (usedBy.has(row.e.r)) {
          // Одна запись ЕДЦ не может представлять два дома МЖИ: ручной выбор приоритетнее.
          const other = rows[usedBy.get(row.e.r)];
          const loser = row.mm === 'manual' && other.mm !== 'manual' ? other : row;
          const e = loser.e;
          setNa(loser, 'conflict', 'conflict');
          loser.mr = `запись ЕДЦ ${e.r} уже сопоставлена с другим UNOM`;
          loser.cands = [e.r];
          loser.candRecs = [e];
          if (loser === other) usedBy.set(row.e.r, rows.length);
        } else usedBy.set(row.e.r, rows.length);
      }
      rows.push(row);
    });
    // Итоговая статистика сопоставления по ЕДЦ
    const st = this.st;
    st.matchedToMji = 0; st.requestsOnMji = 0; st.requestsOnConflict = 0;
    for (const r of rows) {
      if (r.m === 'matched') { st.matchedToMji++; st.requestsOnMji += r.q ? r.q[Q.total] : 0; }
      if (r.m === 'conflict' && r.candRecs) {
        st.requestsOnConflict += r.candRecs.reduce((s, c) => s + (c.q ? c.q[Q.total] : 0), 0);
      }
    }
    st.edcUnomDupValues = 0; st.edcUnomDupRows = 0;
    for (const n of this.edcUnomCount.values()) if (n > 1) { st.edcUnomDupValues++; st.edcUnomDupRows += n - 1; }
    for (const r of rows) delete r.candRecs; // кандидаты по ключу r подгружаются в карточку отдельно
    return { rows, edcStats: this.hasEdc ? { ...st } : null };
  }
}

function push(map, k, v) {
  const a = map.get(k);
  if (a) a.push(v); else map.set(k, [v]);
}

function baseRow(h) {
  return {
    u: h.u, ur: h.ur, code: h.code, okrug: h.okrug, area: h.area, address: h.address,
    fias: h.fias, fiasRaw: h.fiasRaw, fiasValid: h.fiasValid, fiasDup: h.fiasDup, uk: h.uk, noUnom: h.noUnom,
    m: '', mm: '', mr: '', mc: 0, cands: null, e: null, q: null, cov: COV.na, na: '',
  };
}

function setNa(row, m, na) {
  row.m = m; row.na = na; row.cov = COV.na; row.e = null; row.q = null; row.mm = ''; row.mr = row.mr || '';
}

function setMatch(row, e, method, rule) {
  row.m = 'matched';
  row.mm = method;
  row.mr = rule;
  row.e = e;
  row.q = e.q || null;
  const c = classify(e);
  row.cov = c.cov;
  row.na = c.na;
}

// ---------- метрики ----------

export const REQ_METRICS = {
  total: { label: 'Все заявки 2026', idx: Q.total, quarters: true },
  open: { label: 'Без даты закрытия', idx: Q.open, quarters: false },
  critical: { label: 'Критические', idx: Q.critical, quarters: false },
};
export const QUARTERS = { '': 'Весь 2026 год', q1: 'I квартал', q2: 'II квартал', q3: 'III квартал', q4: 'IV квартал (частичный)' };

/** Значение заявок домового уровня для строки. Квартал допустим только для «всех заявок». */
export function reqValue(row, metric = 'total', quarter = '') {
  if (row.m !== 'matched' || !row.q) return 0;
  if (quarter) {
    if (!REQ_METRICS[metric].quarters) return null; // недоступная комбинация
    return row.q[Q[quarter]];
  }
  return row.q[REQ_METRICS[metric].idx];
}

export function emptyKpi() {
  return {
    mkd: 0, matched: 0, conflict: 0, notMatched: 0, evaluated: 0, full: 0, partial: 0, none: 0,
    na: {}, excluded: 0, entrTotal: 0, entrLinked: 0, geo: 0, reqHouses: 0,
    req: { total: 0, closed: 0, open: 0, critical: 0, q1: 0, q2: 0, q3: 0, q4: 0 },
    hs: { full: 0, partial: 0, none: 0, unknown: 0, excluded: 0 }, noEdc: 0, notInEdc: 0, servedActive: 0,
    rc: { total: 0, open: 0, critical: 0, q1: 0, q2: 0, q3: 0, q4: 0 }, // заявки обслуживаемых домов
  };
}

export function addToKpi(k, row, geoSet) {
  k.mkd++;
  if (row.m === 'matched') k.matched++;
  else if (row.m === 'conflict') k.conflict++;
  else k.notMatched++;
  if (row.cov === COV.full || row.cov === COV.partial || row.cov === COV.none) {
    k.evaluated++;
    k[row.cov]++;
    k.entrTotal += row.e.et;
    k.entrLinked += Math.min(row.e.el, row.e.et);
  } else {
    if (row.cov === COV.excluded) k.excluded++;
    if (row.na) k.na[row.na] = (k.na[row.na] || 0) + 1;
  }
  if (row.m === 'matched' && row.q) {
    const q = row.q;
    k.req.total += q[Q.total]; k.req.closed += q[Q.closed]; k.req.open += q[Q.open]; k.req.critical += q[Q.critical];
    k.req.q1 += q[Q.q1]; k.req.q2 += q[Q.q2]; k.req.q3 += q[Q.q3]; k.req.q4 += q[Q.q4];
    if (q[Q.total] > 0) k.reqHouses++;
  }
  const hs = houseStatus(row);
  k.hs[hs]++;
  if (row.m === 'no_edc') k.noEdc++;
  if (row.m === 'none' || row.m === 'override_none') k.notInEdc++;
  if (isServed(hs) && row.q) {
    const q = row.q;
    if (q[Q.total] > 0) k.servedActive++;
    k.rc.total += q[Q.total]; k.rc.open += q[Q.open]; k.rc.critical += q[Q.critical];
    k.rc.q1 += q[Q.q1]; k.rc.q2 += q[Q.q2]; k.rc.q3 += q[Q.q3]; k.rc.q4 += q[Q.q4];
  }
  if (geoSet && geoSet.has(row.u)) k.geo++;
  return k;
}

export function kpiOf(rows, geoSet) {
  const k = emptyKpi();
  for (const r of rows) addToKpi(k, r, geoSet);
  return finalizeKpi(k);
}

export function finalizeKpi(k) {
  k.matchRate = k.mkd ? k.matched / k.mkd : null;
  k.fullShare = k.evaluated ? k.full / k.evaluated : null;
  k.entrShare = k.entrTotal ? k.entrLinked / k.entrTotal : null;
  k.evalCompleteness = k.mkd ? k.evaluated / k.mkd : null;
  k.geoShare = k.mkd ? k.geo / k.mkd : null;
  k.smallSample = k.evaluated < MIN_SAMPLE;
  k.served = k.hs.full + k.hs.partial;
  k.hasEdc = k.mkd > k.noEdc;
  k.servedShare = k.hasEdc && k.mkd ? k.served / k.mkd : null;
  k.notServedShare = k.hasEdc && k.mkd ? k.hs.none / k.mkd : null;
  k.partialShare = k.hasEdc && k.mkd ? k.hs.partial / k.mkd : null;
  k.activeShare = k.served ? k.servedActive / k.served : null;
  k.servedNoReq = k.served - k.servedActive;
  return k;
}

/** Группировка по полю (okrug | area) с KPI по каждой группе. */
export function groupKpi(rows, field, geoSet) {
  const m = new Map();
  for (const r of rows) {
    const key = r[field] || (field === 'okrug' ? NO_OKRUG : '(район не указан)');
    if (!m.has(key)) m.set(key, emptyKpi());
    addToKpi(m.get(key), r, geoSet);
  }
  const out = [];
  for (const [key, k] of m) out.push({ key, ...finalizeKpi(k) });
  if (field === 'okrug') {
    out.sort((a, b) => okrugOrder(a.key) - okrugOrder(b.key));
  } else out.sort((a, b) => a.key.localeCompare(b.key, 'ru'));
  return out;
}

function okrugOrder(code) {
  const i = OKRUG_CODES.indexOf(code);
  return i === -1 ? 99 : i;
}

/**
 * Показатели для сводки, карты и таблиц. ramp: 'blue' - подключение, 'heat' - активность заявок.
 * value(k, quarter) - значение для группы KPI; den - знаменатель (для «малой выборки» и подписей).
 */
export const METRICS = {
  servedShare: {
    label: 'Доля домов, обслуживаемых в ЕДЦ', short: '% обслуживается', fmt: 'pct', ramp: 'blue', needsEdc: true,
    value: (k) => k.servedShare, num: (k) => k.served, den: (k) => k.mkd, numLabel: 'обслуживается', denLabel: 'домов МЖИ',
    note: 'Обслуживается: дом найден в ЕДЦ и к обслуживанию привязаны все или часть его подъездов.',
  },
  notServed: {
    label: 'Домов, не обслуживаемых в ЕДЦ', short: 'Не обслуживается', fmt: 'int', ramp: 'blue', needsEdc: true,
    value: (k) => (k.hasEdc ? k.hs.none : null), den: (k) => k.mkd,
    note: 'Дома реестра МЖИ, которых нет в выгрузке ЕДЦ, и дома, у которых ни один подъезд не привязан к обслуживанию.',
  },
  partialShare: {
    label: 'Доля домов, где обслуживается часть подъездов', short: '% частично', fmt: 'pct', ramp: 'blue', needsEdc: true,
    value: (k) => k.partialShare, num: (k) => k.hs.partial, den: (k) => k.mkd, numLabel: 'частично', denLabel: 'домов МЖИ',
    note: 'Дом найден в ЕДЦ, но к обслуживанию привязана только часть подъездов.',
  },
  entrShare: {
    label: 'Доля обслуживаемых подъездов', short: '% подъездов', fmt: 'pct', ramp: 'blue', needsEdc: true,
    value: (k) => k.entrShare, num: (k) => k.entrLinked, den: (k) => k.entrTotal, numLabel: 'подъездов обслуживается', denLabel: 'подъездов',
    note: 'Подъезды домов, найденных в ЕДЦ, с привязкой к обслуживанию. Строки-заглушки не учитываются.',
  },
  reqPerHouse: {
    label: 'Заявок 2026 на один обслуживаемый дом', short: 'Заявок на дом', fmt: 'num1', ramp: 'heat', needsEdc: true, period: true,
    value: (k, q) => (k.served ? (q ? k.rc[q] : k.rc.total) / k.served : null), den: (k) => k.served,
    note: 'Заявки уровня «Дом» обслуживаемых домов, делённые на число обслуживаемых домов.',
  },
  activeShare: {
    label: 'Доля обслуживаемых домов с заявками в 2026 году', short: '% домов с заявками', fmt: 'pct', ramp: 'heat', needsEdc: true,
    value: (k) => k.activeShare, num: (k) => k.servedActive, den: (k) => k.served, numLabel: 'с заявками', denLabel: 'обслуживаемых домов',
    note: 'Дом считается активным, если в 2026 году по нему была хотя бы одна заявка.',
  },
  requests: {
    label: 'Заявок 2026 (домовой уровень)', short: 'Заявок всего', fmt: 'int', ramp: 'heat', needsEdc: true, period: true,
    value: (k, q) => (k.hasEdc ? (q ? k.req[q] : k.req.total) : null),
    note: 'Сумма агрегатов уровня «Дом» (SQL № 4) сопоставленных домов. 2026 год не завершён.',
  },
  openPerHouse: {
    label: 'Заявок без даты закрытия на один обслуживаемый дом', short: 'Открытых на дом', fmt: 'num2', ramp: 'heat', needsEdc: true,
    value: (k) => (k.served ? k.rc.open / k.served : null), den: (k) => k.served,
    note: 'Заявки 2026 года, у которых в ЕДЦ нет даты закрытия. Поквартальной разбивки нет.',
  },
  criticalPerHouse: {
    label: 'Критических заявок на один обслуживаемый дом', short: 'Критических на дом', fmt: 'num2', ramp: 'heat', needsEdc: true,
    value: (k) => (k.served ? k.rc.critical / k.served : null), den: (k) => k.served,
    note: 'Критические заявки 2026 года обслуживаемых домов. Поквартальной разбивки нет.',
  },
  mkd: {
    label: 'Домов в реестре МЖИ', short: 'Домов МЖИ', fmt: 'int', ramp: 'blue', needsEdc: false,
    value: (k) => k.mkd,
    note: 'Объём жилого фонда в файле МЖИ.',
  },
  fullShare: {
    label: '% оценённых домов с привязкой всех подъездов', short: '% полностью', fmt: 'pct', ramp: 'blue', needsEdc: true, legacy: true,
    value: (k) => k.fullShare, num: (k) => k.full, den: (k) => k.evaluated, numLabel: 'полностью', denLabel: 'оценено домов',
    note: 'Знаменатель: дома, найденные в ЕДЦ, актуальные, жилые, с подъездами.',
  },
};
export const RANK_METRICS = METRICS;
export const MAIN_METRICS = ['servedShare', 'notServed', 'entrShare', 'reqPerHouse', 'activeShare', 'requests', 'mkd'];
export const ACTIVITY_METRICS = ['reqPerHouse', 'requests', 'activeShare', 'openPerHouse', 'criticalPerHouse'];

export function metricValue(k, metric, quarter = '') {
  const m = METRICS[metric];
  if (!m) return null;
  const v = m.value(k, m.period ? quarter : '');
  return v === undefined || (typeof v === 'number' && !Number.isFinite(v)) ? null : v;
}

/** Совместимость: значение показателя для группы. */
export function rankValue(k, metric, _reqMetric = 'total', quarter = '') {
  return metricValue(k, metric, quarter);
}

export function reqFromKpi(k, metric = 'total', quarter = '') {
  if (quarter) return REQ_METRICS[metric].quarters ? k.req[quarter] : null;
  return k.req[metric];
}

/** Мало домов в знаменателе: доля неустойчива, место не присваивается. */
export function smallSampleFor(k, metric) {
  const m = METRICS[metric];
  return !!(m && m.den && m.fmt !== 'int' && m.den(k) < MIN_SAMPLE);
}

/** Места в рейтинге: малые выборки и «нет данных» не ранжируются. «Не обслуживается» ранжируется по возрастанию. */
export function rankGroups(groups, metric, opts = {}) {
  const asc = metric === 'notServed';
  const vals = groups.map((g) => ({ g, v: metricValue(g, metric, opts.quarter) }));
  const rankable = vals.filter((x) => x.v !== null && x.v !== undefined && !smallSampleFor(x.g, metric) && x.g.key !== NO_OKRUG);
  rankable.sort((a, b) => (asc ? a.v - b.v : b.v - a.v));
  const rank = new Map();
  rankable.forEach((x, i) => rank.set(x.g.key, i + 1));
  return vals.map((x) => ({ ...x.g, value: x.v, rank: rank.get(x.g.key) || null, small: smallSampleFor(x.g, metric) }));
}

/** Границы классов по квантилям (для заливки районов и сетки): до n классов, повторы схлопываются. */
export function quantileBreaks(values, n = 5) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < n; i++) {
    const b = v[Math.floor((i * v.length) / n)];
    if (b !== undefined && b > v[0] && (!out.length || b > out[out.length - 1])) out.push(b);
  }
  return out;
}

/** Номер класса значения по границам quantileBreaks. */
export function classOf(v, breaks) {
  let i = 0;
  while (i < breaks.length && v >= breaks[i]) i++;
  return i;
}

// ---------- сетка шестиугольников по домам с координатами ----------
const LAT0 = 55.75;
const MX = Math.cos((LAT0 * Math.PI) / 180) * 111320; // метров в градусе долготы
const MY = 110540; // метров в градусе широты

/**
 * Дома с координатами, собранные в шестиугольники со стороной size метров. Для каждой ячейки считаются
 * те же KPI, что для района, поэтому сетка показывает любые показатели (заявок на дом, доля подключённых...).
 * @returns {{cells: {key, lat, lon, ring: [lat, lon][], k}[], geoRows: number}}
 */
export function hexCells(rows, geo, size = 600) {
  const w = Math.sqrt(3) * size;
  const cells = new Map();
  let geoRows = 0;
  for (const r of rows) {
    const g = geo.get(r.u);
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    geoRows++;
    const x = (g.lon - 37.6) * MX;
    const y = (g.lat - LAT0) * MY;
    // осевые координаты шестиугольника с острой вершиной вверх и округление до ближайшей ячейки
    const qf = (x * Math.sqrt(3) / 3 - y / 3) / size;
    const rf = (y * 2 / 3) / size;
    let q = Math.round(qf); let rr = Math.round(rf); const s3 = Math.round(-qf - rf);
    const dq = Math.abs(q - qf); const dr = Math.abs(rr - rf); const ds = Math.abs(s3 + qf + rf);
    if (dq > dr && dq > ds) q = -rr - s3; else if (dr > ds) rr = -q - s3;
    const key = `${q},${rr}`;
    let c = cells.get(key);
    if (!c) {
      const cx = w * (q + rr / 2);
      const cy = 1.5 * size * rr;
      const ring = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i - 30);
        ring.push([LAT0 + (cy + size * Math.sin(a)) / MY, 37.6 + (cx + size * Math.cos(a)) / MX]);
      }
      c = { key, lat: LAT0 + cy / MY, lon: 37.6 + cx / MX, ring, k: emptyKpi() };
      cells.set(key, c);
    }
    addToKpi(c.k, r);
  }
  const out = [...cells.values()];
  for (const c of out) finalizeKpi(c.k);
  return { cells: out, geoRows };
}
