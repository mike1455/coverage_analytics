// Лёгкие HTML/SVG-графики: горизонтальные столбцы рейтинга, составная полоса структуры покрытия,
// схема 12 округов (условная раскладка, не в масштабе). Подписи — текстовыми токенами, цвет — только для меток.

import { h, fmt } from './ui.js';
import { OKRUGS } from './core/okrugs.js';

// ---------- общий тултип ----------
let tipEl = null;
export function showTip(ev, content) {
  if (!tipEl) { tipEl = h('div', { class: 'tooltip', role: 'tooltip' }); document.body.appendChild(tipEl); }
  tipEl.replaceChildren(...(Array.isArray(content) ? content : [content]));
  tipEl.style.display = 'block';
  const pad = 14;
  const r = tipEl.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
}
export function hideTip() { if (tipEl) tipEl.style.display = 'none'; }

function withTip(el, fn) {
  el.addEventListener('mousemove', (e) => showTip(e, fn()));
  el.addEventListener('mouseleave', hideTip);
  return el;
}

// ---------- последовательная шкала (один оттенок, светлый → тёмный) ----------
const SEQ = ['--seq-100', '--seq-200', '--seq-300', '--seq-400', '--seq-500', '--seq-600', '--seq-700'];
export function seqVar(t) {
  if (t === null || t === undefined || Number.isNaN(t)) return null;
  const i = Math.max(0, Math.min(SEQ.length - 1, Math.round(t * (SEQ.length - 1))));
  return { color: `var(${SEQ[i]})`, ink: `var(${SEQ[i].replace('--seq-', '--seq-ink-')})` };
}
export function seqColorResolved(t) {
  const v = seqVar(t);
  if (!v) return null;
  return getComputedStyle(document.documentElement).getPropertyValue(v.color.slice(4, -1)).trim();
}

/**
 * Горизонтальные столбцы рейтинга.
 * items: [{key, label, value, rank, valueText, sub, muted, tip: () => Node[]}]
 */
export function barChart(items, { onClick, selected, max } = {}) {
  const vmax = max ?? Math.max(0, ...items.map((i) => (Number.isFinite(i.value) ? i.value : 0)));
  return h('div', { class: 'bars', role: 'list' }, items.map((it) => {
    const w = Number.isFinite(it.value) && vmax > 0 ? (it.value / vmax) * 100 : 0;
    const row = h('div', {
      class: `bar-row ${selected === it.key ? 'sel' : ''}`, role: 'listitem', tabindex: 0,
      onclick: () => onClick && onClick(it.key),
      onkeydown: (e) => { if (e.key === 'Enter' && onClick) onClick(it.key); },
    },
    h('div', { class: 'rank' }, it.rank ? `${it.rank}` : '—'),
    h('div', { class: 'lbl' }, it.label),
    h('div', { class: 'bar-track' }, Number.isFinite(it.value) ? h('div', { class: `bar-fill ${it.muted ? 'muted-fill' : ''}`, style: { width: `${w}%` } }) : null),
    h('div', { class: 'bar-val' }, it.valueText, it.sub ? h('small', null, it.sub) : null));
    if (it.tip) withTip(row, it.tip);
    return row;
  }));
}

/** Составная полоса: parts [{key, value, color, label}] с 2px разделителями. */
export function stackBar(parts, { tip } = {}) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  const bar = h('div', { class: 'stack-bar', role: 'img', 'aria-label': parts.map((p) => `${p.label}: ${p.value}`).join(', ') },
    parts.filter((p) => p.value > 0).map((p) => {
      const seg = h('i', { style: { flexGrow: String(p.value), flexBasis: '0', background: p.color } });
      withTip(seg, () => [h('b', null, p.label), h('div', null, `${fmt.int(p.value)} (${fmt.pct(total ? p.value / total : null)})`), tip ? tip(p) : null]);
      return seg;
    }));
  return bar;
}

export function legend(parts) {
  return h('div', { class: 'stack-legend' }, parts.map((p) => h('span', null, h('i', { class: 'sw', style: { background: p.color } }), p.label, p.value !== undefined ? h('span', { class: 'muted num' }, fmt.int(p.value)) : null)));
}

/**
 * Схема округов: плитки в условной раскладке «как на карте».
 * groups: Map(code → {value, valueText, n, flag, tip})
 */
export function okrugTiles(groups, { onClick, selected, min, max } = {}) {
  const vals = [...groups.values()].map((g) => g.value).filter((v) => Number.isFinite(v));
  const lo = min ?? Math.min(...vals);
  const hi = max ?? Math.max(...vals);
  const cells = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      const o = OKRUGS.find((x) => x.grid[0] === col && x.grid[1] === row);
      if (!o) { cells.push(h('div', { class: 'tile empty-cell', 'aria-hidden': 'true' })); continue; }
      const g = groups.get(o.code) || {};
      const t = Number.isFinite(g.value) && hi > lo ? (g.value - lo) / (hi - lo) : Number.isFinite(g.value) ? 0.5 : null;
      const sv = seqVar(t);
      const tile = h('div', {
        class: `tile ${selected && selected !== o.code ? 'dim' : ''} ${selected === o.code ? 'sel' : ''}`,
        style: sv ? { background: sv.color, color: sv.ink } : {},
        role: 'button', tabindex: 0, 'aria-label': `${o.full}: ${g.valueText || 'нет данных'}`,
        onclick: () => onClick && onClick(o.code),
        onkeydown: (e) => { if (e.key === 'Enter' && onClick) onClick(o.code); },
      },
      h('div', { class: 't-code' }, o.code),
      g.flag ? h('div', { class: 't-flag', title: g.flagTitle || '' }, g.flag) : null,
      h('div', null, h('div', { class: 't-val' }, g.valueText ?? '—'), g.n ? h('div', { class: 't-n' }, g.n) : null));
      if (g.tip) withTip(tile, g.tip);
      cells.push(tile);
    }
  }
  return h('div', null,
    h('div', { class: 'tiles' }, cells),
    vals.length ? h('div', { class: 'scale' }, h('span', null, 'меньше'), h('div', { class: 'bar' }), h('span', null, 'больше')) : null);
}
