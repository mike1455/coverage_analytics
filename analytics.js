// Аналитика: сопоставление МЖИ ↔ ЕДЦ, классификация покрытия по привязкам ЕДЦ, KPI и рейтинги.
// Чистые функции без DOM — используются в Web Worker, в интерфейсе и в node-тестах.
//
// Ключевые правила (ТЗ §3):
//  • «Покрытие по привязкам ЕДЦ» ≠ «подтверждённое подключение». Флага подключения нет — метрика прокси.
//  • Оценённый дом = однозначно сопоставлен с ЕДЦ-записью, actual=true, house_type='Жилое', подъездов > 0.
//  • Заявки по округу = сумма агрегатов уровня «Дом». Уровни «Дом» и «Подъезд» никогда не складываются.
//  • Неизвестно ≠ нет: несопоставленные/конфликтные/без подъездов дома не считаются «неподключёнными».

import { Q } from './core/edc.js';
import { OKRUG_CODES, NO_OKRUG } from './core/okrugs.js';

export const MIN_SAMPLE = 30; // меньше — «малая выборка», место в рейтинге не присваивается

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
  edc_not_last: 'Запись ЕДЦ не последняя версия (is_last ≠ true)',
  edc_not_actual: 'Объект ЕДЦ неактуален (actual = false)',
  edc_actual_unknown: 'Актуальность объекта ЕДЦ неизвестна',
  edc_not_residential: 'Тип дома в ЕДЦ — «Нежилое»',
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
    return { pick: null, rule: `${act.length} актуальных записей ЕДЦ — требуется ручной выбор` };
  }
  return { pick: null, rule: `${cands.length} записей ЕДЦ, ни одна не актуальна — требуется ручной выбор` };
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
 * Сопоставление МЖИ ↔ ЕДЦ. Использование:
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
   * @param {Map<string,{r:string|null}>} overrides — UNOM → ручной выбор (r=null — «нет соответствия»)
   * @param {Map<string,object>} overrideRecs — r → запись ЕДЦ для ручных выборов
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
export const QUARTERS = { '': 'Весь имеющийся 2026', q1: 'I квартал', q2: 'II квартал', q3: 'III квартал', q4: 'IV квартал (частичный)' };

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

export const RANK_METRICS = {
  fullShare: {
    label: '% домов с полной привязкой подъездов', short: '% полностью покрытых', pct: true, needsEdc: true,
    num: (k) => k.full, den: (k) => k.evaluated, numLabel: 'полностью покрыто', denLabel: 'оценено домов',
    note: 'По найденным привязкам ЕДЦ, не подтверждённое подключение. Знаменатель — оценённые дома.',
  },
  entrShare: {
    label: '% подъездов с найденной привязкой', short: '% подъездов с привязкой', pct: true, needsEdc: true,
    num: (k) => k.entrLinked, den: (k) => k.entrTotal, numLabel: 'подъездов с привязкой', denLabel: 'подъездов оценённых домов',
    note: 'Уникальные подъезды оценённых домов, без строк-заглушек.',
  },
  requests: {
    label: 'Заявок 2026 (домовой уровень)', short: 'Заявок 2026', pct: false, needsEdc: true,
    note: 'Сумма агрегатов уровня «Дом» сопоставленных домов. 2026 год не завершён.',
  },
  requestsPer1000: {
    label: 'Заявок 2026 на 1 000 сопоставленных МКД', short: 'Заявок на 1 000 МКД', pct: false, needsEdc: true,
    note: 'Знаменатель — МКД МЖИ, сопоставленные с ЕДЦ.',
  },
  matchRate: {
    label: '% МКД МЖИ, сопоставленных с ЕДЦ', short: '% сопоставления', pct: true, needsEdc: true,
    num: (k) => k.matched, den: (k) => k.mkd, numLabel: 'сопоставлено', denLabel: 'МКД МЖИ',
    note: 'Полнота сопоставления, не подключение.',
  },
  mkd: {
    label: 'МКД в реестре МЖИ (объём фонда)', short: 'МКД МЖИ', pct: false, needsEdc: false,
    note: 'Это объём жилого фонда в файле МЖИ, а не рейтинг подключения.',
  },
};

export function rankValue(k, metric, reqMetric = 'total', quarter = '') {
  switch (metric) {
    case 'fullShare': return k.fullShare;
    case 'entrShare': return k.entrShare;
    case 'matchRate': return k.matchRate;
    case 'mkd': return k.mkd;
    case 'requests': return reqFromKpi(k, reqMetric, quarter);
    case 'requestsPer1000': {
      const v = reqFromKpi(k, reqMetric, quarter);
      return v === null || !k.matched ? null : (v / k.matched) * 1000;
    }
    default: return null;
  }
}

export function reqFromKpi(k, metric = 'total', quarter = '') {
  if (quarter) return REQ_METRICS[metric].quarters ? k.req[quarter] : null;
  return k.req[metric];
}

/** Места в рейтинге: малые выборки и «нет данных» не ранжируются. */
export function rankGroups(groups, metric, opts = {}) {
  const needsSample = metric === 'fullShare' || metric === 'entrShare';
  const vals = groups.map((g) => ({ g, v: rankValue(g, metric, opts.reqMetric, opts.quarter) }));
  const rankable = vals.filter((x) => x.v !== null && x.v !== undefined && !(needsSample && x.g.smallSample) && x.g.key !== NO_OKRUG);
  rankable.sort((a, b) => b.v - a.v);
  const rank = new Map();
  rankable.forEach((x, i) => rank.set(x.g.key, i + 1));
  return vals.map((x) => ({ ...x.g, value: x.v, rank: rank.get(x.g.key) || null }));
}

/** Точки тепловой карты: только домовой уровень и только дома с проверенной/сохранённой геопозицией. */
export function heatPoints(rows, geo, metric = 'total', quarter = '', { onlyVerified = false } = {}) {
  const pts = [];
  let withReq = 0;
  let geoWithReq = 0;
  for (const r of rows) {
    const v = reqValue(r, metric, quarter);
    if (!v) continue;
    withReq++;
    const g = geo.get(r.u);
    if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
    if (onlyVerified && g.status !== 'verified' && g.status !== 'manual') continue;
    geoWithReq++;
    pts.push({ lat: g.lat, lon: g.lon, v, u: r.u });
  }
  return { pts, withReq, geoWithReq };
}

export function displayCategory(row) {
  return row.cov;
}
