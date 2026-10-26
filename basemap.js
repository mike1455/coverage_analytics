// Офлайн-карта Москвы. Скачивается один раз через serve.py в data/local/moscow.pmtiles
// и дальше открывается без интернета. Обновление по кнопке: прежний файл заменяется
// только после успешной загрузки, поэтому прерванное обновление карту не портит.

import { h, clear, fmt, icon, toast } from './ui.js';

const API = 'api/basemap';
let state = { api: false, exists: false, job: { state: 'idle' } };
let timer = null;
const listeners = new Set();

/** Подписка на изменения: fn(state, event), event = 'update' | 'done'. */
export function onBasemap(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function basemapState() {
  return state;
}

export async function refreshBasemap() {
  const before = state.job && state.job.state;
  try {
    const r = await fetch(API, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    state = { api: true, ...(await r.json()) };
  } catch (_) {
    state = { api: false, exists: false, job: { state: 'idle' } };
  }
  const running = state.job && state.job.state === 'running';
  if (running && !timer) timer = setInterval(refreshBasemap, 1000);
  if (!running && timer) { clearInterval(timer); timer = null; }
  const event = before === 'running' && state.job.state === 'done' ? 'done' : 'update';
  for (const fn of [...listeners]) fn(state, event);
  return state;
}

async function post(path, body = {}) {
  const r = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

export async function startBasemapDownload(opts = {}) {
  try {
    await post('download', opts);
  } catch (e) {
    toast(`Не удалось начать загрузку карты: ${e.message}`, 'error', 7000);
  }
  return refreshBasemap();
}

export async function cancelBasemapDownload() {
  await post('cancel').catch(() => null);
  return refreshBasemap();
}

/** Короткий статус для меню: «от 20.10.2026», «загрузка 45%», «не скачана». */
export function basemapShort(s = state) {
  const job = s.job || {};
  if (job.state === 'running') return job.total ? `загрузка ${Math.floor((job.done / job.total) * 100)}%` : 'загрузка';
  if (!s.exists) return 'не скачана';
  const d = buildDate(s.meta);
  return d ? `данные OSM от ${d}` : 'сохранена';
}

function buildDate(meta) {
  const b = meta && meta.build;
  return b && /^\d{8}$/.test(b) ? `${b.slice(6, 8)}.${b.slice(4, 6)}.${b.slice(0, 4)}` : '';
}

/** Блок «Офлайн-карта» со статусом и кнопками. Сам перерисовывается, пока находится в документе. */
export function basemapPanel() {
  const el = h('div', { class: 'basemap-panel stack' });
  const draw = () => {
    clear(el);
    const s = state;
    const job = s.job || { state: 'idle' };
    if (!s.api) {
      el.append(h('div', { class: 'small ink2' }, 'Скачать карту можно, когда приложение запущено через start.bat (или py -3 serve.py).'));
      return;
    }
    if (job.state === 'running') {
      const pct = job.total ? Math.min(100, (job.done / job.total) * 100) : 0;
      el.append(...[
        h('div', { class: 'small' }, job.stage || 'Загрузка'),
        h('div', { class: `progress ${job.total ? '' : 'indeterminate'}` }, h('i', { style: { width: job.total ? `${pct.toFixed(1)}%` : '30%' } })),
        h('div', { class: 'row-between small muted' },
          h('span', null, job.total ? `${fmt.bytes(job.done)} из ${fmt.bytes(job.total)}` : 'Подготовка'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => cancelBasemapDownload() }, 'Отменить')),
        s.exists ? h('div', { class: 'small muted' }, 'Пока идёт загрузка, работает прежняя карта.') : null].filter(Boolean));
      return;
    }
    if (s.exists) {
      const date = buildDate(s.meta);
      el.append(
        h('div', { class: 'basemap-ok' }, icon('checkCircle', 16),
          h('div', null, h('div', null, h('b', null, 'Карта сохранена на компьютере')),
            h('div', { class: 'small ink2' }, [date ? `данные OSM от ${date}` : null, fmt.bytes(s.size)].filter(Boolean).join(', ')))),
        h('div', { class: 'actions-row' },
          h('button', { class: 'btn btn-sm', onclick: () => startBasemapDownload() }, icon('refresh', 14), 'Обновить карту')));
    } else {
      el.append(
        h('div', { class: 'small ink2' }, 'Карта Москвы скачивается один раз и хранится в папке приложения (data/local). После этого она открывается без интернета. Объём несколько сотен мегабайт, загрузка занимает от 5 до 20 минут.'),
        h('div', { class: 'actions-row' },
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => startBasemapDownload() }, icon('download', 14), 'Скачать карту Москвы')));
    }
    if (job.state === 'error') el.append(h('div', { class: 'note warn small' }, icon('warn'), h('div', null, job.message || 'Ошибка загрузки')));
    if (job.state === 'cancelled') el.append(h('div', { class: 'small muted' }, job.message));
    el.append(h('div', { class: 'small muted' }, 'Источник: OpenStreetMap (ODbL), сборка Protomaps.'));
  };
  const off = onBasemap(() => { if (!el.isConnected) { off(); return; } draw(); });
  draw();
  return el;
}
