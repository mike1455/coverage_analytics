// Небольшие помощники интерфейса: создание DOM без innerHTML (данные из CSV никогда не вставляются как HTML),
// форматирование чисел по-русски, модальные окна, уведомления, иконки.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** h('div', {class: 'x', onclick: fn}, 'текст', childNode) */
export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || tag === 'path' || tag === 'circle' || tag === 'rect' || tag === 'g' || tag === 'line' || tag === 'polyline' || tag === 'text'
    ? document.createElementNS('http://www.w3.org/2000/svg', tag)
    : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'value' && 'value' in el) el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Подпись для отсутствующего значения */
export const NA = 'н/д';
export const na = () => h('span', { class: 'na' }, NA);

const nf = new Intl.NumberFormat('ru-RU');
const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const fmt = {
  int: (n) => (n === null || n === undefined || Number.isNaN(n) ? NA : nf.format(Math.round(n))),
  num1: (n) => (n === null || n === undefined || Number.isNaN(n) ? NA : nf1.format(n)),
  pct: (x, digits = 1) => {
    if (x === null || x === undefined || Number.isNaN(x)) return NA;
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(x * 100) + '%';
  },
  date: (s) => {
    if (!s) return NA;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}.${m[2]}.${m[1]}` : String(s);
  },
  dateTime: (s) => {
    if (!s) return NA;
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(s);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  },
  bytes: (n) => {
    if (!n && n !== 0) return NA;
    const u = ['Б', 'КБ', 'МБ', 'ГБ'];
    let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${nf1.format(v)} ${u[i]}`;
  },
  bool: (v) => (v === true ? 'true' : v === false ? 'false' : 'не определено'),
};

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// ---------- иконки (inline SVG, 24×24, stroke) ----------
const ICONS = {
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Zm0 0v14m6-12v14',
  flame: 'M12 3c1 3 4 5 4 9a4 4 0 1 1-8 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-5 0-8Z',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H3',
  building: 'M4 21V5l8-3v19M12 9h8v12M7 8h2m-2 4h2m-2 4h2m6-4h2m-2 4h2M3 21h18',
  upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  search: 'm20 20-4.5-4.5M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z',
  check: 'm5 12 4.5 4.5L19 7',
  checkCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-4-9 2.8 2.8L16 9.5',
  half: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-18v18',
  xCircle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-3-12 6 6m0-6-6 6',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm-2.5-11.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14m0 3h.01',
  slash: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  close: 'm6 6 12 12M18 6 6 18',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-15v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z',
  pin: 'M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  polygon: 'M5 7 12 3l7 4v9l-7 5-7-5V7Z',
  download: 'M12 4v12m0 0-4-4m4 4 4-4M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-11v6m0-9h.01',
  warn: 'M12 3 2 20h20L12 3Zm0 6v5m0 3h.01',
  copy: 'M8 8h11v11H8zM5 16H4V5h11v1',
  layers: 'm12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  trash: 'M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
};

export function icon(name, size = 18, cls = '') {
  const svg = h('svg', { viewBox: '0 0 24 24', width: size, height: size, class: `icon ${cls}`, 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
  svg.appendChild(h('path', { d: ICONS[name] || ICONS.info }));
  return svg;
}

// ---------- статусы покрытия: цвет + иконка + подпись (никогда только цвет) ----------
export const STATUS = {
  full: { color: 'var(--st-good)', icon: 'checkCircle', label: 'Все подъезды с привязкой' },
  partial: { color: 'var(--st-serious)', icon: 'half', label: 'Частичная привязка' },
  none: { color: 'var(--st-critical)', icon: 'xCircle', label: 'Нет найденной привязки' },
  na: { color: 'var(--st-unknown)', icon: 'help', label: 'Недостаточно данных' },
  excluded: { color: 'var(--st-excluded)', icon: 'slash', label: 'Неактуальный / нежилой (ЕДЦ)' },
};

export function statusBadge(cov, text) {
  const s = STATUS[cov] || STATUS.na;
  return h('span', { class: `badge st-${cov}` }, icon(s.icon, 14), text || s.label);
}

// ---------- уведомления ----------
export function toast(message, kind = 'info', ms = 4000) {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', class: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(box); }
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(kind === 'error' ? 'warn' : kind === 'ok' ? 'checkCircle' : 'info', 18), h('span', null, message));
  box.appendChild(t);
  while (box.childNodes.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

// ---------- модальное окно ----------
export function modal({ title, body, actions = [], wide = false, onClose, dismissable = true }) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  const bodyBox = h('div', { class: 'modal-body' }, body);
  const actBox = h('div', { class: 'modal-actions' });
  const setActions = (list) => {
    clear(actBox);
    for (const a of list) {
      actBox.appendChild(h('button', {
        class: `btn ${a.kind ? `btn-${a.kind}` : ''}`, disabled: a.disabled,
        onclick: async (ev) => { if (a.onClick) { const r = await a.onClick(ev); if (r === false) return; } if (a.close !== false) close(); },
      }, a.icon ? icon(a.icon, 16) : null, a.label));
    }
  };
  setActions(actions);
  const titleEl = h('h2', null, title);
  const dlg = h('div', { class: `modal ${wide ? 'modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, titleEl,
      dismissable ? h('button', { class: 'icon-btn', 'aria-label': 'Закрыть', onclick: close }, icon('close')) : null),
    bodyBox, actBox);
  back.appendChild(dlg);
  back.addEventListener('mousedown', (e) => { if (e.target === back && dismissable) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(back);
  return {
    close,
    setBody: (node) => { clear(bodyBox); bodyBox.appendChild(node); },
    setActions,
    setTitle: (t) => { titleEl.textContent = t; },
    el: dlg,
  };
}

export function confirmDialog(title, text, okLabel = 'Подтвердить', kind = 'primary') {
  return new Promise((resolve) => {
    let done = false;
    modal({
      title,
      body: h('p', null, text),
      actions: [
        { label: 'Отмена', onClick: () => { done = true; resolve(false); } },
        { label: okLabel, kind, onClick: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function copyText(text) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Скопировано', 'ok', 1500)).catch(() => {});
}

/** Строка «ключ - значение» для карточек. */
export function kv(label, value, opts = {}) {
  const v = value === null || value === undefined || value === '' ? h('span', { class: 'na' }, opts.empty || NA) : value;
  return h('div', { class: 'kv' }, h('div', { class: 'kv-k' }, label),
    h('div', { class: `kv-v ${opts.mono ? 'mono' : ''}` }, v,
      opts.copy && value ? h('button', { class: 'icon-btn tiny', title: 'Копировать', 'aria-label': 'Копировать', onclick: () => copyText(String(opts.copy === true ? value : opts.copy)) }, icon('copy', 14)) : null));
}

export function select(options, value, onChange, attrs = {}) {
  const s = h('select', { ...attrs, onchange: (e) => onChange(e.target.value) },
    options.map(([v, label, dis]) => h('option', { value: v, selected: v === value, disabled: dis }, label)));
  return s;
}
