// Сводка: одна картинка по всей Москве. Округа, мозаика районов, состав домов по статусам и активность
// заявок по кварталам. Рисуется в SVG: на странице с подсказками и переходами, в PNG для отчёта.

import { fmt, NA } from './ui.js';
import { showTip, hideTip, fmtMetric } from './charts.js';
import { OKRUGS, NO_OKRUG, okrugByCode } from './core/okrugs.js';
import {
  emptyKpi, addToKpi, finalizeKpi, kpiOf, METRICS, metricValue, smallSampleFor, HS_LABEL, HS_ORDER, MIN_SAMPLE,
} from './analytics.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 1600;
const P = 48;
const CW = W - 2 * P;
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

/** Цвета картинки по теме (те же значения, что в style.css), чтобы PNG выглядел одинаково везде. */
export const POSTER_TOKENS = {
  light: {
    page: '#f4f4f1', surface: '#ffffff', border: '#e3e2dc', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e8e7e1', accent: '#2a78d6',
    hs: { full: '#0ca30c', partial: '#e87ba4', none: '#d03b3b', unknown: '#a3a29c', excluded: '#cfcdc5' },
    blue: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
    blueInk: ['#0b0b0b', '#0b0b0b', '#0b0b0b', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
    heat: ['#fde4d6', '#f9c7aa', '#f4a57e', '#eb6834', '#d95926', '#b4461c', '#8a3412'],
    heatInk: ['#0b0b0b', '#0b0b0b', '#0b0b0b', '#ffffff', '#ffffff', '#ffffff', '#ffffff'],
  },
  dark: {
    page: '#0d0d0d', surface: '#1a1a19', border: '#2e2e2c', ink: '#f0efec', ink2: '#c3c2b7', muted: '#8f8d86', grid: '#2c2c2a', accent: '#3987e5',
    hs: { full: '#0ca30c', partial: '#e87ba4', none: '#d03b3b', unknown: '#77756f', excluded: '#4a4945' },
    blue: ['#16263a', '#184f95', '#1c5cab', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4'],
    blueInk: ['#f0efec', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#0b0b0b', '#0b0b0b'],
    heat: ['#3a1a0c', '#6b2a10', '#8a3412', '#b4461c', '#d95926', '#eb6834', '#f4a57e'],
    heatInk: ['#f0efec', '#ffffff', '#ffffff', '#ffffff', '#ffffff', '#0b0b0b', '#0b0b0b'],
  },
};

export const SUMMARY_METRICS = ['servedShare', 'entrShare', 'reqPerHouse', 'activeShare'];
const TITLES = {
  servedShare: ['Округа: доля домов, обслуживаемых в ЕДЦ', 'Районы: доля домов, обслуживаемых в ЕДЦ'],
  entrShare: ['Округа: доля обслуживаемых подъездов', 'Районы: доля обслуживаемых подъездов'],
  reqPerHouse: ['Округа: заявок 2026 на обслуживаемый дом', 'Районы: заявок 2026 на обслуживаемый дом'],
  activeShare: ['Округа: доля домов с заявками', 'Районы: доля домов с заявками'],
  mkd: ['Округа: домов в реестре МЖИ', 'Районы: домов в реестре МЖИ'],
};

function el(tag, attrs, ...children) {
  const e = document.createElementNS(NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

const text = (x, y, str, o = {}) => el('text', {
  x, y, 'font-size': o.size || 13, 'font-weight': o.weight || null, fill: o.fill, 'text-anchor': o.anchor || null, opacity: o.opacity || null,
}, str);

/** Приблизительная ширина строки (для обрезки длинных названий). */
const textWidth = (str, size) => String(str).length * size * 0.56;
function fit(str, maxPx, size) {
  const s = String(str || '');
  if (textWidth(s, size) <= maxPx) return s;
  const n = Math.max(1, Math.floor(maxPx / (size * 0.56)) - 1);
  return `${s.slice(0, n).trimEnd()}…`;
}

function tip(node, fn) {
  node.addEventListener('mousemove', (e) => showTip(e, fn()));
  node.addEventListener('mouseleave', hideTip);
  node.style.cursor = 'pointer';
  return node;
}

const div = (cls, ...c) => { const d = document.createElement('div'); if (cls) d.className = cls; for (const x of c.flat()) if (x !== null && x !== undefined) d.append(x instanceof Node ? x : String(x)); return d; };

// ---------------------------------------------------------------- данные

/**
 * Группы для сводки: Москва, округа, районы внутри округов.
 * @returns {{k, okrugs: Map<string, object>, areas: {key, okrug, k}[], hasEdc: boolean}}
 */
export function summaryData(rows, geoSet) {
  const k = kpiOf(rows, geoSet);
  const okrugs = new Map();
  const areas = new Map();
  for (const r of rows) {
    const o = r.okrug || NO_OKRUG;
    if (!okrugs.has(o)) okrugs.set(o, emptyKpi());
    addToKpi(okrugs.get(o), r, geoSet);
    const ak = `${o}|${r.area || '(район не указан)'}`;
    if (!areas.has(ak)) areas.set(ak, { key: r.area || '(район не указан)', okrug: o, k: emptyKpi() });
    addToKpi(areas.get(ak).k, r, geoSet);
  }
  for (const v of okrugs.values()) finalizeKpi(v);
  for (const a of areas.values()) finalizeKpi(a.k);
  return { k, okrugs, areas: [...areas.values()], hasEdc: k.hasEdc };
}

function domain(values, metric) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  let lo = Math.min(...v);
  let hi = Math.max(...v);
  if (METRICS[metric].fmt === 'pct') { // доли: шкала до 100%, нижний край кратен 5%
    hi = Math.max(hi, lo);
    lo = Math.floor(lo * 20) / 20;
    if (hi - lo < 0.05) lo = Math.max(0, hi - 0.05);
  }
  return { lo, hi };
}

function rampOf(T, metric, dom, v) {
  const ramp = METRICS[metric].ramp === 'heat' ? 'heat' : 'blue';
  if (!Number.isFinite(v) || !dom) return { fill: T.grid, ink: T.ink2 };
  const t = dom.hi > dom.lo ? Math.max(0, Math.min(1, (v - dom.lo) / (dom.hi - dom.lo))) : 0.5;
  const i = Math.round(t * 6);
  return { fill: T[ramp][i], ink: T[`${ramp}Ink`][i] };
}

// ---------------------------------------------------------------- картинка

/**
 * @param {object} data результат summaryData
 * @param {object} o {metric, theme: 'light'|'dark', dates: {mji, edc}, selected, onOkrug, onArea}
 * @returns {SVGSVGElement}
 */
export function buildPoster(data, o) {
  const T = POSTER_TOKENS[o.theme || 'light'];
  const metric = data.hasEdc ? o.metric : 'mkd';
  const m = METRICS[metric];
  const { k } = data;
  const parts = [];
  let y = 0;

  // Шапка
  parts.push(text(P, 66, 'Обслуживание домов в ЕДЦ и заявки 2026 года', { size: 28, weight: 700, fill: T.ink }));
  parts.push(text(P, 94, `Москва. Реестр МКД МЖИ от ${o.dates.mji || NA}, выгрузки ЕДЦ ${o.dates.edc ? `от ${o.dates.edc}` : 'не загружены'}.`, { size: 15, fill: T.ink2 }));
  parts.push(text(W - P, 62, 'Аналитика покрытия', { size: 13, fill: T.muted, anchor: 'end', weight: 600 }));
  parts.push(text(W - P, 82, `сформировано ${fmt.date(new Date().toISOString())}`, { size: 13, fill: T.muted, anchor: 'end' }));

  // Показатели
  y = 118;
  const conn = data.hasEdc;
  const tiles = [
    ['Домов в реестре МЖИ', fmt.int(k.mkd), `${data.okrugs.size - (data.okrugs.has(NO_OKRUG) ? 1 : 0)} округов, ${data.areas.length} районов и поселений`, null, null],
    ['Обслуживаются в ЕДЦ', conn ? fmt.int(k.served) : 'нет данных', conn ? `${fmt.pct(k.servedShare)} домов, без заявок 2026: ${fmt.int(k.servedNoReq)}` : 'загрузите выгрузки ЕДЦ', conn ? k.servedShare : null, T.hs.full],
    ['Обслуживается часть подъездов', conn ? fmt.int(k.hs.partial) : 'нет данных', conn ? `${fmt.pct(k.partialShare)} домов реестра` : '', null, T.hs.partial],
    ['Не обслуживаются в ЕДЦ', conn ? fmt.int(k.hs.none) : 'нет данных', conn ? `${fmt.pct(k.notServedShare)}, из них нет в ЕДЦ ${fmt.int(k.notInEdc)}` : '', null, T.hs.none],
    ['Заявок в 2026 году', conn ? fmt.big(k.req.total) : 'нет данных', conn ? `${fmt.num1(metricValue(k, 'reqPerHouse'))} на дом, заявки у ${fmt.pct(k.activeShare, 0)} домов` : '', null, null],
  ];
  const tw = (CW - 4 * 16) / 5;
  tiles.forEach(([label, value, sub, bar, sw], i) => {
    const x = P + i * (tw + 16);
    parts.push(el('rect', { x, y, width: tw, height: 112, rx: 12, fill: T.surface, stroke: T.border }));
    if (sw) parts.push(el('rect', { x: x + 20, y: y + 20, width: 10, height: 10, rx: 2, fill: sw }));
    parts.push(text(x + (sw ? 36 : 20), y + 30, label, { size: 13, weight: 600, fill: T.ink2 }));
    parts.push(text(x + 20, y + 70, value, { size: value === 'нет данных' ? 20 : 32, weight: 700, fill: value === 'нет данных' ? T.muted : T.ink }));
    parts.push(text(x + 20, y + 92, sub, { size: 13, fill: T.muted }));
    if (bar !== null) {
      parts.push(el('rect', { x: x + 20, y: y + 100, width: tw - 40, height: 4, rx: 2, fill: T.grid }));
      parts.push(el('rect', { x: x + 20, y: y + 100, width: Math.max(2, (tw - 40) * bar), height: 4, rx: 2, fill: T.accent }));
    }
  });

  // Ряд 1: плитки округов и состав домов
  y += 112 + 28;
  const half = (CW - 16) / 2;
  const xL = P;
  const xR = P + half + 16;
  const okrugVals = OKRUGS.map((ok) => metricValue(data.okrugs.get(ok.code) || finalizeKpi(emptyKpi()), metric));
  const domO = domain(okrugVals, metric);
  parts.push(panel(T, xL, y, half, 440, TITLES[metric][0], legendRamp(T, metric, domO, xL + half - 24, y + 26)));
  parts.push(okrugTilesSvg(T, data, metric, domO, xL + 24, y + 60, half - 48, o));
  parts.push(panel(T, xR, y, half, 440, 'Состав домов по округам'));
  parts.push(compositionSvg(T, data, xR, y, half, o));

  // Ряд 2: мозаика районов и заявки по кварталам
  y += 440 + 16;
  const inMoscow = data.areas.filter((a) => a.okrug !== NO_OKRUG);
  const bigAreas = inMoscow.filter((a) => !smallSampleFor(a.k, metric));
  const areaVals = (bigAreas.length >= 3 ? bigAreas : inMoscow).map((a) => metricValue(a.k, metric));
  const domA = domain(areaVals, metric);
  parts.push(panel(T, xL, y, half, 476, TITLES[metric][1], legendRamp(T, metric, domA, xL + half - 24, y + 26)));
  parts.push(mosaicSvg(T, data, metric, domA, xL, y, half, o));
  parts.push(panel(T, xR, y, half, 476, 'Заявок 2026 на обслуживаемый дом по кварталам'));
  parts.push(quartersSvg(T, data, xR, y, half, o));

  // Ряд 3: районы-отстающие и самые активные
  y += 476 + 16;
  parts.push(panel(T, xL, y, half, 330, 'Районы с наименьшей долей обслуживаемых домов'));
  parts.push(listSvg(T, data, 'low', xL, y, half, o));
  parts.push(panel(T, xR, y, half, 330, 'Районы с наибольшим числом заявок на дом'));
  parts.push(listSvg(T, data, 'active', xR, y, half, o));

  // Пояснения
  y += 330 + 30;
  const notes = [
    'Обслуживается: дом найден в ЕДЦ (по УНОМ или ФИАС) и к обслуживанию привязаны все его подъезды (зелёный) или часть подъездов (розовый).',
    'Не обслуживается (красный): дома нет в выгрузке ЕДЦ или ни один его подъезд не привязан к обслуживанию. Заявки: агрегаты уровня «Дом» (SQL № 4), подъездные агрегаты не добавляются.',
    `Пунктиром обведены районы, где меньше ${MIN_SAMPLE} домов в знаменателе: доля там неустойчива. В списках такие районы отмечены звёздочкой и показываются, только если других нет.`,
  ];
  notes.forEach((t, i) => parts.push(text(P, y + i * 19, t, { size: 12.5, fill: T.muted })));
  const H = y + notes.length * 19 + 24;

  const svg = el('svg', {
    xmlns: NS, viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'font-family': FONT, class: 'poster',
    role: 'img', 'aria-label': 'Сводка: обслуживание домов в ЕДЦ и заявки 2026 года по округам и районам Москвы',
  }, el('rect', { x: 0, y: 0, width: W, height: H, fill: T.page }), parts);
  return svg;
}

function panel(T, x, y, w, hgt, title, extra) {
  return el('g', null,
    el('rect', { x, y, width: w, height: hgt, rx: 14, fill: T.surface, stroke: T.border }),
    text(x + 24, y + 36, title, { size: 17, weight: 700, fill: T.ink }), extra || null);
}

function legendRamp(T, metric, dom, xRight, y) {
  if (!dom) return null;
  const ramp = METRICS[metric].ramp === 'heat' ? 'heat' : 'blue';
  const sw = 16;
  const x0 = xRight - 7 * sw - 52;
  const g = el('g', null);
  g.append(text(x0 - 8, y + 4, fmtMetric(metric, dom.lo), { size: 12, fill: T.muted, anchor: 'end' }));
  T[ramp].forEach((c, i) => g.append(el('rect', { x: x0 + i * sw, y: y - 6, width: sw - 2, height: 12, rx: 2, fill: c })));
  g.append(text(x0 + 7 * sw + 6, y + 4, fmtMetric(metric, dom.hi), { size: 12, fill: T.muted }));
  return g;
}

function okrugTilesSvg(T, data, metric, dom, x0, y0, width, o) {
  const g = el('g', null);
  const cols = 4;
  const gap = 10;
  const tw = (width - gap * (cols - 1)) / cols;
  const th = 112;
  for (const ok of OKRUGS) {
    const kk = data.okrugs.get(ok.code) || finalizeKpi(emptyKpi());
    const v = metricValue(kk, metric);
    const c = rampOf(T, metric, dom, v);
    const x = x0 + ok.grid[0] * (tw + gap);
    const y = y0 + ok.grid[1] * (th + gap);
    const sub = metric === 'servedShare' ? `${fmt.int(kk.served)} из ${fmt.int(kk.mkd)}`
      : metric === 'entrShare' ? `${fmt.int(kk.entrLinked)} из ${fmt.int(kk.entrTotal)}`
        : metric === 'reqPerHouse' ? `${fmt.int(kk.rc.total)} заявок`
          : metric === 'activeShare' ? `${fmt.int(kk.servedActive)} из ${fmt.int(kk.served)}` : 'домов';
    const sel = o.selected === ok.code;
    const tile = el('g', { tabindex: 0, role: 'button', 'aria-label': `${ok.full}: ${fmtMetric(metric, v)}` },
      el('rect', { x, y, width: tw, height: th, rx: 10, fill: c.fill, stroke: sel ? T.ink : 'none', 'stroke-width': sel ? 2.5 : 0 }),
      text(x + 14, y + 26, ok.code, { size: 15, weight: 700, fill: c.ink }),
      text(x + 14, y + 44, fit(ok.name, tw - 28, 12), { size: 12, fill: c.ink, opacity: 0.85 }),
      text(x + 14, y + 82, fmtMetric(metric, v), { size: 28, weight: 700, fill: c.ink }),
      text(x + 14, y + 100, sub, { size: 12, fill: c.ink, opacity: 0.85 }));
    if (o.onOkrug) tile.addEventListener('click', () => o.onOkrug(ok.code));
    tip(tile, () => okrugTip(ok, kk));
    g.append(tile);
  }
  return g;
}

function okrugTip(ok, kk) {
  return [
    div(null, Object.assign(document.createElement('b'), { textContent: ok.full })),
    div(null, `Домов МЖИ: ${fmt.int(kk.mkd)}`),
    kk.hasEdc ? div(null, `Обслуживаются: ${fmt.int(kk.served)} (${fmt.pct(kk.servedShare)}), из них частично ${fmt.int(kk.hs.partial)}`) : null,
    kk.hasEdc ? div(null, `Не обслуживаются: ${fmt.int(kk.hs.none)}, из них нет в ЕДЦ ${fmt.int(kk.notInEdc)}`) : null,
    kk.hasEdc ? div(null, `Заявок 2026: ${fmt.int(kk.req.total)}, на дом ${fmt.num1(metricValue(kk, 'reqPerHouse'))}`) : null,
    div('muted', 'Клик открывает округ в разделе «Округа и районы»'),
  ];
}

function compositionSvg(T, data, x, y, w, o) {
  const g = el('g', null);
  if (!data.hasEdc) {
    g.append(text(x + 24, y + 80, 'Состав появится после загрузки выгрузок ЕДЦ.', { size: 14, fill: T.muted }));
    return g;
  }
  // Легенда: только статусы, которые есть в данных
  const present = HS_ORDER.filter((s) => data.k.hs[s] > 0);
  let lx = x + 24;
  let ly = y + 60;
  for (const s of present) {
    const lw = 18 + textWidth(HS_LABEL[s], 12) + 18;
    if (lx + lw > x + w - 24) { lx = x + 24; ly += 18; }
    g.append(el('rect', { x: lx, y: ly - 9, width: 10, height: 10, rx: 2, fill: T.hs[s] }), text(lx + 16, ly, HS_LABEL[s], { size: 12, fill: T.ink2 }));
    lx += lw;
  }
  const top = ly + 30;
  g.append(text(x + w - 24, top - 10, 'обслуживается', { size: 11.5, fill: T.muted, anchor: 'end' }));
  const list = OKRUGS.map((ok) => ({ ok, kk: data.okrugs.get(ok.code) })).filter((r) => r.kk)
    .sort((a, b) => (b.kk.servedShare ?? -1) - (a.kk.servedShare ?? -1));
  const bx = x + 84;
  const bw = w - 84 - 100;
  const pitch = Math.min(27, (y + 428 - top) / Math.max(1, list.length));
  list.forEach(({ ok, kk }, i) => {
    const ry = top + i * pitch;
    g.append(text(x + 24, ry + 12, ok.code, { size: 13, weight: 600, fill: T.ink }));
    const id = `clip-${o.theme || 'light'}-${i}`;
    g.append(el('clipPath', { id }, el('rect', { x: bx, y: ry, width: bw, height: 16, rx: 4 })));
    const bar = el('g', { 'clip-path': `url(#${id})` });
    let cx = bx;
    for (const s of HS_ORDER) {
      const n = kk.hs[s];
      if (!n) continue;
      const sw = (n / kk.mkd) * bw;
      const seg = el('rect', { x: cx, y: ry, width: Math.max(0, sw - 2), height: 16, fill: T.hs[s] });
      tip(seg, () => [div(null, Object.assign(document.createElement('b'), { textContent: `${ok.code}: ${HS_LABEL[s]}` })),
        div(null, `${fmt.int(n)} домов, ${fmt.pct(n / kk.mkd)} от ${fmt.int(kk.mkd)}`)]);
      if (o.onOkrug) seg.addEventListener('click', () => o.onOkrug(ok.code));
      bar.append(seg);
      cx += sw;
    }
    g.append(bar);
    g.append(text(x + w - 24, ry + 12.5, fmt.pct(kk.servedShare), { size: 13, weight: 700, fill: T.ink, anchor: 'end' }));
  });
  return g;
}

function mosaicSvg(T, data, metric, dom, x, y, w, o) {
  const g = el('g', null);
  const showMin = metric === 'servedShare' || metric === 'entrShare';
  g.append(text(x + 24, y + 58, `Каждый квадрат: район или поселение, по убыванию значения. Справа ${showMin ? 'район с наименьшим значением' : 'район с наибольшим значением'}.`, { size: 12, fill: T.muted }));
  const size = 20;
  const gap = 3;
  const sx = x + 84;
  let ry = y + 78;
  for (const ok of OKRUGS) {
    const list = data.areas.filter((a) => a.okrug === ok.code).map((a) => ({ a, v: metricValue(a.k, metric), small: smallSampleFor(a.k, metric) }))
      .sort((p, q) => (q.v ?? -1) - (p.v ?? -1));
    g.append(text(x + 24, ry + 15, ok.code, { size: 13, weight: 600, fill: T.ink }));
    list.forEach(({ a, v, small }, i) => {
      const c = rampOf(T, metric, dom, v);
      const cx = sx + i * (size + gap);
      if (cx + size > x + w - 200) return;
      const sq = el('rect', {
        x: cx, y: ry, width: size, height: size, rx: 4, fill: c.fill,
        stroke: small ? T.ink2 : 'none', 'stroke-dasharray': small ? '3 2' : null, 'stroke-width': small ? 1.2 : 0,
      });
      tip(sq, () => [div(null, Object.assign(document.createElement('b'), { textContent: a.key })), div('muted', okrugByCode(ok.code)?.full || ok.code),
        div(null, `${METRICS[metric].short}: ${fmtMetric(metric, v)}`),
        div(null, `Домов МЖИ: ${fmt.int(a.k.mkd)}${a.k.hasEdc ? `, обслуживаются ${fmt.int(a.k.served)}, частично ${fmt.int(a.k.hs.partial)}, не обслуживаются ${fmt.int(a.k.hs.none)}` : ''}`),
        small ? div('muted', `Меньше ${MIN_SAMPLE} домов: значение неустойчиво`) : null,
        div('muted', 'Клик открывает список домов района')]);
      if (o.onArea) sq.addEventListener('click', () => o.onArea(ok.code, a.key));
      g.append(sq);
    });
    const finite = list.filter((r) => Number.isFinite(r.v));
    const ranked = finite.some((r) => !r.small) ? finite.filter((r) => !r.small) : finite;
    const pick = showMin ? ranked[ranked.length - 1] : ranked[0];
    if (pick) {
      const label = `${showMin ? 'мин.' : 'макс.'} ${fmtMetric(metric, pick.v)}: `;
      const tx = Math.min(sx + list.length * (size + gap) + 10, x + w - 190);
      g.append(text(tx, ry + 15, label + fit(pick.a.key, x + w - 24 - tx - textWidth(label, 12), 12), { size: 12, fill: T.ink2 }));
    }
    ry += 30;
  }
  return g;
}

function quartersSvg(T, data, x, y, w, o) {
  const g = el('g', null);
  if (!data.hasEdc) {
    g.append(text(x + 24, y + 80, 'Заявки появятся после загрузки выгрузок ЕДЦ.', { size: 14, fill: T.muted }));
    return g;
  }
  const cols = [['q1', 'I кв.'], ['q2', 'II кв.'], ['q3', 'III кв.'], ['q4', 'IV кв.*'], ['', 'Весь 2026']];
  const rows = OKRUGS.map((ok) => ({ ok, kk: data.okrugs.get(ok.code) })).filter((r) => r.kk && r.kk.served)
    .sort((a, b) => metricValue(b.kk, 'reqPerHouse') - metricValue(a.kk, 'reqPerHouse'));
  g.append(text(x + 24, y + 58, 'В клетке: заявок за квартал на один обслуживаемый дом. * IV квартал неполный: выгрузка сделана в его начале.', { size: 12, fill: T.muted }));
  const vals = rows.flatMap((r) => ['q1', 'q2', 'q3'].map((q) => metricValue(r.kk, 'reqPerHouse', q)));
  const dom = domain(vals, 'reqPerHouse');
  const lx = x + 24;
  const cx0 = x + 96;
  const cw = (w - 96 - 24 - 4 * 6) / 5;
  const top = y + 84;
  cols.forEach(([, label], i) => g.append(text(cx0 + i * (cw + 6) + cw / 2, top, label, { size: 12, weight: 600, fill: T.ink2, anchor: 'middle' })));
  rows.forEach(({ ok, kk }, ri) => {
    const ry = top + 10 + ri * 30;
    g.append(text(lx, ry + 17, ok.code, { size: 13, weight: 600, fill: T.ink }));
    cols.forEach(([q], ci) => {
      const v = metricValue(kk, 'reqPerHouse', q);
      const cx = cx0 + ci * (cw + 6);
      if (!q) {
        g.append(el('rect', { x: cx, y: ry, width: cw, height: 24, rx: 5, fill: 'none', stroke: T.border }));
        g.append(text(cx + cw / 2, ry + 16.5, fmt.num1(v), { size: 13, weight: 700, fill: T.ink, anchor: 'middle' }));
        return;
      }
      const c = rampOf(T, 'reqPerHouse', dom, v);
      const cell = el('rect', { x: cx, y: ry, width: cw, height: 24, rx: 5, fill: c.fill });
      tip(cell, () => [div(null, Object.assign(document.createElement('b'), { textContent: `${ok.full}, ${cols[ci][1]}` })),
        div(null, `Заявок: ${fmt.int(kk.rc[q])}, на обслуживаемый дом ${fmt.num1(v)}`), div('muted', `Обслуживаемых домов: ${fmt.int(kk.served)}`)]);
      g.append(cell, text(cx + cw / 2, ry + 16.5, fmt.num1(v), { size: 12.5, weight: 600, fill: c.ink, anchor: 'middle' }));
    });
  });
  return g;
}

function listSvg(T, data, kind, x, y, w, o) {
  const g = el('g', null);
  if (!data.hasEdc) {
    g.append(text(x + 24, y + 80, 'Список появится после загрузки выгрузок ЕДЦ.', { size: 14, fill: T.muted }));
    return g;
  }
  const metric = kind === 'low' ? 'servedShare' : 'reqPerHouse';
  const all = data.areas.filter((a) => a.okrug !== NO_OKRUG && Number.isFinite(metricValue(a.k, metric)));
  const big = all.filter((a) => !smallSampleFor(a.k, metric));
  const pool = big.length >= 3 ? big : all; // на малых данных показать все районы
  pool.sort((a, b) => (kind === 'low'
    ? metricValue(a.k, metric) - metricValue(b.k, metric) || b.k.hs.none - a.k.hs.none
    : metricValue(b.k, metric) - metricValue(a.k, metric)));
  const top = pool.slice(0, 8);
  const head = kind === 'low' ? ['Район', 'Округ', 'Обслуживается', 'Не обслуж.'] : ['Район', 'Округ', 'Заявок на дом', 'Домов'];
  const cx = [x + 52, x + w - 300, x + w - 124, x + w - 24];
  head.forEach((t, i) => g.append(text(cx[i], y + 64, t, { size: 12, weight: 600, fill: T.muted, anchor: i >= 2 ? 'end' : null })));
  g.append(el('line', { x1: x + 24, x2: x + w - 24, y1: y + 74, y2: y + 74, stroke: T.grid }));
  top.forEach((a, i) => {
    const ry = y + 98 + i * 28;
    const row = el('g', null,
      el('rect', { x: x + 16, y: ry - 19, width: w - 32, height: 26, rx: 6, fill: 'transparent' }),
      text(x + 24, ry, String(i + 1), { size: 12.5, fill: T.muted }),
      text(cx[0], ry, fit(a.key + (smallSampleFor(a.k, metric) ? ' *' : ''), cx[1] - cx[0] - 12, 13), { size: 13, fill: T.ink }),
      text(cx[1], ry, a.okrug, { size: 13, fill: T.ink2 }),
      text(cx[2], ry, fmtMetric(metric, metricValue(a.k, metric)), { size: 13, weight: 700, fill: T.ink, anchor: 'end' }),
      text(cx[3], ry, fmt.int(kind === 'low' ? a.k.hs.none : a.k.served), { size: 13, fill: T.ink2, anchor: 'end' }));
    tip(row, () => [div(null, Object.assign(document.createElement('b'), { textContent: a.key })), div('muted', okrugByCode(a.okrug)?.full || a.okrug),
      div(null, `Домов МЖИ ${fmt.int(a.k.mkd)}, обслуживаются ${fmt.int(a.k.served)} (${fmt.pct(a.k.servedShare)}), частично ${fmt.int(a.k.hs.partial)}`),
      div(null, `Заявок 2026: ${fmt.int(a.k.rc.total)}, на дом ${fmt.num1(metricValue(a.k, 'reqPerHouse'))}`),
      div('muted', 'Клик открывает список домов района')]);
    if (o.onArea) row.addEventListener('click', () => o.onArea(a.okrug, a.key));
    g.append(row);
  });
  if (!top.length) g.append(text(x + 24, y + 100, 'Нет районов с достаточным числом домов.', { size: 13, fill: T.muted }));
  return g;
}

// ---------------------------------------------------------------- PNG

/** Картинка в PNG (светлая тема, удвоенное разрешение). */
export async function posterPng(data, o) {
  const svg = buildPoster(data, { ...o, theme: 'light', onOkrug: null, onArea: null });
  const str = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([str], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('картинка не построилась')); img.src = url; });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = svg.width.baseVal.value * scale;
    canvas.height = svg.height.baseVal.value * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    return await new Promise((res) => canvas.toBlob(res, 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}
