// Координаты всех домов реестра МЖИ одной кнопкой.
// 1) Адреса зданий Москвы из OpenStreetMap: serve.py скачивает их один раз через Overpass API
//    в data/local/osm/moscow_addresses.json (если файла ещё нет);
// 2) адреса МЖИ сопоставляются с ними в браузере (core/addrmatch.js);
// 3) оставшиеся дома ищутся через Яндекс Геокодер, если на этом компьютере указан ключ API.
// Точки сохраняются в браузере и копией в data/local/geocoded_houses.csv.
// Точки, указанные вручную, проверенные или загруженные из файла, не меняются.

import { h, clear, fmt, icon, toast, modal, download } from './ui.js';
import { putMany } from './storage.js';
import { buildIndex, matchAddress } from './core/addrmatch.js';
import { toCsv } from './core/csv.js';
import { inMoscow } from './geo.js';

const KEEP = new Set(['manual', 'verified', 'imported', 'auto', 'yandex']); // поиск по OSM эти точки не трогает
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function postJson(url, body = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 409) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

/** Ждать окончания фоновой задачи serve.py, сообщая её ход. */
async function waitJob(url, onTick) {
  for (;;) {
    const st = await getJson(url);
    onTick(st);
    if (!st.job || st.job.state !== 'running') return st;
    await sleep(1000);
  }
}

export const addressesState = () => getJson('api/addresses').then((s) => ({ api: true, ...s })).catch(() => ({ api: false }));
export const yandexState = () => getJson('api/yandex').then((s) => ({ api: true, ...s })).catch(() => ({ api: false }));

/** Шаг 2: сопоставить адреса МЖИ со справочником OSM. */
export async function matchOsm(app, addr, onProgress = () => {}) {
  onProgress('Чтение справочника адресов', 0);
  const res = await fetch(`${addr.url || 'data/local/osm/moscow_addresses.json'}?v=${addr.mtime || Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Справочник адресов OSM не найден');
  const doc = await res.json();
  onProgress('Подготовка справочника', 3);
  await tick();
  const index = buildIndex(doc.rows || []);
  const rows = app.state.rows;
  const now = new Date().toISOString();
  const stats = { matched: 0, kept: 0, ambiguous: 0, notfound: 0, unparsed: 0 };
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
    }
    if (i % 2000 === 0) {
      onProgress(`${fmt.int(i)} из ${fmt.int(rows.length)}`, 5 + (i / rows.length) * 85);
      await tick();
    }
  }
  for (let i = 0; i < out.length; i += 2000) await putMany('geo', out.slice(i, i + 2000));
  await app.reloadGeo();
  return stats;
}

/** Шаг 3: принять ответы Яндекс Геокодера. Берутся только дома (kind=house) в границах Москвы. */
export function yandexRecords(app, results, now = new Date().toISOString()) {
  const out = [];
  const byU = new Map(app.state.rows.map((r) => [r.u, r]));
  for (const [u, hit] of Object.entries(results || {})) {
    const r = byU.get(u);
    if (!r || !hit || hit.none || app.state.geo.has(u)) continue;
    if (hit.kind !== 'house' || !['exact', 'number', 'near'].includes(hit.precision) || !inMoscow(hit.lat, hit.lon)) continue;
    const exact = hit.precision === 'exact';
    out.push({
      u, ur: r.ur, lat: hit.lat, lon: hit.lon, building: null, source: `Яндекс Геокодер: ${hit.text || ''}`,
      accuracy: exact ? 'Яндекс, адрес совпал' : hit.precision === 'number' ? 'Яндекс, совпал номер дома без корпуса' : 'Яндекс, ближайший дом',
      status: 'yandex', verified_at: '', address_at_geocode: r.address, review: exact ? '' : 'адрес совпал не полностью', updated_at: now,
    });
  }
  return out;
}

/** Все точки домов → data/local/geocoded_houses.csv (через serve.py). */
export async function saveGeocodedFile(app) {
  const byU = new Map(app.state.rows.map((r) => [r.u, r]));
  const rows = [...app.state.geo.values()].map((g) => [g.ur || g.u, g.lat, g.lon, g.source || '', g.accuracy || '', g.status || '', byU.get(g.u)?.address || g.address_at_geocode || '']);
  const csv = toCsv(['unom', 'lat', 'lon', 'source', 'accuracy', 'status', 'address'], rows).replace(/^﻿/, '');
  return (await postJson('api/geocoded', { csv })).saved;
}

function missingCsv(app) {
  const list = app.state.rows.filter((r) => !app.state.geo.has(r.u));
  return toCsv(['unom', 'округ', 'район', 'адрес МЖИ'], list.map((r) => [r.ur, r.okrug, r.area, r.address]));
}

/**
 * Окно «Координаты домов»: одна кнопка запускает все шаги по очереди.
 * opts.autostart - начать сразу после открытия.
 */
export function openGeocodeDialog(app, { autostart = false } = {}) {
  const body = h('div', { class: 'stack geo-run', style: { gap: '14px' } });
  const dlg = modal({ title: 'Координаты домов', body, actions: [{ label: 'Закрыть' }] });
  const st = {
    addr: { api: false }, ya: { api: false }, running: false, error: '',
    steps: { osm: { state: 'wait', text: '' }, match: { state: 'wait', text: '' }, ya: { state: 'wait', text: '' } },
    result: null, keyOpen: false,
  };
  const setStep = (k, state, text) => { st.steps[k] = { state, text }; draw(); };

  async function run() {
    if (st.running) return;
    st.running = true;
    st.error = '';
    st.result = null;
    const before = app.state.geo.size;
    for (const k of Object.keys(st.steps)) st.steps[k] = { state: 'wait', text: '' };
    draw();
    try {
      // 1. Справочник адресов OSM: скачать, если его ещё нет
      st.addr = await addressesState();
      if (!st.addr.api) throw new Error('Поиск координат работает, когда приложение запущено через start.bat (py -3 serve.py).');
      let m = { matched: 0 };
      try {
        if (!st.addr.exists) {
          setStep('osm', 'run', 'Скачивание адресов зданий Москвы');
          await postJson('api/addresses/download');
          st.addr = await waitJob('api/addresses', (s) => {
            const j = s.job || {};
            setStep('osm', 'run', `${j.stage || 'Скачивание'}${j.total ? ` (${Math.round((j.done / j.total) * 100)}%)` : ''}`);
          });
          if (!st.addr.exists) throw new Error(st.addr.job.message || 'Справочник адресов не скачан');
        }
        setStep('osm', 'ok', `${fmt.int(st.addr.count)} адресов, скачаны ${fmt.date(st.addr.downloadedAt)}`);
        // 2. Сопоставление в браузере
        setStep('match', 'run', 'Сопоставление адресов');
        m = await matchOsm(app, st.addr, (text) => setStep('match', 'run', `Сопоставление адресов: ${text}`));
        setStep('match', 'ok', `найдено по адресу OSM: ${fmt.int(m.matched)}`);
      } catch (e) {
        // OpenStreetMap недоступен: оставшиеся дома всё равно можно найти через Яндекс
        if (st.steps.osm.state !== 'ok') setStep('osm', 'fail', e.message);
        setStep('match', st.steps.osm.state === 'ok' ? 'fail' : 'skip', st.steps.osm.state === 'ok' ? e.message : 'пропущено');
      }
      // 3. Яндекс для оставшихся
      st.ya = await yandexState();
      const rest = app.state.rows.filter((r) => !app.state.geo.has(r.u));
      let yaFound = 0;
      if (!rest.length) {
        setStep('ya', 'skip', 'не понадобился: все дома найдены');
      } else if (!st.ya.hasKey) {
        setStep('ya', 'skip', 'ключ API не указан, шаг пропущен');
      } else {
        setStep('ya', 'run', `Поиск ${fmt.int(rest.length)} оставшихся домов`);
        await postJson('api/yandex/start', { items: rest.map((r) => ({ id: r.u, address: r.address })) });
        st.ya = await waitJob('api/yandex', (s) => {
          const j = s.job || {};
          setStep('ya', 'run', `${fmt.int(j.done || 0)} из ${fmt.int(j.total || rest.length)}`);
        });
        const { results } = await getJson('api/yandex/results');
        const recs = yandexRecords(app, results);
        await putMany('geo', recs);
        await app.reloadGeo();
        yaFound = recs.length;
        const j = st.ya.job || {};
        if (j.state === 'error') setStep('ya', 'warn', `найдено ${fmt.int(yaFound)}; ${j.message}`);
        else setStep('ya', yaFound ? 'ok' : 'warn', `найдено через Яндекс: ${fmt.int(yaFound)}${j.message ? `. ${j.message}` : ''}`);
      }
      st.result = { before, after: app.state.geo.size, osm: m.matched, ya: yaFound, file: await saveGeocodedFile(app).catch(() => '') };
      toast(`Координаты: ${fmt.int(app.state.geo.size)} домов из ${fmt.int(app.state.rows.length)}`, 'ok');
    } catch (e) {
      st.error = e.message;
      for (const k of Object.keys(st.steps)) if (st.steps[k].state === 'run') st.steps[k].state = 'fail';
    }
    st.running = false;
    draw();
  }

  async function saveKey(apiKey, dailyLimit) {
    try {
      st.ya = { api: true, ...(await postJson('api/yandex/settings', { apiKey, dailyLimit })) };
      toast(st.ya.hasKey ? 'Ключ сохранён на этом компьютере' : 'Ключ удалён', 'ok');
    } catch (e) {
      toast(e.message, 'error', 7000);
    }
    draw();
  }

  const STEP_ICON = { ok: 'checkCircle', run: 'refresh', fail: 'xCircle', warn: 'warn', skip: 'slash', wait: 'help' };
  function stepRow(k, title) {
    const s = st.steps[k];
    return h('li', { class: `run-step ${s.state}` }, h('span', { class: 'ic' }, icon(STEP_ICON[s.state] || 'help', 16)),
      h('div', null, h('b', null, title), s.text ? h('div', { class: 'small ink2' }, s.text) : null));
  }

  function draw() {
    if (!body.isConnected) return; // окно уже закрыто
    clear(body);
    const rows = app.state.rows;
    if (!rows.length) {
      body.append(h('div', { class: 'note' }, icon('info'), h('div', null, 'Сначала загрузите реестр МЖИ: координаты ищутся для его домов.')),
        h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-primary', onclick: () => { dlg.close(); app.openSources(); } }, icon('database', 16), 'Загрузить из папки выгрузок')));
      return;
    }
    const noGeo = rows.filter((r) => !app.state.geo.has(r.u)).length;
    body.append(
      h('p', { class: 'ink2', style: { margin: 0 } }, `В реестре ${fmt.int(rows.length)} домов, без координат ${fmt.int(noGeo)}. Кнопка ниже по очереди выполнит все шаги. Точки, поставленные или проверенные вручную, не изменятся.`),
      h('ol', { class: 'run-steps' },
        stepRow('osm', 'Адреса зданий Москвы из OpenStreetMap'),
        stepRow('match', 'Сопоставление с адресами реестра'),
        stepRow('ya', 'Яндекс Геокодер для оставшихся домов')),
      h('button', { class: 'btn btn-primary btn-block', disabled: st.running, onclick: run }, icon(st.running ? 'refresh' : 'pin', 16),
        st.running ? 'Идёт поиск координат...' : st.result ? 'Найти ещё раз' : 'Найти координаты всех домов'));
    if (st.error) body.append(h('div', { class: 'note error small' }, icon('warn'), h('div', null, st.error)));
    if (st.result) {
      const r = st.result;
      body.append(h('div', { class: 'note ok' }, icon('checkCircle'), h('div', null,
        h('div', null, h('b', null, `С координатами ${fmt.int(r.after)} из ${fmt.int(rows.length)} домов (${fmt.pct(r.after / rows.length)})`)),
        h('div', { class: 'small' }, `OpenStreetMap: ${fmt.int(r.osm)}, Яндекс: ${fmt.int(r.ya)}. Без координат: ${fmt.int(rows.length - r.after)}.`),
        r.file ? h('div', { class: 'small muted wrap' }, `Копия: ${r.file}`) : null)));
      if (rows.length > r.after) {
        body.append(h('div', { class: 'actions-row' },
          h('button', { class: 'btn btn-sm', onclick: () => download(new Blob([missingCsv(app)], { type: 'text/csv;charset=utf-8' }), 'дома_без_координат.csv') }, icon('download', 14), 'Список домов без координат (CSV)'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { dlg.close(); app.go('houses'); } }, 'Открыть в таблице')));
      }
    }
    // Настройки Яндекса
    const ya = st.ya;
    const keyIn = h('input', { type: 'password', placeholder: ya.hasKey ? `сохранён, …${ya.keyTail}` : 'ключ API', autocomplete: 'off', style: { width: '100%' }, 'aria-label': 'Ключ API Яндекс Геокодера' });
    const limIn = h('input', { type: 'number', min: 1, value: ya.dailyLimit || 1000, style: { width: '120px' }, 'aria-label': 'Суточный лимит запросов' });
    body.append(h('details', { class: 'ya-settings', open: st.keyOpen, ontoggle: (e) => { st.keyOpen = e.target.open; } },
      h('summary', null, ya.hasKey ? `Яндекс Геокодер: ключ …${ya.keyTail}, лимит ${fmt.int(ya.dailyLimit)} в сутки, сегодня ${fmt.int(ya.usedToday)}` : 'Яндекс Геокодер: указать ключ API'),
      h('div', { class: 'stack', style: { gap: '8px', marginTop: '10px' } },
        h('div', { class: 'small ink2' }, 'Ключ выдаётся в кабинете разработчика Яндекса (developer.tech.yandex.ru), сервис «JavaScript API и HTTP Геокодер». Ключ хранится только на этом компьютере (config/geocoder.local.json). В Яндекс отправляются только адреса домов без координат; ответы сохраняются в data/local, повторный поиск лимит не тратит. Условия хранения результатов проверьте для своего тарифа.'),
        h('div', { class: 'field-inline' }, h('label', null, 'Ключ API'), keyIn),
        h('div', { class: 'field-inline' }, h('label', null, 'Лимит запросов в сутки'), limIn),
        h('div', { class: 'actions-row' },
          h('button', { class: 'btn btn-sm', onclick: () => saveKey(keyIn.value.trim() || undefined, Number(limIn.value)) }, 'Сохранить'),
          ya.hasKey ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => saveKey('', Number(limIn.value)) }, 'Удалить ключ') : null))));
  }

  draw();
  Promise.all([addressesState(), yandexState()]).then(([a, y]) => {
    st.addr = a;
    st.ya = y;
    if (!st.running) {
      if (a.exists) st.steps.osm = { state: 'ok', text: `${fmt.int(a.count)} адресов, скачаны ${fmt.date(a.downloadedAt)}` };
      else if (a.api) st.steps.osm = { state: 'wait', text: 'будут скачаны один раз, несколько минут' };
      if (y.api) st.steps.ya = { state: 'wait', text: y.hasKey ? 'для домов, которых нет в OSM' : 'нужен ключ API (настройка ниже), без него шаг пропускается' };
      draw();
    }
    if (autostart) run();
  });
  return dlg;
}
