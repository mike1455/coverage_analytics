// Координаты всех домов реестра МЖИ по адресам OpenStreetMap.
// 1) serve.py один раз скачивает адреса зданий Москвы через Overpass API в data/local/osm/moscow_addresses.json;
// 2) приложение сопоставляет с ними адреса МЖИ (core/addrmatch.js) и сохраняет точки в браузере
//    и копией в data/local/geocoded_houses.csv. Точки, указанные или проверенные вручную, не меняются.

import { h, clear, fmt, icon, toast, modal, download } from './ui.js';
import { putMany } from './storage.js';
import { buildIndex, matchAddress } from './core/addrmatch.js';
import { toCsv } from './core/csv.js';

const API = 'api/addresses';
let state = { api: false, exists: false, job: { state: 'idle' } };
let timer = null;
const listeners = new Set();

export function onAddresses(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function addressesState() {
  return state;
}

export async function refreshAddresses() {
  try {
    const r = await fetch(API, { cache: 'no-store' });
    if (!r.ok) throw new Error(String(r.status));
    state = { api: true, ...(await r.json()) };
  } catch (_) {
    state = { api: false, exists: false, job: { state: 'idle' } };
  }
  const running = state.job && state.job.state === 'running';
  if (running && !timer) timer = setInterval(refreshAddresses, 1500);
  if (!running && timer) { clearInterval(timer); timer = null; }
  for (const fn of [...listeners]) fn(state);
  return state;
}

async function post(path, body = {}) {
  const r = await fetch(`${API}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

const KEEP = new Set(['manual', 'verified', 'imported', 'auto']); // эти точки поиск по OSM не трогает

/**
 * Найти координаты домов без геопозиции (и обновить найденные ранее по OSM).
 * @returns {Promise<{total, matched, kept, ambiguous, notfound, unparsed, missing: Array}>}
 */
export async function geocodeAll(app, { onProgress = () => {} } = {}) {
  onProgress('Чтение справочника адресов', 0);
  const res = await fetch(`${state.url || 'data/local/osm/moscow_addresses.json'}?v=${state.mtime || Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Справочник адресов не найден. Сначала скачайте его.');
  const doc = await res.json();
  onProgress('Подготовка справочника', 5);
  await new Promise((r) => setTimeout(r, 0));
  const index = buildIndex(doc.rows || []);
  const rows = app.state.rows;
  const now = new Date().toISOString();
  const stats = { total: rows.length, matched: 0, kept: 0, ambiguous: 0, notfound: 0, unparsed: 0, missing: [] };
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = app.state.geo.get(r.u);
    if (prev && KEEP.has(prev.status)) { stats.kept++; continue; }
    const m = matchAddress(index, r.address);
    if (m.status === 'ok') {
      stats.matched++;
      out.push({
        ...(prev || {}), u: r.u, ur: r.ur, lat: m.lat, lon: m.lon, building: prev ? prev.building || null : null,
        source: `OpenStreetMap, адрес (${fmt.date(doc.downloadedAt)})`,
        accuracy: m.exact ? (m.type === 'n' ? 'адресная точка OSM, адрес совпал' : 'здание OSM, адрес совпал') : 'здание OSM, совпал адрес без типа улицы',
        status: 'osm', verified_at: '', address_at_geocode: r.address, review: m.exact ? '' : 'тип улицы не совпал', updated_at: now,
      });
    } else {
      stats[m.status]++;
      stats.missing.push({ r, why: { ambiguous: 'несколько зданий с таким адресом', notfound: 'адрес не найден в OSM', unparsed: 'адрес не разобран' }[m.status] });
    }
    if (i % 2000 === 0) {
      onProgress(`Сопоставление адресов: ${fmt.int(i)} из ${fmt.int(rows.length)}`, 10 + (i / rows.length) * 70);
      await new Promise((r2) => setTimeout(r2, 0));
    }
  }
  for (let i = 0; i < out.length; i += 2000) {
    onProgress(`Сохранение: ${fmt.int(i)} из ${fmt.int(out.length)}`, 80 + (i / Math.max(1, out.length)) * 15);
    await putMany('geo', out.slice(i, i + 2000));
  }
  await app.reloadGeo();
  onProgress('Копия в файл', 97);
  stats.file = await saveGeocodedFile(app).catch(() => null);
  return stats;
}

/** Все точки домов → data/local/geocoded_houses.csv (через serve.py). */
export async function saveGeocodedFile(app) {
  const byU = new Map(app.state.rows.map((r) => [r.u, r]));
  const rows = [...app.state.geo.values()].map((g) => [g.ur || g.u, g.lat, g.lon, g.source || '', g.accuracy || '', g.status || '', byU.get(g.u)?.address || g.address_at_geocode || '']);
  const csv = toCsv(['unom', 'lat', 'lon', 'source', 'accuracy', 'status', 'address'], rows).replace(/^﻿/, '');
  const r = await fetch('api/geocoded', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ csv }) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).saved;
}

function missingCsv(list) {
  return toCsv(['unom', 'округ', 'район', 'адрес МЖИ', 'причина'], list.map(({ r, why }) => [r.ur, r.okrug, r.area, r.address, why]));
}

/** Окно «Координаты домов по адресам». */
export function openGeocodeDialog(app) {
  const body = h('div', { class: 'stack', style: { gap: '12px' } });
  const dlg = modal({ title: 'Координаты домов по адресам', body, wide: false, actions: [{ label: 'Закрыть' }] });
  let result = null;
  let busy = null;
  const draw = () => {
    clear(body);
    const s = state;
    const job = s.job || {};
    body.append(h('p', { class: 'ink2', style: { margin: 0 } },
      'Координаты домов ищутся по адресам зданий из OpenStreetMap. Справочник адресов Москвы скачивается один раз (несколько минут), дальше поиск идёт на этом компьютере без интернета. Найденные точки сохраняются в браузере и копией в файл data/local/geocoded_houses.csv.'));
    // Шаг 1: справочник
    const step1 = h('div', { class: 'card stack', style: { gap: '8px', padding: '12px 14px' } }, h('b', null, '1. Справочник адресов OSM'));
    if (!s.api) {
      step1.append(h('div', { class: 'small ink2' }, 'Скачать справочник можно, когда приложение запущено через start.bat (py -3 serve.py).'));
    } else if (job.state === 'running') {
      step1.append(h('div', { class: 'small' }, job.stage || 'Загрузка'),
        h('div', { class: `progress ${job.total ? '' : 'indeterminate'}` }, h('i', { style: { width: job.total ? `${(job.done / job.total) * 100}%` : '30%' } })),
        h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => post('cancel').then(refreshAddresses) }, 'Отменить')));
    } else {
      step1.append(s.exists
        ? h('div', { class: 'basemap-ok' }, icon('checkCircle', 16), h('div', null, h('div', null, `Адресов: ${fmt.int(s.count)}`), h('div', { class: 'small ink2' }, `скачан ${fmt.dateTime(s.downloadedAt)}, ${fmt.bytes(s.size)}`)))
        : h('div', { class: 'small ink2' }, 'Справочник ещё не скачан.'),
      h('div', { class: 'actions-row' }, h('button', {
        class: `btn btn-sm ${s.exists ? '' : 'btn-primary'}`,
        onclick: async () => { try { await post('download'); } catch (e) { toast(`Не удалось начать загрузку: ${e.message}`, 'error', 7000); } refreshAddresses(); },
      }, icon(s.exists ? 'refresh' : 'download', 14), s.exists ? 'Обновить справочник' : 'Скачать адреса Москвы')));
      if (job.state === 'error') step1.append(h('div', { class: 'note warn small' }, icon('warn'), h('div', null, job.message)));
      if (job.state === 'cancelled') step1.append(h('div', { class: 'small muted' }, job.message));
    }
    body.append(step1);
    // Шаг 2: поиск
    const noGeo = app.state.rows.filter((r) => !app.state.geo.has(r.u)).length;
    const step2 = h('div', { class: 'card stack', style: { gap: '8px', padding: '12px 14px' } }, h('b', null, '2. Поиск координат'),
      h('div', { class: 'small ink2' }, `Домов в реестре: ${fmt.int(app.state.rows.length)}, без координат: ${fmt.int(noGeo)}. Точки, указанные или проверенные вручную, не изменятся.`));
    if (busy) {
      step2.append(h('div', { class: 'small' }, busy.text), h('div', { class: 'progress' }, h('i', { style: { width: `${busy.pct}%` } })));
    } else {
      step2.append(h('div', { class: 'actions-row' }, h('button', {
        class: 'btn btn-sm btn-primary', disabled: !s.exists || job.state === 'running' || !app.state.rows.length,
        onclick: async () => {
          busy = { text: 'Подготовка', pct: 0 };
          draw();
          try {
            result = await geocodeAll(app, { onProgress: (text, pct) => { busy = { text, pct }; draw(); } });
            toast(`Найдены координаты ${fmt.int(result.matched)} домов`, 'ok');
          } catch (e) {
            toast(e.message, 'error', 7000);
          }
          busy = null;
          draw();
        },
      }, icon('search', 14), 'Найти координаты домов')));
    }
    if (result) {
      const pct = result.total ? (app.state.geo.size / result.total) : 0;
      step2.append(h('div', { class: 'note ok small' }, icon('checkCircle'), h('div', null,
        h('div', null, h('b', null, `Найдено по адресу: ${fmt.int(result.matched)}`), `. Всего с координатами ${fmt.int(app.state.geo.size)} из ${fmt.int(result.total)} (${fmt.pct(pct)}).`),
        h('div', null, `Не найдено: ${fmt.int(result.notfound)}, неоднозначно: ${fmt.int(result.ambiguous)}, не разобрано: ${fmt.int(result.unparsed)}, оставлено как было: ${fmt.int(result.kept)}.`),
        result.file ? h('div', { class: 'muted' }, `Копия сохранена: ${result.file}`) : null)));
      if (result.missing.length) {
        step2.append(h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-sm', onclick: () => download(new Blob([missingCsv(result.missing)], { type: 'text/csv;charset=utf-8' }), 'дома_без_координат.csv') }, icon('download', 14), 'Список ненайденных (CSV)')),
          h('div', { class: 'small muted' }, 'Ненайденные дома можно привязать в карточке дома: поиск OSM по одному адресу или точка на карте.'));
      }
    }
    body.append(step2, h('div', { class: 'small muted' }, 'Данные © участники OpenStreetMap (ODbL). Отправляется только запрос на адреса всей Москвы, данные МЖИ и ЕДЦ никуда не передаются.'));
  };
  const off = onAddresses(() => { if (!body.isConnected) { off(); return; } if (!busy) draw(); });
  draw();
  refreshAddresses();
  return dlg;
}
