// Координаты всех домов реестра МЖИ. Источники на выбор (выполняются по порядку, каждый берёт только
// дома, которые ещё без координат):
// 1) Адресный реестр Москвы (data.mos.ru): точно по UNOM, нужен бесплатный ключ API портала;
// 2) OpenStreetMap: адреса зданий Москвы скачиваются один раз через Overpass API
//    в data/local/osm/moscow_addresses.json и сопоставляются с адресами МЖИ в браузере (core/addrmatch.js);
// 3) Яндекс Геокодер: по адресу, нужен ключ API, есть суточный лимит.
// Точки сохраняются в браузере и копией в data/local/geocoded_houses.csv.
// Точки, указанные вручную, проверенные или загруженные из файла, не меняются.

import { h, clear, fmt, icon, toast, modal, download } from './ui.js';
import { putMany, del } from './storage.js';
import { buildIndex, addRows, matchAddress, prepareAddress, matchPrepared } from './core/addrmatch.js';
import { normUnom } from './core/util.js';
import { toCsv } from './core/csv.js';
import { inMoscow } from './geo.js';
import { getJson, postJson, waitJob } from './api.js';

const MANUAL = new Set(['manual', 'verified', 'imported', 'auto']); // эти точки не меняет ни один источник
const KEEP = new Set([...MANUAL, 'yandex', 'mosreg']); // поиск по OSM не трогает и точки других источников
const tick = () => new Promise((r) => setTimeout(r, 0));
const pct = (a, b) => (b ? `${Math.floor((a / b) * 100)}%` : '');

export const addressesState = () => getJson('api/addresses').then((s) => ({ api: true, ...s })).catch(() => ({ api: false }));
export const yandexState = () => getJson('api/yandex').then((s) => ({ api: true, ...s })).catch(() => ({ api: false }));
export const mosregState = () => getJson('api/mosreg').then((s) => ({ api: true, ...s })).catch(() => ({ api: false }));

/** Реестр Москвы: точки по UNOM для домов без координат и для найденных автоматически по адресу. */
export async function matchRegistry(app, reg) {
  const res = await fetch(`${reg.url || 'data/local/mos_registry.json'}?v=${reg.mtime || Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Файл реестра не найден');
  const doc = await res.json();
  const points = doc.points || {};
  const shapes = doc.shapes || {};
  const now = new Date().toISOString();
  const out = [];
  for (const r of app.state.rows) {
    const prev = app.state.geo.get(r.u);
    if (prev && MANUAL.has(prev.status)) continue;
    const p = points[normUnom(r.ur)];
    if (!p || !inMoscow(p[0], p[1])) continue;
    out.push({
      ...(prev || {}), u: r.u, ur: r.ur, lat: p[0], lon: p[1], building: shapes[normUnom(r.ur)] || (prev ? prev.building || null : null),
      source: `Адресный реестр Москвы, data.mos.ru (${fmt.date(doc.downloadedAt)})`, accuracy: 'реестр Москвы, UNOM совпал',
      status: 'mosreg', verified_at: '', address_at_geocode: r.address, review: '', updated_at: now,
    });
  }
  for (let i = 0; i < out.length; i += 2000) await putMany('geo', out.slice(i, i + 2000));
  await app.reloadGeo();
  return out.length;
}

/** OpenStreetMap: сопоставить адреса МЖИ со справочником адресов. */
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
  const drop = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const prev = app.state.geo.get(r.u);
    if (prev && KEEP.has(prev.status)) { stats.kept++; continue; }
    const m = matchAddress(index, r.address);
    if (m.status === 'ok') {
      stats.matched++;
      out.push(osmRecord(r, prev, m, doc.downloadedAt, now));
    } else {
      stats[m.status]++;
      if (prev && prev.status === 'osm') drop.push(r.u); // нашлась по части справочника, а по полному адрес неоднозначен
    }
    if (i % 2000 === 0) {
      onProgress(`${fmt.int(i)} из ${fmt.int(rows.length)}`, 5 + (i / rows.length) * 85, { i, found: stats.matched });
      await tick();
    }
  }
  for (let i = 0; i < out.length; i += 2000) await putMany('geo', out.slice(i, i + 2000));
  for (const u of drop) await del('geo', u);
  await app.reloadGeo();
  return stats;
}

function osmRecord(r, prev, m, date, now) {
  return {
    ...(prev || {}), u: r.u, ur: r.ur, lat: m.lat, lon: m.lon, building: prev ? prev.building || null : null,
    source: `OpenStreetMap, адрес (${fmt.date(date)})`,
    accuracy: m.exact ? (m.type === 'n' ? 'адресная точка OSM, адрес совпал' : 'здание OSM, адрес совпал') : 'здание OSM, совпал адрес без типа улицы',
    status: 'osm', verified_at: '', address_at_geocode: r.address, review: m.exact ? '' : 'тип улицы не совпал', updated_at: now,
  };
}

/** Яндекс: принять ответы. Берутся только дома (kind=house) в границах Москвы. */
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

const SOURCES = [
  { id: 'mos', title: 'Адресный реестр Москвы (data.mos.ru)', note: 'точно по UNOM, официальные данные; нужен бесплатный ключ API портала открытых данных' },
  { id: 'osm', title: 'OpenStreetMap', note: 'по адресу, без ключа; адреса зданий Москвы скачиваются один раз' },
  { id: 'ya', title: 'Яндекс Геокодер', note: 'по адресу; нужен ключ API, есть суточный лимит запросов' },
];

function loadChoice() {
  try { return { mos: false, osm: true, ya: false, ...JSON.parse(localStorage.getItem('mca-geo-sources') || '{}') }; } catch (_) { return { mos: false, osm: true, ya: false }; }
}

// Текущий поиск живёт отдельно от окна: окно можно свернуть, ход виден в углу экрана, точки появляются на карте.
let session = null;

function createSession(app) {
  const st = {
    choice: loadChoice(), info: { mos: {}, osm: {}, ya: {} }, running: false, error: '', result: null, editKey: '', freshOsm: false,
    steps: { mos: { state: 'wait', text: '' }, osm: { state: 'wait', text: '' }, ya: { state: 'wait', text: '' } },
  };
  const S = { app, st, view: null, floatEl: null };
  const without = () => app.state.rows.filter((r) => !app.state.geo.has(r.u));
  const setStep = (k, state, text) => { st.steps[k] = { state, text }; S.notify(); };
  S.saveChoice = () => { try { localStorage.setItem('mca-geo-sources', JSON.stringify(st.choice)); } catch (_) { /* приватный режим */ } };

  S.notify = () => {
    if (S.view && S.view.body.isConnected) { S.view.draw(); removeFloat(); return; }
    if (st.running) showFloat(); else removeFloat();
  };
  function removeFloat() { if (S.floatEl) { S.floatEl.remove(); S.floatEl = null; } }
  function showFloat() {
    const cur = ['mos', 'osm', 'ya'].map((k) => st.steps[k]).find((x) => x.state === 'run');
    if (!S.floatEl) {
      S.floatEl = h('div', { class: 'geo-float', role: 'status' });
      document.body.appendChild(S.floatEl);
    }
    clear(S.floatEl);
    S.floatEl.append(h('span', { class: 'ic' }, icon('refresh', 16)),
      h('div', null, h('b', null, 'Поиск координат'), h('div', { class: 'small ink2' }, cur ? cur.text : 'Подготовка'),
        h('div', { class: 'small' }, `С координатами: ${fmt.int(app.state.geo.size)} из ${fmt.int(app.state.rows.length)}`)),
      h('button', { class: 'btn btn-sm', onclick: () => openGeocodeDialog(app) }, 'Подробнее'));
  }

  S.refreshInfo = async () => {
    const [mos, osm, ya] = await Promise.all([mosregState(), addressesState(), yandexState()]);
    st.info = { mos, osm, ya };
    if (!st.running && !st.result) { // после поиска в строках остаются его итоги
      st.steps.mos = { state: 'wait', text: mos.exists ? `реестр прочитан ${fmt.date(mos.downloadedAt)}: ${fmt.int(mos.count)} зданий` : mos.hasKey ? 'реестр будет прочитан один раз (около 440 тысяч записей, 10-20 минут)' : '' };
      st.steps.osm = { state: 'wait', text: osm.exists && osm.complete !== false ? `справочник скачан ${fmt.date(osm.downloadedAt)}: ${fmt.int(osm.count)} адресов зданий`
        : osm.exists ? `скачано ${fmt.int(osm.count)} адресов, часть не загрузилась: при поиске докачается` : 'адреса будут скачаны один раз; найденные дома появляются на карте сразу' };
      st.steps.ya = { state: 'wait', text: ya.hasKey ? `лимит ${fmt.int(ya.dailyLimit)} запросов в сутки, сегодня использовано ${fmt.int(ya.usedToday)}` : '' };
    }
    S.notify();
  };

  async function runMos() {
    let reg = st.info.mos;
    if (!reg.hasKey) { setStep('mos', 'skip', 'не указан ключ API, шаг пропущен'); return 0; }
    if (!reg.exists || (reg.job && reg.job.state === 'running')) {
      setStep('mos', 'run', 'Подключение к порталу data.mos.ru');
      if (!(reg.job && reg.job.state === 'running')) await postJson('api/mosreg/download', { unoms: app.state.rows.map((r) => r.ur) });
      reg = await waitJob('api/mosreg', (s) => {
        const j = s.job || {};
        setStep('mos', 'run', j.total
          ? `Прочитано ${fmt.int(j.records || 0)} из ${fmt.int(j.total)} записей реестра (${pct(j.records || 0, j.total)}), найдено домов: ${fmt.int(j.found || 0)} из ${fmt.int(app.state.rows.length)}`
          : (j.stage || 'Подключение'));
      });
      if (!reg.exists) throw new Error(reg.job.message || 'реестр не прочитан');
    }
    const n = await matchRegistry(app, reg);
    setStep('mos', 'ok', `найдено по UNOM: ${fmt.int(n)} из ${fmt.int(app.state.rows.length)} (${pct(n, app.state.rows.length)})`);
    return n;
  }

  /** Дома из уже скачанных частей справочника: ищутся сразу, сохраняются и появляются на карте. */
  async function matchLive(live) {
    const now = new Date().toISOString();
    const out = [];
    for (const r of app.state.rows) {
      if (live.found.has(r.u) || app.state.geo.has(r.u)) continue;
      let p = live.prepared.get(r.u);
      if (!p) { p = prepareAddress(r.address); live.prepared.set(r.u, p); }
      const m = matchPrepared(live.index, p);
      if (m.status === 'ok') { out.push(osmRecord(r, null, m, now, now)); live.found.add(r.u); }
    }
    if (out.length) await putMany('geo', out);
    if (out.length && Date.now() - live.shown > 3000) { // карта перерисовывается не чаще раза в 3 секунды
      live.shown = Date.now();
      await app.reloadGeo();
    }
  }

  async function runOsm() {
    let addr = st.info.osm;
    if (!without().length) { setStep('osm', 'skip', 'не понадобился: все дома уже с координатами'); return 0; }
    const running = addr.job && addr.job.state === 'running';
    if (!addr.exists || addr.complete === false || running || st.freshOsm) {
      setStep('osm', 'run', 'Скачивание адресов зданий Москвы');
      if (!running) await postJson('api/addresses/download', { fresh: st.freshOsm });
      st.freshOsm = false;
      const live = { index: buildIndex([]), seen: new Set(), found: new Set(), prepared: new Map(), shown: 0 };
      addr = await waitJob('api/addresses', async (s) => {
        const j = s.job || {};
        const fresh = (j.parts || []).filter((k) => !live.seen.has(k));
        for (const k of fresh) {
          live.seen.add(k);
          const part = await getJson(`data/local/osm/parts/${encodeURIComponent(k)}.json`).catch(() => null);
          if (part) addRows(live.index, Object.values(part.rows || {}));
        }
        if (fresh.length) await matchLive(live);
        setStep('osm', 'run', `Скачивание адресов: получено ${fmt.int(j.addresses || 0)} адресов зданий, частей ${fmt.int(j.done || 0)} из ${fmt.int(j.total || 0)} (${pct(j.done || 0, j.total || 1)}); уже на карте: ${fmt.int(live.found.size)} домов${j.failed ? `; не загрузилось частей: ${j.failed}` : ''}`);
      });
      await app.reloadGeo();
      if (!addr.exists) throw new Error(`${addr.job.message || 'справочник адресов не скачан'} Найдено по полученным частям: ${fmt.int(live.found.size)}.`);
    }
    const total = app.state.rows.length;
    const m = await matchOsm(app, addr, (text, _p, live) => setStep('osm', 'run',
      live ? `Проверка по полному справочнику (${fmt.int(addr.count)} адресов): ${fmt.int(live.i)} из ${fmt.int(total)} домов (${pct(live.i, total)}), найдено ${fmt.int(live.found)}` : text));
    const warn = addr.job && addr.job.message ? `. ${addr.job.message}` : '';
    setStep('osm', warn ? 'warn' : 'ok', `найдено по адресу: ${fmt.int(m.matched)}; справочник: ${fmt.int(addr.count)} адресов от ${fmt.date(addr.downloadedAt)}${warn}`);
    return m.matched;
  }

  async function runYa() {
    const ya = st.info.ya;
    const rest = without();
    if (!rest.length) { setStep('ya', 'skip', 'не понадобился: все дома уже с координатами'); return 0; }
    if (!ya.hasKey) { setStep('ya', 'skip', 'не указан ключ API, шаг пропущен'); return 0; }
    setStep('ya', 'run', `Поиск ${fmt.int(rest.length)} домов`);
    await postJson('api/yandex/start', { items: rest.map((r) => ({ id: r.u, address: r.address })) });
    const fin = await waitJob('api/yandex', (s) => {
      const j = s.job || {};
      setStep('ya', 'run', `Проверено ${fmt.int(j.done || 0)} из ${fmt.int(j.total || rest.length)} (${pct(j.done || 0, j.total || rest.length)}), найдено ${fmt.int(j.found || 0)}`);
    });
    const { results } = await getJson('api/yandex/results');
    const recs = yandexRecords(app, results);
    await putMany('geo', recs);
    await app.reloadGeo();
    const j = fin.job || {};
    setStep('ya', j.state === 'error' || !recs.length ? 'warn' : 'ok', `найдено через Яндекс: ${fmt.int(recs.length)} из ${fmt.int(rest.length)}${j.message ? `. ${j.message}` : ''}`);
    return recs.length;
  }

  S.run = async () => {
    if (st.running) return;
    st.running = true;
    st.error = '';
    st.result = null;
    S.notify();
    const found = { mos: 0, osm: 0, ya: 0 };
    try {
      await S.refreshInfo();
      if (!st.info.osm.api) throw new Error('Поиск координат работает, когда приложение запущено через start.bat (py -3 serve.py).');
      for (const [id, fn] of [['mos', runMos], ['osm', runOsm], ['ya', runYa]]) {
        if (!st.choice[id]) { setStep(id, 'skip', 'не выбран'); continue; }
        try {
          found[id] = await fn();
        } catch (e) {
          setStep(id, 'fail', e.message); // источник недоступен: следующие всё равно выполняются
        }
      }
      st.result = { after: app.state.geo.size, found, file: await saveGeocodedFile(app).catch(() => '') };
      toast(`Координаты: ${fmt.int(app.state.geo.size)} домов из ${fmt.int(app.state.rows.length)}`, 'ok');
    } catch (e) {
      st.error = e.message;
    }
    st.running = false;
    removeFloat();
    S.refreshInfo();
  };

  S.saveKey = async (src, value) => {
    try {
      if (src === 'mos') await postJson('api/mosreg/settings', { mosKey: value });
      else await postJson('api/yandex/settings', { apiKey: value });
      toast(value ? 'Ключ сохранён на этом компьютере' : 'Ключ удалён', 'ok');
      st.editKey = '';
      if (value) { st.choice[src] = true; S.saveChoice(); }
    } catch (e) {
      toast(e.message, 'error', 7000);
    }
    S.refreshInfo();
  };
  return S;
}

const STEP_ICON = { ok: 'checkCircle', run: 'refresh', fail: 'xCircle', warn: 'warn', skip: 'slash', wait: 'help' };

/**
 * Окно «Координаты домов»: выбор источников и одна кнопка, которая выполняет их по порядку.
 * Окно можно свернуть: поиск продолжается, ход виден в углу экрана, найденные дома появляются на карте.
 * opts.autostart - начать сразу после открытия.
 */
export function openGeocodeDialog(app, { autostart = false } = {}) {
  if (!session || session.app !== app) session = createSession(app);
  const S = session;
  const { st } = S;
  if (S.view && S.view.body.isConnected) S.view.dlg.close();
  const body = h('div', { class: 'stack geo-run', style: { gap: '14px' } });
  const dlg = modal({ title: 'Координаты домов', body, wide: true, actions: [], onClose: () => S.notify() });
  const without = () => app.state.rows.filter((r) => !app.state.geo.has(r.u));

  function sourceRow(src) {
    const s = st.steps[src.id];
    const info = st.info[src.id] || {};
    const needsKey = src.id !== 'osm';
    const keyLine = needsKey ? h('div', { class: 'small' },
      info.hasKey ? `Ключ: сохранён (…${info.keyTail}). ` : 'Ключ не указан. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); st.editKey = st.editKey === src.id ? '' : src.id; draw(); } }, info.hasKey ? 'Изменить' : 'Указать ключ')) : null;
    let editor = null;
    if (st.editKey === src.id) {
      const inp = h('input', { type: 'password', autocomplete: 'off', placeholder: 'ключ API', style: { flex: '1', minWidth: '0' }, 'aria-label': `Ключ API: ${src.title}` });
      editor = h('div', { class: 'stack', style: { gap: '6px' } },
        h('div', { class: 'small muted' }, src.id === 'mos'
          ? 'Ключ выдаётся бесплатно в личном кабинете портала открытых данных data.mos.ru (раздел для разработчиков, API). Хранится только на этом компьютере, в config/geocoder.local.json.'
          : 'Ключ выдаётся в кабинете разработчика Яндекса (developer.tech.yandex.ru), сервис «JavaScript API и HTTP Геокодер». Хранится только на этом компьютере. Условия хранения результатов проверьте для своего тарифа.'),
        h('div', { class: 'actions-row' }, inp,
          h('button', { class: 'btn btn-sm', onclick: () => S.saveKey(src.id, inp.value.trim()) }, 'Сохранить'),
          info.hasKey ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => S.saveKey(src.id, '') }, 'Удалить ключ') : null));
    }
    return h('div', { class: `src-row run-step ${s.state}` },
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: !!st.choice[src.id], disabled: st.running, 'aria-label': src.title, onchange: (e) => { st.choice[src.id] = e.target.checked; S.saveChoice(); draw(); } }),
        h('div', null, h('b', null, src.title), h('div', { class: 'small muted' }, src.note))),
      h('div', { class: 'src-status' },
        s.text || s.state !== 'wait' ? h('div', { class: 'small ink2 src-line' }, h('span', { class: 'ic' }, icon(STEP_ICON[s.state] || 'help', 15)), h('span', null, s.text)) : null,
        keyLine, editor));
  }

  function draw() {
    if (!body.isConnected) return; // окно уже закрыто
    clear(body);
    dlg.setActions(st.running
      ? [{ label: 'Свернуть, поиск продолжится' }]
      : [{ label: 'Закрыть' }]);
    const rows = app.state.rows;
    if (!rows.length) {
      body.append(h('div', { class: 'note' }, icon('info'), h('div', null, 'Сначала загрузите реестр МЖИ: координаты ищутся для его домов.')),
        h('div', { class: 'actions-row' }, h('button', { class: 'btn btn-primary', onclick: () => { dlg.close(); app.openSources(); } }, icon('database', 16), 'Загрузить из папки выгрузок')));
      return;
    }
    const noGeo = without().length;
    const any = SOURCES.some((x) => st.choice[x.id]);
    body.append(
      h('p', { class: 'ink2', style: { margin: 0 } }, `В реестре ${fmt.int(rows.length)} домов, с координатами ${fmt.int(rows.length - noGeo)}, без координат ${fmt.int(noGeo)} (${pct(noGeo, rows.length)}). Источники выполняются по порядку, каждый ищет только дома, которые ещё без координат. Найденные дома сразу сохраняются и появляются на карте; окно можно свернуть.`),
      h('div', { class: 'src-list' }, SOURCES.map(sourceRow)),
      h('button', { class: 'btn btn-primary btn-block', disabled: st.running || !any, onclick: () => S.run() }, icon(st.running ? 'refresh' : 'pin', 16),
        st.running ? 'Идёт поиск координат...' : !any ? 'Выберите хотя бы один источник' : 'Найти координаты'));
    if (st.error) body.append(h('div', { class: 'note error small' }, icon('warn'), h('div', null, st.error)));
    if (st.result) {
      const r = st.result;
      body.append(h('div', { class: 'note ok' }, icon('checkCircle'), h('div', null,
        h('div', null, h('b', null, `С координатами ${fmt.int(r.after)} из ${fmt.int(rows.length)} домов (${fmt.pct(r.after / rows.length)})`)),
        h('div', { class: 'small' }, `Реестр Москвы: ${fmt.int(r.found.mos)}, OpenStreetMap: ${fmt.int(r.found.osm)}, Яндекс: ${fmt.int(r.found.ya)}. Без координат: ${fmt.int(rows.length - r.after)}.`),
        r.file ? h('div', { class: 'small muted wrap' }, `Копия: ${r.file}`) : null)));
      if (rows.length > r.after) {
        body.append(h('div', { class: 'actions-row' },
          h('button', { class: 'btn btn-sm', onclick: () => download(new Blob([missingCsv(app)], { type: 'text/csv;charset=utf-8' }), 'дома_без_координат.csv') }, icon('download', 14), 'Список домов без координат (CSV)'),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { dlg.close(); app.go('houses'); } }, 'Открыть в таблице')));
      }
    }
    const osm = st.info.osm || {};
    const mos = st.info.mos || {};
    if (!st.running && (osm.exists || mos.exists)) {
      body.append(h('div', { class: 'small muted' }, 'Обновить скачанные данные: ',
        osm.exists ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); st.freshOsm = true; st.choice.osm = true; S.saveChoice(); S.run(); } }, 'адреса OpenStreetMap') : null,
        osm.exists && mos.exists ? ', ' : null,
        mos.exists ? h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await postJson('api/mosreg/download', { unoms: app.state.rows.map((r) => r.ur) }); toast('Реестр Москвы обновляется, затем запустите поиск снова'); } }, 'реестр Москвы') : null, '.'));
    }
  }

  S.view = { body, dlg, draw };
  S.notify(); // рисует окно и убирает плашку свёрнутого поиска
  if (st.running) return dlg; // поиск уже идёт: окно просто показывает его ход
  S.refreshInfo().then(() => { if (autostart) S.run(); });
  return dlg;
}
