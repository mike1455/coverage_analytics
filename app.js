// Аналитика покрытия: главный модуль интерфейса.
// Данные живут в IndexedDB (storage.js), тяжёлая обработка - в Web Worker (workers/import.worker.js),
// расчёты - чистые функции analytics.js. Здесь: состояние, виды, фильтры, действия пользователя.

import { h, $, $$, clear, fmt, NA, na, icon, toast, modal, confirmDialog, download, debounce, select, plural } from './ui.js';
import { getAll, get, put, del, getActive, getMeta, setMeta, tx, storageEstimate, requestPersistence, STORES, getJoined } from './storage.js';
import { WorkerClient, openImportWizard, discoverLocal, fetchLocalFiles } from './import.js';
import { getSourcesState, sourcesSummary, openSourcesDialog } from './sources.js';
import { MapView } from './map.js';
import { basemapPanel, basemapState, basemapShort, refreshBasemap, onBasemap } from './basemap.js';
import { openGeocodeDialog } from './geocode.js';
import { getJson, postJson, waitJob } from './api.js';
import { openCard, openEdcCard, closeCard, nominatimConsent } from './card.js';
import { barChart, stackBar, legend, okrugTiles, hideTip, fmtMetric, hsBadge, HS_COLOR, HS_ICON } from './charts.js';
import { dataTable } from './datatable.js';
import { summaryData, buildPoster, posterPng, SUMMARY_METRICS } from './summary.js';
import { downloadWorkbook } from './export.js';
import {
  kpiOf, groupKpi, rankGroups, METRICS, MAIN_METRICS, ACTIVITY_METRICS, REQ_METRICS, QUARTERS, NA_REASON, COV_LABEL, MATCH_LABEL, MIN_SAMPLE,
  metricValue, smallSampleFor, reqValue, hexCells, houseStatus, HS_LABEL, HS_HINT, HS_ORDER,
} from './analytics.js';
import { OKRUGS, OKRUG_CODES, NO_OKRUG, okrugByCode } from './core/okrugs.js';
import { Q } from './core/edc.js';
import { normUnom, isUuid, lowerYo } from './core/util.js';
import { toCsv } from './core/csv.js';
import {
  nominatimSearch, accuracyOf, centroidOf, parseGeoFile, exportGeoJson, annotateBoundaries,
} from './geo.js';

const VIEWS = ['summary', 'map', 'activity', 'regions', 'houses', 'import'];
const OLD_VIEWS = { heat: 'activity', rating: 'regions' }; // старые ссылки

const app = {
  worker: null,
  map: null,
  state: {
    active: { mji: null, edc: null }, snapshots: [], rows: [], rowsByU: new Map(), edcStats: null, joinedAt: null,
    geo: new Map(), zones: [], overrides: new Map(), boundaries: { okrug: null, area: null }, snapMji: null, snapEdc: null,
    mjiGone: [], edcGoneCount: 0, addr: [], local: [], sources: null,
  },
  f: { okrug: '', area: '', quarter: '', reqMetric: 'total' },
  ui: {
    view: 'summary', summaryMetric: 'servedShare', regionMetric: 'servedShare', choro: 'servedShare',
    activity: { metric: 'reqPerHouse' },
    table: { page: 0, size: 50, sort: 'address', dir: 1, q: '', hs: '', cov: '', match: '', actual: '', type: '', setting: '', geo: '', reqMin: '', reqMax: '' },
  },
  settings: { nominatimEmail: '' },
};
window.__app = app; // для отладки и e2e-тестов

// ---------------------------------------------------------------- запуск

async function boot() {
  if (location.protocol === 'file:') return;
  for (const el of $$('[data-icon]')) el.replaceWith(icon(el.dataset.icon, 19));
  for (const b of $$('.nav-item')) b.addEventListener('click', () => go(b.dataset.view));
  // Один обработчик на документ: скрыть выпадающие результаты поиска при клике мимо
  document.addEventListener('mousedown', (e) => {
    for (const r of $$('.search-results')) if (!r.parentNode.contains(e.target)) r.classList.add('hidden');
  });
  window.addEventListener('hashchange', () => go(location.hash.slice(1), false));
  try { app.settings = { ...app.settings, ...(JSON.parse(localStorage.getItem('mca-settings') || '{}')) }; } catch (_) { /* приватный режим */ }
  app.worker = new WorkerClient();
  app.map = new MapView({
    onHouse: (u) => openCard(app, u),
    onOkrug: (code) => setFilter({ okrug: app.f.okrug === code ? '' : code, area: '' }),
    onArea: (area) => setFilter({ area: app.f.area === area ? '' : area }),
  });
  renderTopbar();
  const loading = h('div', { class: 'card', style: { margin: '40px auto', maxWidth: '520px' } }, h('h3', null, 'Загрузка локальных данных...'), h('div', { class: 'progress', style: { marginTop: '10px' } }, h('i', { style: { width: '40%' } })));
  $('#view-map').append(loading);
  try {
    await app.worker.call('init', {}, { onProgress: () => {} });
  } catch (e) {
    loading.replaceWith(h('div', { class: 'note error' }, icon('warn'), h('div', null, h('b', null, 'Не удалось открыть локальное хранилище: '), e.message,
      h('div', { class: 'small' }, 'Нужен современный браузер (Chrome/Edge/Яндекс 100+, Firefox 115+) и запуск через http://localhost.'))));
    return;
  }
  loading.remove();
  requestPersistence();
  await loadState();
  app.state.local = await discoverLocal();
  app.state.sources = await getSourcesState();
  onBasemap((s, event) => {
    renderNavStatus();
    if (event !== 'done') return;
    app.map.reloadOffline();
    toast('Карта Москвы сохранена. Теперь она открывается без интернета.', 'ok', 6000);
    render();
  });
  await refreshBasemap();
  // Границы уже скачаны на диск, а в браузере их нет (например, данные сайта очищены): подхватить без интернета
  if (!app.state.boundaries.okrug || !app.state.boundaries.area) {
    const bst = await getJson('api/boundaries').catch(() => null);
    if (bst && ((!app.state.boundaries.okrug && bst.okrug.exists) || (!app.state.boundaries.area && bst.area.exists))) await applyBoundaryFiles(bst).catch(() => null);
  }
  const v = OLD_VIEWS[location.hash.slice(1)] || location.hash.slice(1);
  go(VIEWS.includes(v) ? v : hasMji() ? 'summary' : 'map', false);
}

async function loadState() {
  const st = app.state;
  st.active = await getActive();
  st.snapshots = (await getAll('snapshots')).sort((a, b) => String(b.committedAt || b.createdAt).localeCompare(String(a.committedAt || a.createdAt)));
  st.snapMji = st.snapshots.find((s) => s.id === st.active.mji) || null;
  st.snapEdc = st.snapshots.find((s) => s.id === st.active.edc) || null;
  let joined = await getJoined();
  if (st.active.mji && (!joined || joined.mji !== st.active.mji || joined.edc !== st.active.edc)) {
    // Кэш отсутствует или устарел (например, после восстановления копии) - пересчитать в worker
    await app.worker.call('rebuild');
    joined = await getJoined();
  }
  st.rows = joined && joined.mji === st.active.mji ? joined.rows : [];
  st.edcStats = joined ? joined.edcStats : null;
  st.joinedAt = joined ? joined.builtAt : null;
  st.rowsByU = new Map(st.rows.map((r) => [r.u, r]));
  st.addr = st.rows.map((r) => lowerYo(r.address));
  st.geo = new Map((await getAll('geo')).filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon)).map((g) => [g.u, g]));
  st.zones = await getAll('zones');
  st.overrides = new Map((await getAll('overrides')).map((o) => [o.u, o]));
  st.boundaries = { okrug: await getMeta('boundaries_okrug'), area: await getMeta('boundaries_area') };
  st.mjiGone = await getAll('mji_gone');
  st.edcGoneCount = (await getAll('edc_gone')).length;
}

app.reload = async () => {
  await loadState();
  app.state.local = await discoverLocal();
  app.state.sources = await getSourcesState();
  render();
};
app.openSources = () => openSourcesDialog(app);

/** Лёгкое обновление после правок геоданных (без пересчёта сопоставления). */
app.reloadGeo = () => reloadGeo();

async function reloadGeo() {
  app.state.geo = new Map((await getAll('geo')).filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon)).map((g) => [g.u, g]));
  app.state.zones = await getAll('zones');
  render();
}

// ---------------------------------------------------------------- навигация и фильтры

function go(view, push = true) {
  view = OLD_VIEWS[view] || view;
  if (!VIEWS.includes(view)) view = 'summary';
  app.ui.view = view;
  if (push && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  for (const b of $$('.nav-item')) b.classList.toggle('active', b.dataset.view === view);
  for (const v of VIEWS) $(`#view-${v}`).classList.toggle('active', v === view);
  hideTip();
  render();
}
app.go = go;

function setFilter(patch) {
  Object.assign(app.f, patch);
  if ('okrug' in patch && patch.okrug !== undefined && !('area' in patch)) app.f.area = '';
  app.ui.table.page = 0;
  if (patch.okrug && app.map.map && app.ui.view === 'map') app.map.fitOkrug(patch.okrug);
  render();
}

function scopeRows() {
  const { okrug, area } = app.f;
  if (!okrug && !area) return app.state.rows;
  return app.state.rows.filter((r) => (!okrug || r.okrug === okrug) && (!area || r.area === area));
}

function geoSet() {
  return new Set(app.state.geo.keys());
}

function hasMji() { return !!app.state.active.mji && app.state.rows.length > 0; }
function hasEdc() { return !!app.state.active.edc; }

function render() {
  renderTopbar();
  renderNavStatus();
  const v = app.ui.view;
  if (v === 'summary') renderSummary();
  else if (v === 'map') renderMapView();
  else if (v === 'activity') renderActivity();
  else if (v === 'regions') renderRegions();
  else if (v === 'houses') renderHouses();
  else if (v === 'import') renderImport();
}

// ---------------------------------------------------------------- верхняя панель

function renderTopbar() {
  const tb = $('#topbar');
  clear(tb);
  const rows = app.state.rows;
  const areas = [...new Set(rows.filter((r) => !app.f.okrug || r.okrug === app.f.okrug).map((r) => r.area).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const okrugOpts = [['', 'Вся Москва'], ...OKRUGS.map((o) => [o.code, `${o.code}, ${o.name}`])];
  if (rows.some((r) => r.okrug === NO_OKRUG)) okrugOpts.push([NO_OKRUG, NO_OKRUG]);
  const qOpts = Object.entries(QUARTERS).map(([k, l]) => [k, l]);
  const search = searchBox();
  const theme = document.documentElement.getAttribute('data-theme') || '';
  tb.append(
    h('div', { class: 'filters' },
      h('div', { class: 'field-inline' }, h('label', null, 'Округ'), select(okrugOpts, app.f.okrug, (v) => setFilter({ okrug: v }), { 'aria-label': 'Округ' })),
      h('div', { class: 'field-inline' }, h('label', null, 'Район'), select([['', app.f.okrug ? 'Все районы округа' : 'Все районы'], ...areas.map((a) => [a, a])], app.f.area, (v) => setFilter({ area: v }), { 'aria-label': 'Район', style: { maxWidth: '200px' } })),
      h('div', { class: 'field-inline' }, h('label', null, 'Заявки 2026'), select(qOpts, app.f.quarter, (v) => setFilter({ quarter: v }), { 'aria-label': 'Период заявок' }))),
    search,
    h('div', { class: 'updated' },
      h('div', null, `МЖИ: ${app.state.snapMji ? fmt.date(app.state.snapMji.dataDate) : 'не загружен'}`),
      h('div', null, `ЕДЦ: ${app.state.snapEdc ? fmt.date(app.state.snapEdc.dataDate) : 'не загружен'}`)),
    h('button', { class: 'icon-btn', title: 'Сменить тему', 'aria-label': 'Сменить тему', onclick: toggleTheme }, icon(theme === 'dark' ? 'sun' : 'moon', 19)),
    h('button', { class: 'btn btn-primary', onclick: () => openImportWizard(app) }, icon('upload', 16), 'Обновить данные'));
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark' : sysDark ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('mca-theme', next); } catch (_) { /* приватный режим */ }
  if (app.map.map) app.map.applyBasemap();
  render();
}

function searchBox() {
  const input = h('input', { type: 'search', placeholder: 'Адрес, УНОМ, ФИАС или UUID ЕДЦ', 'aria-label': 'Поиск' });
  const res = h('div', { class: 'search-results hidden', role: 'listbox' });
  const box = h('div', { class: 'search-box' }, icon('search', 17), input, res);
  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { res.classList.add('hidden'); return; }
    clear(res);
    const st = app.state;
    const found = [];
    if (/^\d+$/.test(q)) { const r = st.rowsByU.get(normUnom(q)); if (r) found.push(r); }
    if (isUuid(q)) {
      const up = q.toUpperCase(); const lo = q.toLowerCase();
      for (const r of st.rows) if (r.fias === up || (r.e && (r.e.r === lo || r.e.ro === lo || r.e.i === lo))) found.push(r);
    }
    const toks = lowerYo(q).split(/[\s,.]+/).filter(Boolean);
    if (!found.length && toks.length) {
      for (let i = 0; i < st.addr.length && found.length < 12; i++) if (toks.every((t) => st.addr[i].includes(t))) found.push(st.rows[i]);
    }
    if (found.length) {
      res.append(h('div', { class: 'sr-group' }, 'Дома МЖИ'));
      for (const r of found.slice(0, 12)) {
        res.append(h('button', { onclick: () => { res.classList.add('hidden'); openCard(app, r.u); } },
          h('div', null, r.address), h('div', { class: 'sr-sub' }, `${r.okrug}, ${r.area}, UNOM ${r.ur}, ${COV_LABEL[r.cov]}`)));
      }
    }
    if (hasEdc()) {
      try {
        const er = (await app.worker.call('search', { q, limit: 8 })).result;
        const seen = new Set(found.map((r) => r.e && r.e.r));
        const items = er.items.filter((x) => !seen.has(x.r));
        if (items.length) {
          res.append(h('div', { class: 'sr-group' }, 'Записи ЕДЦ'));
          for (const x of items) {
            res.append(h('button', { onclick: () => { res.classList.add('hidden'); openEdcCard(app, x.r); } },
              h('div', null, x.a || '(без адреса)'), h('div', { class: 'sr-sub' }, `УНОМ ${x.ur || NA}, ${x.ht || 'тип не указан'}, actual=${x.ac}, заявок ${fmt.int(x.q0)}`)));
          }
        }
      } catch (_) { /* поиск ЕДЦ недоступен */ }
    }
    if (!res.childNodes.length) res.append(h('div', { class: 'muted', style: { padding: '8px' } }, 'Ничего не найдено'));
    res.classList.remove('hidden');
  }, 250);
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') res.classList.add('hidden'); });
  return box;
}

function renderNavStatus() {
  const el = $('#nav-status');
  clear(el);
  const st = app.state;
  const src = (ok, name, text) => h('div', { class: 'src' }, h('i', { class: `dot ${ok ? 'ok' : ''}` }), h('b', null, name), h('span', null, text));
  el.append(...[
    src(!!st.snapMji, 'Реестр МЖИ', st.snapMji ? `${fmt.int(st.rows.length)} МКД, ${fmt.date(st.snapMji.dataDate)}` : 'не загружен'),
    src(!!st.snapEdc, 'Выгрузки ЕДЦ', st.snapEdc ? `${fmt.int(st.edcStats ? st.edcStats.edcHouses : 0)} адресов, ${fmt.date(st.snapEdc.dataDate)}` : 'не загружены'),
    src(st.geo.size > 0, 'Геоданные', `${fmt.int(st.geo.size)} домов с координатами`),
    basemapState().api ? src(basemapState().exists, 'Офлайн-карта', basemapShort()) : null,
    h('div', { class: 'nav-note' }, 'Все данные хранятся локально')].filter(Boolean));
}

// ---------------------------------------------------------------- KPI

function kpiTile(label, value, sub, opts = {}) {
  return h('div', { class: 'kpi', title: opts.title || '' },
    h('div', { class: 'kpi-label' }, opts.sw || null, h('span', { class: 't' }, label)),
    h('div', { class: `kpi-value ${value === null ? 'empty' : ''}` }, value === null ? (opts.empty || 'нет данных') : value),
    sub || opts.proxy ? h('div', { class: 'kpi-sub' }, opts.proxy ? h('span', { class: 'proxy-tag', title: 'Прокси-показатель: найденные привязки ЕДЦ, не подтверждённое подключение' }, 'прокси') : null, sub) : null,
    opts.bar !== undefined && opts.bar !== null ? h('div', { class: 'kpi-bar' }, h('i', { style: { width: `${Math.max(0, Math.min(1, opts.bar)) * 100}%` } })) : null);
}

function kpiStrip(k) {
  const edc = hasEdc();
  const st = app.state;
  const qd = app.f.quarter;
  const reqVal = qd ? k.req[qd] : k.req.total;
  const share = (n) => (k.mkd ? n / k.mkd : null);
  const sw = (s) => h('i', { class: 'kpi-sw', style: { background: HS_COLOR[s] } });
  return h('div', { class: 'kpis' },
    kpiTile('Домов в реестре МЖИ', fmt.int(k.mkd), st.snapMji ? `срез МЖИ ${fmt.date(st.snapMji.dataDate)}` : ''),
    kpiTile('Обслуживаются в ЕДЦ', edc ? fmt.int(k.served) : null, edc ? `${fmt.pct(k.servedShare)} домов` : 'загрузите выгрузки ЕДЦ', { bar: edc ? k.servedShare : null, sw: sw('full'), title: HS_HINT.full }),
    kpiTile('Часть подъездов', edc ? fmt.int(k.hs.partial) : null, edc ? `${fmt.pct(share(k.hs.partial))} домов` : '', { sw: sw('partial'), title: HS_HINT.partial }),
    kpiTile('Не обслуживаются', edc ? fmt.int(k.hs.none) : null, edc ? `${fmt.pct(share(k.hs.none))}, нет в ЕДЦ ${fmt.int(k.notInEdc)}` : '', { sw: sw('none'), title: HS_HINT.none }),
    kpiTile('Подъезды обслуживаются', edc && k.entrTotal ? fmt.pct(k.entrShare) : null, edc ? `${fmt.int(k.entrLinked)} из ${fmt.int(k.entrTotal)}` : '', { bar: edc ? k.entrShare : null }),
    kpiTile(`Заявок 2026${qd ? `, ${QUARTERS[qd]}` : ''}`, edc ? fmt.int(reqVal) : null, edc ? `${fmt.num1(metricValue(k, 'reqPerHouse', qd))} на дом, срез ${fmt.date(st.snapEdc && st.snapEdc.dataDate)}` : 'SQL № 4, уровень «Дом»', {}),
    kpiTile('С координатами', fmt.pct(k.geoShare), `${fmt.int(k.geo)} ${plural(k.geo, 'дом', 'дома', 'домов')} на карте`, { bar: k.geoShare }));
}

// ---------------------------------------------------------------- онбординг

function onboarding() {
  const st = app.state;
  const local = st.local.filter((f) => /\.(xlsx|csv)$/i.test(f.name));
  const box = h('div', { class: 'onboard' },
    h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Аналитика покрытия'),
      h('p', null, 'Какие дома Москвы обслуживаются в ЕДЦ, где обслуживается только часть подъездов и сколько по домам заявок 2026 года. Расчёты выполняются на этом компьютере, данные никуда не отправляются.'))),
    h('div', { class: 'steps' },
      step(1, 'Реестр МЖИ', 'Реестр МКД в XLSX или CSV. Сразу даёт число домов по округам и районам.', !!st.snapMji),
      step(2, 'Выгрузки ЕДЦ', 'Три CSV по запросам № 2, 3 и 4 или два уже объединённых файла. После этого шага появятся сводка, обслуживание домов и заявки.', !!st.snapEdc),
      step(3, 'Геопривязка', 'Координаты домов для карты: из OSM, вручную на карте или из CSV/GeoJSON. Для начала хватит одного района.', st.geo.size > 0)),
    h('div', { class: 'actions-row' },
      st.sources ? h('button', { class: 'btn btn-primary', onclick: () => openSourcesDialog(app) }, icon('database', 16), 'Загрузить из папки выгрузок') : null,
      h('button', { class: `btn ${st.sources ? '' : 'btn-primary'}`, onclick: () => openImportWizard(app) }, icon('upload', 16), 'Выбрать файлы вручную')));
  if (st.sources) box.append(sourcesSummary(app, st.sources));
  if (local.length) {
    box.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Файлы в папке data/local')),
      h('div', { class: 'file-list' }, local.map((f) => h('div', { class: 'file-item', style: { gridTemplateColumns: '1fr' } }, h('div', { class: 'fn' }, f.name)))),
      h('div', { class: 'actions-row', style: { marginTop: '10px' } }, h('button', {
        class: 'btn btn-primary', onclick: async (e) => {
          e.target.disabled = true;
          const files = await fetchLocalFiles(local);
          openImportWizard(app, files);
          e.target.disabled = false;
        },
      }, icon('upload', 16), 'Импортировать эти файлы'))));
  }
  box.append(h('div', { class: 'note' }, icon('info'), h('div', null,
    h('b', null, 'Как читать цвета. '), statusLegendText())));
  return box;
}

function step(n, title, text, done) {
  return h('div', { class: `card step ${done ? 'done' : ''}` }, h('div', { class: 'n' }, done ? icon('check', 14) : String(n)), h('h3', null, title), h('p', null, text));
}

// ---------------------------------------------------------------- показатели

function metricDef(id) {
  const m = METRICS[id];
  const q = m.period ? app.f.quarter : '';
  return {
    id, label: m.short, full: m.label, ramp: m.ramp,
    value: (k) => metricValue(k, id, q),
    text: (k) => fmtMetric(id, metricValue(k, id, q)),
    sub: (k) => metricSub(id, k),
  };
}

function metricSub(id, k) {
  const m = METRICS[id];
  const q = m.period ? app.f.quarter : '';
  if (id === 'notServed') return `${fmt.int(k.hs.none)} из ${fmt.int(k.mkd)} домов, из них нет в ЕДЦ ${fmt.int(k.notInEdc)}`;
  if (m.num) return `${fmt.int(m.num(k))} ${m.numLabel} из ${fmt.int(m.den(k))} ${m.denLabel}`;
  if (id === 'reqPerHouse') return `${fmt.int(q ? k.rc[q] : k.rc.total)} заявок на ${fmt.int(k.served)} обслуживаемых домов`;
  if (id === 'openPerHouse') return `${fmt.int(k.rc.open)} заявок без даты закрытия, обслуживаемых домов ${fmt.int(k.served)}`;
  if (id === 'criticalPerHouse') return `${fmt.int(k.rc.critical)} критических заявок, обслуживаемых домов ${fmt.int(k.served)}`;
  if (id === 'requests') return `${fmt.int(k.reqHouses)} домов с заявками`;
  return `${fmt.int(k.mkd)} домов МЖИ`;
}

const periodLabel = (id) => (METRICS[id].period ? (app.f.quarter ? QUARTERS[app.f.quarter] : 'весь 2026 год') : '');

function statusParts(k) {
  return HS_ORDER.filter((s) => k.hs[s] > 0 || s === 'full' || s === 'partial' || s === 'none')
    .map((s) => ({ key: s, value: k.hs[s], color: HS_COLOR[s], label: HS_LABEL[s] }));
}

function isDarkTheme() {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark');
}

async function exportExcel(rows, scope) {
  const st = app.state;
  toast('Готовлю файл Excel...', 'info', 2500);
  await new Promise((r) => setTimeout(r, 30));
  try {
    const size = downloadWorkbook({
      rows, geo: st.geo, scope,
      dates: { mji: st.snapMji ? fmt.date(st.snapMji.dataDate) : '', edc: st.snapEdc ? fmt.date(st.snapEdc.dataDate) : '' },
    });
    toast(`Файл Excel сохранён в папку загрузок (${fmt.bytes(size)}): сводка, округа, районы, дома`, 'ok', 6000);
  } catch (e) {
    toast(`Не удалось сформировать Excel: ${e.message}`, 'error', 8000);
  }
}

function mapLayout(v) {
  const side = h('div', { class: 'map-side' });
  const layout = h('div', { class: 'map-layout' }, h('div', { style: { position: 'relative', minHeight: '0', display: 'flex', flexDirection: 'column' } }), side);
  v.append(layout);
  app.map.mount(layout.firstChild);
  app.map.shell.style.flex = '1';
  return { layout, side };
}

function mapContext(rows, mode) {
  const g = geoSet();
  const okrugKpi = new Map(groupKpi(app.state.rows, 'okrug', g).map((k) => [k.key, k]));
  const areaRows = app.f.okrug ? app.state.rows.filter((r) => r.okrug === app.f.okrug) : app.state.rows;
  const areaKpi = new Map(groupKpi(areaRows, 'area', g).map((k) => [k.key, k]));
  const id = !hasEdc() ? 'mkd' : mode === 'activity' ? app.ui.activity.metric : app.ui.choro;
  const ctx = { rows, geo: app.state.geo, zones: app.state.zones, boundaries: app.state.boundaries, okrugKpi, areaKpi, choro: metricDef(id), filters: app.f, mode };
  if (mode === 'activity' && app.map.layerSets.activity.hex) ctx.hex = hexCells(rows, app.state.geo, 600);
  return ctx;
}

// ---------------------------------------------------------------- вид «Сводка»

function renderSummary() {
  const v = $('#view-summary');
  clear(v);
  if (!hasMji()) { v.append(onboarding()); return; }
  const st = app.state;
  const data = summaryData(st.rows, geoSet());
  const metric = data.hasEdc ? app.ui.summaryMetric : 'mkd';
  const opts = {
    metric, selected: app.f.okrug,
    dates: { mji: st.snapMji ? fmt.date(st.snapMji.dataDate) : '', edc: st.snapEdc ? fmt.date(st.snapEdc.dataDate) : '' },
    onOkrug: (code) => { hideTip(); setFilter({ okrug: code, area: '' }); go('regions'); },
    onArea: (okrug, area) => {
      hideTip();
      app.f.okrug = okrug === NO_OKRUG ? '' : okrug;
      app.f.area = area === '(район не указан)' ? '' : area;
      app.ui.table.page = 0;
      go('houses');
    },
  };
  const png = async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const blob = await posterPng(data, opts);
      download(blob, `Сводка_ЕДЦ_${new Date().toISOString().slice(0, 10)}.png`);
    } catch (err) {
      toast(`Картинка не сохранилась: ${err.message}`, 'error', 7000);
    }
    b.disabled = false;
  };
  v.append(h('div', { class: 'view-head' },
    h('div', null, h('h1', null, 'Сводка по Москве'),
      h('p', null, 'Обслуживание домов в ЕДЦ по округам и районам и активность заявок 2026 года на одной картинке. Наведите на округ, район или клетку, чтобы увидеть числа; клик открывает округ или список домов района.')),
    h('div', { class: 'actions-row' },
      h('button', { class: 'btn', onclick: png }, icon('download', 16), 'Скачать картинку (PNG)'),
      h('button', { class: 'btn btn-primary', onclick: () => exportExcel(st.rows, 'Москва') }, icon('download', 16), 'Выгрузить всё в Excel'))));
  if (data.hasEdc) {
    v.append(h('div', { class: 'summary-bar' }, h('span', { class: 'small ink2' }, 'Цвет округов и районов:'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Цвет округов и районов' }, SUMMARY_METRICS.map((id) => h('button', {
        class: id === metric ? 'on' : '', onclick: () => { app.ui.summaryMetric = id; render(); },
      }, METRICS[id].short)))));
  } else {
    v.append(h('div', { class: 'note warn', style: { marginBottom: '14px' } }, icon('info'), h('div', null,
      h('b', null, 'Выгрузки ЕДЦ не загружены. '), 'Пока видно только число домов по реестру МЖИ. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openImportWizard(app); } }, 'Загрузить выгрузки ЕДЦ'))));
  }
  v.append(h('div', { class: 'poster-wrap' }, buildPoster(data, { ...opts, theme: isDarkTheme() ? 'dark' : 'light' })));
}

// ---------------------------------------------------------------- вид «Карта домов»

function renderMapView() {
  const v = $('#view-map');
  clear(v);
  v.classList.add('view-map');
  if (!hasMji()) { renderStartMap(v); return; }
  const rows = scopeRows();
  const k = kpiOf(rows, geoSet());
  v.append(kpiStrip(k));
  const { side } = mapLayout(v);
  app.map.mode = 'coverage';
  const ctx = mapContext(rows, 'coverage');
  const geoInScope = rows.filter((r) => app.state.geo.has(r.u)).length;
  if (!geoInScope) {
    ctx.overlay = h('div', null, h('h3', null, 'На карте пока нет домов'),
      h('div', { class: 'ink2 small' }, `Координаты есть у ${fmt.int(geoInScope)} из ${fmt.int(rows.length)} домов в выбранной области. Дома без геопозиции доступны в сводке, таблицах и поиске. Случайные точки приложение не ставит.`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => openGeocodeDialog(app, { autostart: true }) }, icon('pin', 14), 'Найти координаты всех домов'),
        h('button', { class: 'btn btn-sm', onclick: () => go('import') }, icon('upload', 14), 'Импорт координат'),
        !app.state.boundaries.okrug ? h('button', { class: 'btn btn-sm', onclick: () => loadBoundaries() }, icon('layers', 14), 'Границы округов и районов') : null));
  }
  app.map.update(ctx);
  side.append(statusCard(k));
  side.append(okrugCard(ctx.choro, MAIN_METRICS, (val) => { app.ui.choro = val; render(); }));
  side.append(dataNotesCard(k, rows));
}

function okrugCard(cm, metricIds, onPick, title = 'Заливка округов и районов') {
  const groups = groupKpi(app.state.rows, 'okrug', geoSet());
  const den = METRICS[cm.id].den;
  const tiles = new Map(groups.filter((g) => g.key !== NO_OKRUG).map((g) => [g.key, {
    value: cm.value(g), valueText: cm.text(g), n: den && METRICS[cm.id].fmt !== 'int' ? `N=${fmt.int(den(g))}` : '',
    flag: smallSampleFor(g, cm.id) ? icon('warn', 12) : '', flagTitle: `меньше ${MIN_SAMPLE} домов в знаменателе`,
    tip: () => [h('b', null, okrugByCode(g.key).full), h('div', null, `${cm.label}: `, h('b', null, cm.text(g))), h('div', { class: 'muted' }, cm.sub(g))],
  }]));
  const opts = metricIds.filter((id) => hasEdc() || !METRICS[id].needsEdc).map((id) => [id, METRICS[id].short]);
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, title), h('span', { class: 'sub' }, 'схема округов не в масштабе')),
    select(opts, cm.id, onPick, { 'aria-label': 'Показатель заливки', style: { width: '100%', marginBottom: '10px' } }),
    okrugTiles(tiles, { selected: app.f.okrug, onClick: (code) => setFilter({ okrug: app.f.okrug === code ? '' : code }), ramp: cm.ramp === 'heat' ? 'heat' : 'blue' }),
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, METRICS[cm.id].note));
}

function basemapCard() {
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Офлайн-карта')), basemapPanel());
}

/** Карта без загруженных данных: подложка видна сразу, рядом короткая инструкция. */
function renderStartMap(v) {
  const st = app.state;
  const { side } = mapLayout(v);
  app.map.mode = 'coverage';
  app.map.update(mapContext([], 'coverage'));
  const item = (title, text, done) => h('li', { class: done ? 'done' : '' }, h('span', { class: 'n' }, done ? icon('check', 13) : ''), h('div', null, h('b', null, title), h('div', { class: 'small ink2' }, text)));
  const src = st.sources;
  const found = src ? Object.values(src.files || {}).filter((f) => f.exists).length : 0;
  side.append(h('div', { class: 'card stack', style: { gap: '14px' } },
    h('div', null, h('h2', null, 'Аналитика покрытия'),
      h('p', { class: 'small ink2', style: { margin: '6px 0 0' } }, 'Какие дома Москвы обслуживаются в ЕДЦ, где обслуживается только часть подъездов и сколько по домам заявок. Расчёты выполняются на этом компьютере, данные никуда не отправляются.')),
    h('ol', { class: 'start-steps' },
      item('Реестр МЖИ', 'число домов по округам и районам', !!st.snapMji),
      item('Выгрузки ЕДЦ', 'запросы № 2, 3 и 4: обслуживание домов и заявки', !!st.snapEdc),
      item('Координаты домов', 'одной кнопкой «Найти координаты всех домов» после загрузки реестра', st.geo.size > 0)),
    h('div', { class: 'stack', style: { gap: '8px' } },
      src ? h('button', { class: 'btn btn-primary btn-block', onclick: () => openSourcesDialog(app) }, icon('database', 16), 'Загрузить из папки выгрузок') : null,
      src ? h('div', { class: 'small muted wrap' }, src.folderExists ? `Папка: ${src.folderResolved}, найдено файлов: ${found}` : `Папка не найдена: ${src.folderResolved || src.folder}`) : null,
      h('button', { class: 'btn btn-block', onclick: () => openImportWizard(app) }, icon('upload', 16), 'Выбрать файлы вручную'))),
  h('div', { class: 'note small' }, icon('info'), h('div', null, statusLegendText())));
}

function statusLegendText() {
  return 'Зелёный: дом обслуживается в ЕДЦ. Розовый: обслуживается часть подъездов. Красный: дом не обслуживается (его нет в ЕДЦ или ни один подъезд не привязан). Серый: данных не хватает.';
}

function statusCard(k) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Обслуживание домов'), h('span', { class: 'sub' }, scopeLabel())));
  if (!hasEdc()) {
    card.append(h('div', { class: 'note' }, icon('info'), h('div', null, 'Выгрузки ЕДЦ не загружены, поэтому обслуживание домов не рассчитывается.')));
    return card;
  }
  const parts = statusParts(k);
  const toHouses = (hs) => (e) => { e.preventDefault(); Object.assign(app.ui.table, { hs, cov: '', page: 0 }); go('houses'); };
  card.append(stackBar(parts),
    h('div', { class: 'stack', style: { gap: '3px', marginTop: '10px' } }, parts.map((p) => h('div', { class: 'status-line' },
      h('i', { class: 'sw', style: { background: p.color } }), icon(HS_ICON[p.key], 14),
      h('a', { href: '#houses', onclick: toHouses(p.key) }, p.label),
      h('span', { class: 'num' }, fmt.int(p.value)), h('span', { class: 'num muted' }, fmt.pct(k.mkd ? p.value / k.mkd : null)))),
    k.notInEdc ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, `Из не обслуживаемых домов ${fmt.int(k.notInEdc)} нет в выгрузке ЕДЦ, у остальных ни один подъезд не привязан.`) : null));
  return card;
}

function dataNotesCard(k, rows) {
  const st = app.state;
  return h('div', { class: 'card stack', style: { gap: '8px' } },
    h('h3', null, 'Источник и полнота'),
    h('div', { class: 'small ink2' }, `Срез МЖИ: ${fmt.date(st.snapMji && st.snapMji.dataDate)}, ЕДЦ: ${st.snapEdc ? fmt.date(st.snapEdc.dataDate) : 'нет'}.`),
    h('div', { class: 'small ink2' }, `На карте ${fmt.int(rows.filter((r) => st.geo.has(r.u)).length)} из ${fmt.int(rows.length)} домов (только дома с сохранённой геопозицией).`),
    rows.some((r) => !st.geo.has(r.u)) ? h('button', { class: 'btn btn-sm btn-primary btn-block', onclick: () => openGeocodeDialog(app, { autostart: true }) }, icon('pin', 14), 'Найти координаты всех домов') : null,
    !st.boundaries.okrug || !st.boundaries.area ? h('button', { class: 'btn btn-sm btn-block', onclick: () => loadBoundaries() }, icon('layers', 14), 'Загрузить границы округов и районов') : null);
}

function scopeLabel() {
  if (app.f.area) return `${app.f.okrug ? `${app.f.okrug}, ` : ''}${app.f.area}`;
  if (app.f.okrug) return okrugByCode(app.f.okrug)?.full || app.f.okrug;
  return 'вся Москва';
}

// ---------------------------------------------------------------- вид «Активность заявок»

function renderActivity() {
  const v = $('#view-activity');
  clear(v);
  if (!hasMji()) { v.append(onboarding()); return; }
  const rows = scopeRows();
  const as = app.ui.activity;
  const m = METRICS[as.metric];
  const b = app.state.boundaries;
  v.append(h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Активность заявок 2026'),
    h('p', null, 'Где больше заявок на один обслуживаемый дом. Заливка районов считается по всем домам района и не зависит от координат. Сетка 600 м показывает то же по домам с координатами.'))));
  const { side } = mapLayout(v);
  app.map.mode = 'activity';
  const lay = app.map.layerSets.activity;
  if (!b.area && !b.okrug && app.state.geo.size) lay.hex = true; // границ нет: показать сетку
  const ctx = mapContext(rows, 'activity');
  if (!hasEdc()) {
    ctx.overlay = h('div', null, h('h3', null, 'Нет данных заявок'), h('div', { class: 'small ink2' }, 'Загрузите выгрузки ЕДЦ (SQL № 4 или объединённые CSV).'),
      h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm btn-primary', onclick: () => openImportWizard(app) }, icon('upload', 14), 'Загрузить')));
  } else if (!b.area && !b.okrug && !(ctx.hex && ctx.hex.cells.length)) {
    ctx.overlay = h('div', null, h('h3', null, 'Нечем закрасить карту'),
      h('div', { class: 'small ink2' }, 'Для заливки районов нужны их границы, для сетки нужны координаты домов. Границы загружаются одной кнопкой за пару минут.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => loadBoundaries() }, icon('layers', 14), 'Загрузить границы округов и районов'),
        h('button', { class: 'btn btn-sm', onclick: () => openGeocodeDialog(app, { autostart: true }) }, icon('pin', 14), 'Найти координаты домов')));
  }
  app.map.update(ctx);
  const quarterOk = !!m.period;
  const show = (hex) => { lay.hex = hex; if (!hex) lay.area = true; render(); };
  side.append(h('div', { class: 'card stack' },
    h('h3', null, 'Показатель'),
    h('div', { class: 'seg seg-wrap', role: 'group', 'aria-label': 'Показатель активности' }, ACTIVITY_METRICS.map((id) => h('button', { class: as.metric === id ? 'on' : '', disabled: !hasEdc(), onclick: () => { as.metric = id; render(); } }, METRICS[id].short))),
    h('div', { class: 'small muted' }, m.note),
    h('div', { class: 'field-inline' }, h('label', null, 'Период'),
      select(Object.entries(QUARTERS).map(([k2, l]) => [k2, l, !!k2 && !quarterOk]), quarterOk ? app.f.quarter : '', (val) => setFilter({ quarter: val }), { disabled: !quarterOk })),
    h('div', { class: 'field-inline' }, h('label', null, 'Показать'),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Чем закрасить карту' },
        h('button', { class: lay.hex ? '' : 'on', disabled: !b.area && !b.okrug, onclick: () => show(false) }, b.area ? 'Районы' : 'Округа'),
        h('button', { class: lay.hex ? 'on' : '', disabled: !app.state.geo.size, onclick: () => show(true) }, 'Сетка 600 м'))),
    lay.hex && ctx.hex ? h('div', { class: 'small muted' }, `Сетка по ${fmt.int(ctx.hex.geoRows)} домам с координатами из ${fmt.int(rows.length)}.`) : null));
  side.append(topAreasCard(rows, as.metric));
  const q = m.period ? app.f.quarter : '';
  const top = rows.map((r) => ({ r, v: reqValue(r, 'total', q) })).filter((x) => x.v > 0).sort((a, c) => c.v - a.v).slice(0, 10);
  side.append(h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Дома с наибольшим числом заявок'), h('span', { class: 'sub' }, q ? QUARTERS[q] : '2026')),
    top.length ? h('div', { class: 'stack', style: { gap: '4px' } }, top.map((x, i) => h('button', {
      class: 'bar-row', style: { gridTemplateColumns: '20px 1fr auto', width: '100%', border: '0', background: 'none', textAlign: 'left' },
      onclick: () => openCard(app, x.r.u),
    }, h('span', { class: 'rank' }, i + 1), h('span', { class: 'small' }, x.r.address, h('span', { class: 'muted' }, `, ${x.r.area}`)), h('b', { class: 'num' }, fmt.int(x.v))))) : h('div', { class: 'muted small' }, hasEdc() ? 'Нет заявок в выбранной области' : 'Нет данных ЕДЦ')));
}

function topAreasCard(rows, metric) {
  const groups = groupKpi(rows, 'area', geoSet());
  const okrugOf = new Map(rows.map((r) => [r.area || '(район не указан)', r.okrug]));
  const all = groups.map((g) => ({ g, v: metricValue(g, metric, app.f.quarter), small: smallSampleFor(g, metric) })).filter((x) => Number.isFinite(x.v));
  const big = all.filter((x) => !x.small);
  const list = (big.length >= 3 ? big : all).sort((a, b) => b.v - a.v).slice(0, 10); // на малых данных показать все районы
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Районы с наибольшим значением'), h('span', { class: 'sub' }, METRICS[metric].short)),
    list.length ? h('div', { class: 'stack', style: { gap: '4px' } }, list.map((x, i) => h('button', {
      class: 'bar-row', style: { gridTemplateColumns: '20px 1fr auto', width: '100%', border: '0', background: 'none', textAlign: 'left' },
      onclick: () => setFilter({ okrug: okrugOf.get(x.g.key) || '', area: x.g.key }),
      title: metricSub(metric, x.g),
    }, h('span', { class: 'rank' }, i + 1), h('span', { class: 'small' }, x.g.key, h('span', { class: 'muted' }, `, ${okrugOf.get(x.g.key) || ''}${x.small ? `, мало домов (${fmt.int(METRICS[metric].den(x.g))})` : ''}`)), h('b', { class: 'num' }, fmtMetric(metric, x.v))))) : h('div', { class: 'muted small' }, hasEdc() ? 'Нет районов с данными' : 'Нет данных ЕДЦ'));
}

// ---------------------------------------------------------------- вид «Округа и районы»

function renderRegions() {
  const v = $('#view-regions');
  clear(v);
  if (!hasMji()) { v.append(onboarding()); return; }
  const edc = hasEdc();
  let metric = app.ui.regionMetric;
  if (!edc && METRICS[metric].needsEdc) metric = 'mkd';
  const m = METRICS[metric];
  const g = geoSet();
  const groups = groupKpi(app.state.rows, 'okrug', g);
  const ranked = rankGroups(groups, metric, { quarter: app.f.quarter });
  v.append(h('div', { class: 'view-head' },
    h('div', null, h('h1', null, 'Округа и районы'), h('p', null, `${m.note}${periodLabel(metric) ? ` Период: ${periodLabel(metric)}.` : ''}`)),
    h('div', { class: 'actions-row' },
      h('button', { class: 'btn', onclick: () => exportExcel(scopeRows(), scopeLabel()) }, icon('download', 16), app.f.okrug ? 'Выгрузить округ в Excel' : 'Выгрузить в Excel'))));
  v.append(h('div', { class: 'seg seg-wrap', role: 'group', 'aria-label': 'Показатель', style: { marginBottom: '14px' } }, MAIN_METRICS.map((id) => h('button', {
    class: id === metric ? 'on' : '', disabled: METRICS[id].needsEdc && !edc, title: METRICS[id].needsEdc && !edc ? 'Нужны выгрузки ЕДЦ' : METRICS[id].label,
    onclick: () => { app.ui.regionMetric = id; render(); },
  }, METRICS[id].short))));
  v.append(kpiStrip(kpiOf(scopeRows(), g)));
  if (!edc) {
    v.append(h('div', { class: 'note warn', style: { marginBottom: '14px' } }, icon('info'), h('div', null,
      h('b', null, 'Обслуживание и заявки пока не рассчитываются: '), 'нет выгрузок ЕДЦ. Ниже показано число домов по реестру МЖИ. ',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); openImportWizard(app); } }, 'Загрузить выгрузки ЕДЦ'))));
  }
  const sorted = [...ranked].sort((a, b) => (a.rank || 99) - (b.rank || 99) || (b.value ?? -1) - (a.value ?? -1));
  const items = sorted.map((x) => {
    const okr = okrugByCode(x.key);
    return {
      key: x.key, label: x.key, value: x.value, rank: x.rank, muted: x.small || x.key === NO_OKRUG,
      valueText: fmtMetric(metric, x.value),
      sub: x.small ? `мало домов: ${fmt.int(m.den(x))}` : m.num ? `${fmt.int(m.num(x))} / ${fmt.int(m.den(x))}` : '',
      tip: () => [h('b', null, okr ? okr.full : x.key), h('div', null, `${m.short}: `, h('b', null, fmtMetric(metric, x.value))), h('div', { class: 'muted' }, metricSub(metric, x))],
    };
  });
  const left = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, m.label), h('span', { class: 'sub' }, periodLabel(metric))),
    barChart(items, { selected: app.f.okrug, onClick: (code) => setFilter({ okrug: app.f.okrug === code ? '' : code }) }),
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, metric === 'notServed' ? 'Места: от меньшего числа не обслуживаемых домов к большему. ' : '', 'Клик по округу фильтрует таблицу районов, карту и выгрузку.'));
  const right = h('div', { class: 'stack' },
    okrugCard(metricDef(metric), MAIN_METRICS, (val) => { app.ui.regionMetric = val; render(); }, 'Схема округов'),
    edc ? compositionCard(groups) : null);
  v.append(h('div', { class: 'grid-2', style: { gridTemplateColumns: 'minmax(0, 1.35fr) minmax(0, 1fr)', marginBottom: '14px' } }, left, right));
  v.append(okrugTable(groups, ranked));
  v.append(areaTable());
}

function compositionCard(groups) {
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Обслуживание домов по округам'), h('span', { class: 'sub' }, 'доли от домов МЖИ')));
  const list = h('div', { class: 'stack', style: { gap: '6px' } });
  const rows = groups.filter((g) => g.key !== NO_OKRUG).sort((a, b) => (b.servedShare ?? -1) - (a.servedShare ?? -1));
  for (const g of rows) {
    list.append(h('div', { class: 'comp-row', onclick: () => setFilter({ okrug: app.f.okrug === g.key ? '' : g.key }) },
      h('b', { class: 'small' }, g.key), stackBar(statusParts(g)), h('span', { class: 'small num' }, fmt.pct(g.servedShare))));
  }
  card.append(list, legend(statusParts(groups.reduce((acc, g) => { for (const s of HS_ORDER) acc.hs[s] += g.hs[s]; return acc; }, { hs: { full: 0, partial: 0, none: 0, unknown: 0, excluded: 0 } })).map((p) => ({ ...p, value: undefined }))));
  return card;
}

/** Столбцы показателей для таблиц округов и районов. */
function kpiColumns(edc) {
  const q = app.f.quarter;
  const num = (key, label, value, text, opts = {}) => ({
    key, label, type: 'num', r: true,
    value: opts.always ? value : (g) => (edc ? value(g) : null),
    cell: (g) => (edc || opts.always ? text(g) : na()),
    disabled: !edc && !opts.always, scale: opts.scale,
  });
  return [
    num('mkd', 'Домов МЖИ', (g) => g.mkd, (g) => fmt.int(g.mkd), { always: true }),
    num('served', 'Обслуживаются', (g) => g.served, (g) => fmt.int(g.served)),
    num('servedShare', '% обслуживается', (g) => g.servedShare ?? null, (g) => h('b', null, fmt.pct(g.servedShare)), { scale: 100 }),
    num('full', 'Все подъезды', (g) => g.hs.full, (g) => fmt.int(g.hs.full)),
    num('partial', 'Часть подъездов', (g) => g.hs.partial, (g) => fmt.int(g.hs.partial)),
    num('none', 'Не обслуживаются', (g) => g.hs.none, (g) => fmt.int(g.hs.none)),
    num('notInEdc', 'из них нет в ЕДЦ', (g) => g.notInEdc, (g) => fmt.int(g.notInEdc)),
    num('entrShare', '% подъездов', (g) => g.entrShare ?? null, (g) => fmt.pct(g.entrShare), { scale: 100 }),
    num('req', `Заявок${q ? `, ${QUARTERS[q]}` : ' 2026'}`, (g) => (q ? g.req[q] : g.req.total), (g) => fmt.int(q ? g.req[q] : g.req.total)),
    num('reqPerHouse', 'Заявок на дом', (g) => metricValue(g, 'reqPerHouse', q), (g) => fmt.num1(metricValue(g, 'reqPerHouse', q))),
    num('activeShare', '% домов с заявками', (g) => g.activeShare ?? null, (g) => fmt.pct(g.activeShare), { scale: 100 }),
    num('geo', 'С координатами', (g) => g.geo, (g) => fmt.int(g.geo), { always: true }),
  ];
}

function okrugTable(groups, ranked) {
  const rk = new Map(ranked.map((x) => [x.key, x.rank]));
  const st = app.state;
  const columns = [
    { key: 'rank', label: 'Место', type: 'num', r: true, value: (g) => rk.get(g.key) ?? null, cell: (g) => rk.get(g.key) || na() },
    {
      key: 'okrug', label: 'Округ', type: 'text', value: (g) => g.key,
      search: (g) => { const o = okrugByCode(g.key); return `${g.key} ${o ? `${o.name} ${o.full}` : ''}`; },
      cell: (g) => [h('b', null, g.key), h('div', { class: 'sub' }, okrugByCode(g.key)?.name || '')],
    },
    ...kpiColumns(hasEdc()),
  ];
  app.ui.okrugTable = app.ui.okrugTable || {};
  const { table, tools } = dataTable({
    rows: groups, columns, state: app.ui.okrugTable,
    rowAttrs: (g) => ({ class: `clickable ${app.f.okrug === g.key ? 'sel' : ''}`, onclick: () => setFilter({ okrug: app.f.okrug === g.key ? '' : g.key }) }),
  });
  return h('div', { class: 'card', style: { marginBottom: '14px' } },
    h('div', { class: 'card-head' }, h('h3', null, 'Округа'),
      h('span', { class: 'sub' }, `Срез МЖИ ${fmt.date(st.snapMji && st.snapMji.dataDate)}, ЕДЦ ${st.snapEdc ? fmt.date(st.snapEdc.dataDate) : NA}`)),
    tools, table);
}

function areaTable() {
  const okrug = app.f.okrug;
  const rows = okrug ? app.state.rows.filter((r) => r.okrug === okrug) : app.state.rows;
  const groups = groupKpi(rows, 'area', geoSet());
  const okrugOf = new Map(rows.map((r) => [r.area || '(район не указан)', r.okrug]));
  const columns = [
    { key: 'key', label: 'Район', type: 'text', value: (g) => g.key },
    { key: 'okrug', label: 'Округ', type: 'text', value: (g) => okrugOf.get(g.key) || '' },
    ...kpiColumns(hasEdc()),
  ];
  app.ui.areaTable = app.ui.areaTable || { sort: 'servedShare', dir: 1 };
  const { table, tools } = dataTable({
    rows: groups, columns, state: app.ui.areaTable, maxHeight: '560px',
    rowAttrs: (g) => ({
      class: 'clickable', onclick: () => {
        app.f.okrug = okrugOf.get(g.key) || app.f.okrug; app.f.area = g.key === '(район не указан)' ? '' : g.key; app.ui.table.page = 0; go('houses');
      },
    }),
  });
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', null, okrug ? `Районы: ${okrugByCode(okrug)?.full || okrug}` : 'Районы Москвы'), h('span', { class: 'sub' }, `${groups.length} ${plural(groups.length, 'район', 'района', 'районов')}, по клику откроется список домов`)),
    tools, table);
}

// ---------------------------------------------------------------- вид «Дома и подъезды»

const GEO_LABEL = { '': 'Любая', none: 'Нет координат', any: 'Есть координаты', mosreg: 'Реестр Москвы (UNOM)', osm: 'OSM по адресу', yandex: 'Яндекс Геокодер', auto: 'Геокодер (не проверено)', verified: 'Проверено', manual: 'Вручную', imported: 'Из файла', review: 'Требует проверки' };

function filteredHouses() {
  const t = app.ui.table;
  const toks = lowerYo(t.q).split(/[\s,.]+/).filter(Boolean);
  const geo = app.state.geo;
  const min = t.reqMin === '' ? null : Number(t.reqMin);
  const max = t.reqMax === '' ? null : Number(t.reqMax);
  const q = app.f.quarter;
  return scopeRows().filter((r) => {
    if (t.hs && houseStatus(r) !== t.hs) return false;
    if (t.cov) {
      if (t.cov.startsWith('na:')) { if (r.na !== t.cov.slice(3)) return false; } else if (r.cov !== t.cov) return false;
    }
    if (t.match && r.m !== t.match) return false;
    if (t.actual) { const a = r.e ? String(r.e.ac) : 'nodata'; if (a !== t.actual) return false; }
    if (t.type) { const ty = r.e ? (r.e.htn || 'empty') : 'nodata'; if (ty !== t.type) return false; }
    if (t.setting) { const s = r.e ? (r.e.rel > 0 ? 'yes' : 'no') : 'nodata'; if (s !== t.setting) return false; }
    if (t.geo) {
      const g = geo.get(r.u);
      if (t.geo === 'none' && g) return false;
      if (t.geo === 'any' && !g) return false;
      if (t.geo === 'review' && !(g && (g.status === 'auto' || g.review))) return false;
      if (!['none', 'any', 'review'].includes(t.geo) && (!g || g.status !== t.geo)) return false;
    }
    if (min !== null || max !== null) {
      const v = reqValue(r, 'total', q) || 0;
      if (min !== null && v < min) return false;
      if (max !== null && v > max) return false;
    }
    if (toks.length) {
      const hay = lowerYo(`${r.address} ${r.ur} ${r.fiasRaw} ${r.e ? `${r.e.r} ${r.e.a}` : ''} ${r.uk}`);
      if (!toks.every((tk) => hay.includes(tk))) return false;
    }
    return true;
  });
}

function sortHouses(list) {
  const t = app.ui.table;
  const q = app.f.quarter;
  const hsOrder = { full: 0, partial: 1, none: 2, unknown: 3, excluded: 4 };
  const key = {
    address: (r) => r.address || '', okrug: (r) => `${r.okrug} ${r.area}`, unom: (r) => Number(r.u) || 0,
    hs: (r) => hsOrder[houseStatus(r)] ?? 9, entr: (r) => (r.e ? r.e.et : -1), req: (r) => reqValue(r, 'total', q) || 0,
    match: (r) => r.m, geo: (r) => (app.state.geo.has(r.u) ? 1 : 0),
  }[t.sort] || ((r) => r.address);
  return [...list].sort((a, b) => {
    const x = key(a); const y = key(b);
    return (typeof x === 'string' ? x.localeCompare(y, 'ru', { numeric: true }) : x - y) * t.dir;
  });
}

function renderHouses() {
  const v = $('#view-houses');
  clear(v);
  if (!hasMji()) { v.append(onboarding()); return; }
  const t = app.ui.table;
  const list = sortHouses(filteredHouses());
  const pages = Math.max(1, Math.ceil(list.length / t.size));
  if (t.page >= pages) t.page = pages - 1;
  const pageRows = list.slice(t.page * t.size, (t.page + 1) * t.size);
  const set = (patch) => { Object.assign(t, patch, { page: 0 }); render(); };
  const qInput = h('input', { type: 'search', value: t.q, placeholder: 'Адрес, УНОМ, ФИАС, UUID, УО', style: { minWidth: '260px' } });
  qInput.addEventListener('input', debounce(() => { set({ q: qInput.value }); setTimeout(() => { const el = $('#view-houses input[type=search]'); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 0); }, 350));
  const naOpts = Object.entries(NA_REASON).map(([k, l]) => [`na:${k}`, `- ${l}`]);
  v.append(h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Дома и подъезды'),
    h('p', null, `${scopeLabel()}, ${fmt.int(list.length)} ${plural(list.length, 'дом', 'дома', 'домов')} по фильтрам. Клик по строке открывает карточку дома.`)),
  h('div', { class: 'actions-row' },
    h('button', { class: 'btn', onclick: () => exportExcel(list, `${scopeLabel()}, фильтр таблицы`) }, icon('download', 16), 'Excel по фильтру'),
    h('button', { class: 'btn', onclick: () => exportHouses(list) }, icon('download', 16), 'CSV'),
    h('button', { class: 'btn btn-ghost', onclick: () => { Object.assign(t, { q: '', hs: '', cov: '', match: '', actual: '', type: '', setting: '', geo: '', reqMin: '', reqMax: '', page: 0 }); render(); } }, 'Сбросить фильтры'))));
  const fld = (label, el) => h('div', { class: 'field-inline' }, h('label', null, label), el);
  v.append(h('div', { class: 'filter-bar' },
    fld('Поиск', qInput),
    fld('Статус', select([['', 'Любой'], ...HS_ORDER.map((k) => [k, HS_LABEL[k]])], t.hs, (x) => set({ hs: x }))),
    fld('Привязка подъездов', select([['', 'Любая'], ...Object.entries(COV_LABEL).map(([k, l]) => [k, l]), ...naOpts], t.cov, (x) => set({ cov: x }))),
    fld('Сопоставление', select([['', 'Любое'], ...Object.entries(MATCH_LABEL).map(([k, l]) => [k, l])], t.match, (x) => set({ match: x }))),
    fld('actual (ЕДЦ)', select([['', 'Любой'], ['true', 'true'], ['false', 'false'], ['null', 'не определено'], ['nodata', 'нет записи ЕДЦ']], t.actual, (x) => set({ actual: x }))),
    fld('Тип (ЕДЦ)', select([['', 'Любой'], ['жилое', 'Жилое'], ['нежилое', 'Нежилое'], ['other', 'Иной / не установлен'], ['nodata', 'нет записи ЕДЦ']], t.type, (x) => set({ type: x }))),
    fld('Настройка обслуживания', select([['', 'Любая'], ['yes', 'Есть'], ['no', 'Нет найденной'], ['nodata', 'нет записи ЕДЦ']], t.setting, (x) => set({ setting: x }))),
    fld('Геопривязка', select(Object.entries(GEO_LABEL), t.geo, (x) => set({ geo: x }))),
    fld('Заявок от', h('input', { type: 'number', min: 0, value: t.reqMin, style: { width: '90px' }, onchange: (e) => set({ reqMin: e.target.value }) })),
    fld('до', h('input', { type: 'number', min: 0, value: t.reqMax, style: { width: '90px' }, onchange: (e) => set({ reqMax: e.target.value }) }))));
  const th = (key, label, r) => h('th', { class: `sortable ${r ? 'r' : ''}`, onclick: () => { app.ui.table.dir = t.sort === key ? -t.dir : (key === 'req' || key === 'entr' ? -1 : 1); app.ui.table.sort = key; render(); } },
    label, t.sort === key ? h('span', { class: 'arrow' }, t.dir > 0 ? '↑' : '↓') : null);
  const q = app.f.quarter;
  const tbl = h('table', { class: 'tbl' },
    h('thead', null, h('tr', null, th('address', 'Адрес (МЖИ)'), th('okrug', 'Округ / район'), th('unom', 'UNOM', true), th('match', 'Сопоставление'), th('hs', 'Статус'), th('entr', 'Подъезды обслуживаются', true), th('req', `Заявок 2026${q ? ` (${q.toUpperCase()})` : ''}`, true), th('geo', 'Гео'))),
    h('tbody', null, pageRows.map((r) => {
      const g = app.state.geo.get(r.u);
      return h('tr', { class: 'clickable', onclick: () => openCard(app, r.u) },
        h('td', { class: 'addr' }, r.address, r.e && r.e.a && lowerYo(r.e.a) !== lowerYo(r.address) ? h('div', { class: 'sub' }, `ЕДЦ: ${r.e.a}`) : null),
        h('td', null, r.okrug, h('div', { class: 'sub' }, r.area)),
        h('td', { class: 'r mono' }, r.ur),
        h('td', null, MATCH_LABEL[r.m] || r.m, r.mm ? h('div', { class: 'sub' }, { unom: 'УНОМ', fias: 'ФИАС', manual: 'вручную' }[r.mm]) : null),
        h('td', null, hsBadge(houseStatus(r)), r.na ? h('div', { class: 'sub' }, NA_REASON[r.na]) : null),
        h('td', { class: 'r' }, r.e ? `${fmt.int(Math.min(r.e.el, r.e.et))} / ${fmt.int(r.e.et)}` : na()),
        h('td', { class: 'r' }, r.q ? fmt.int(reqValue(r, 'total', q)) : na()),
        h('td', null, g ? h('span', { class: `chip ${g.status === 'auto' || g.review ? 'warn' : ''}` }, { manual: 'вручную', verified: 'проверено', auto: 'проверить', imported: 'файл', osm: 'OSM', yandex: 'Яндекс', mosreg: 'реестр' }[g.status] || g.status) : na()));
    })));
  v.append(h('div', { class: 'table-wrap' }, tbl));
  v.append(h('div', { class: 'pager' },
    h('span', null, list.length ? `${fmt.int(t.page * t.size + 1)}-${fmt.int(Math.min(list.length, (t.page + 1) * t.size))} из ${fmt.int(list.length)}` : 'Нет домов по фильтрам'),
    h('div', { class: 'actions-row' },
      h('button', { class: 'btn btn-sm', disabled: t.page === 0, onclick: () => { t.page = 0; render(); } }, '« Первая'),
      h('button', { class: 'btn btn-sm', disabled: t.page === 0, onclick: () => { t.page--; render(); } }, 'Назад'),
      h('span', { class: 'small' }, `стр. ${t.page + 1} из ${pages}`),
      h('button', { class: 'btn btn-sm', disabled: t.page >= pages - 1, onclick: () => { t.page++; render(); } }, 'Вперёд'))));
}

function exportHouses(list) {
  const header = ['UNOM', 'Код МЖИ', 'Округ', 'Район', 'Адрес МЖИ', 'ФИАС МЖИ', 'Управляющая организация', 'Сопоставление', 'Способ', 'Правило',
    'Корневой ID адреса ЕДЦ', 'ID записи адреса ЕДЦ', 'Адрес ЕДЦ', 'Тип дома ЕДЦ', 'actual', 'Статус покрытия (привязки ЕДЦ)', 'Причина «не оценено»',
    'Статус', 'Подъездов в ЕДЦ', 'Подъездов с найденной привязкой', ...['всего', 'с датой закрытия', 'без даты закрытия', 'критических', 'I кв', 'II кв', 'III кв', 'IV кв (частичный)'].map((x) => `Заявок 2026 ${x}`),
    'Широта', 'Долгота', 'Источник геопозиции', 'Статус геопозиции'];
  const rows = list.map((r) => {
    const g = app.state.geo.get(r.u);
    const q = r.q || [];
    return [r.ur, r.code, r.okrug, r.area, r.address, r.fiasRaw, r.uk, MATCH_LABEL[r.m] || r.m, r.mm, r.mr,
      r.e ? r.e.ro : '', r.e ? r.e.i : '', r.e ? r.e.a : '', r.e ? r.e.ht : '', r.e ? String(r.e.ac) : '', COV_LABEL[r.cov], NA_REASON[r.na] || '',
      HS_LABEL[houseStatus(r)], r.e ? r.e.et : '', r.e ? r.e.el : '', ...(r.q ? [q[Q.total], q[Q.closed], q[Q.open], q[Q.critical], q[Q.q1], q[Q.q2], q[Q.q3], q[Q.q4]] : ['', '', '', '', '', '', '', '']),
      g ? g.lat : '', g ? g.lon : '', g ? g.source : '', g ? g.status : ''];
  });
  download(new Blob([toCsv(header, rows)], { type: 'text/csv;charset=utf-8' }), `дома_${scopeLabel().replace(/[^\wа-яё -]+/gi, '_')}_${new Date().toISOString().slice(0, 10)}.csv`);
}

// ---------------------------------------------------------------- вид «Импорт и качество данных»

function renderImport() {
  const v = $('#view-import');
  clear(v);
  const st = app.state;
  v.append(h('div', { class: 'view-head' }, h('div', null, h('h1', null, 'Импорт и качество данных'),
    h('p', null, 'Раз в месяц загрузите новые выгрузки, проверьте изменения и примените снимок. Геоточки и ручные правки при этом сохраняются.')),
  h('button', { class: 'btn btn-primary', onclick: () => openImportWizard(app) }, icon('upload', 16), 'Обновить данные')));
  v.append(h('div', { class: 'grid-3', style: { marginBottom: '14px' } }, sourceCardMji(), sourceCardEdc(), sourceCardGeo()));
  v.append(h('div', { style: { marginBottom: '14px' } }, sourcesSummary(app, st.sources)));
  const local = st.local.filter((f) => /\.(xlsx|csv|geojson|json)$/i.test(f.name));
  if (local.length) {
    v.append(h('div', { class: 'card', style: { marginBottom: '14px' } }, h('div', { class: 'card-head' }, h('h3', null, `Файлы в data/local (${local.length})`),
      h('button', { class: 'btn btn-sm', onclick: async () => openImportWizard(app, await fetchLocalFiles(local)) }, icon('upload', 14), 'Открыть в мастере импорта')),
    h('div', { class: 'small ink2' }, local.map((f) => f.name).join(', '))));
  }
  v.append(qualityCard());
  v.append(h('div', { class: 'grid-3', style: { margin: '14px 0' } }, geoToolsCard(), boundariesCard(), basemapCard()));
  v.append(historyCard());
  v.append(h('div', { class: 'grid-2', style: { marginTop: '14px' } }, backupCard(), settingsCard()));
}

function srcCard(title, ok, lines, actions) {
  return h('div', { class: 'card stack', style: { gap: '6px' } },
    h('div', { class: 'card-head', style: { marginBottom: '2px' } }, h('h3', null, title), ok ? h('span', { class: 'badge st-full' }, icon('check', 13), 'загружено') : h('span', { class: 'badge st-na' }, 'нет данных')),
    ...lines.map((l) => (typeof l === 'string' ? h('div', { class: 'small ink2 wrap' }, l) : l)), actions ? h('div', { class: 'actions-row', style: { marginTop: '6px' } }, actions) : null);
}

function sourceCardMji() {
  const s = app.state.snapMji;
  if (!s) return srcCard('Реестр МЖИ', false, ['XLSX/CSV с UNOM, округом, районом, адресом, ФИАС, УО.']);
  const r = s.report || {};
  return srcCard('Реестр МЖИ', true, [
    `${s.files?.[0]?.name || ''}`, `Срез: ${fmt.date(s.dataDate)}, применён ${fmt.dateTime(s.committedAt)}`,
    `${fmt.int(r.rowsTotal)} записей, ${Object.keys(r.byOkrug || {}).filter((k) => k !== NO_OKRUG).length} округов, ${fmt.int(r.areas)} районов`,
    app.state.mjiGone.length ? `Пропали из последнего снимка: ${fmt.int(app.state.mjiGone.length)} (помечены, не удалены)` : '']);
}

function sourceCardEdc() {
  const s = app.state.snapEdc;
  if (!s) return srcCard('Выгрузки ЕДЦ', false, ['Три CSV SQL № 2/3/4 или два объединённых CSV по инструкции S2.']);
  const c = s.report?.control || {};
  return srcCard('Выгрузки ЕДЦ', true, [
    { raw: 'Три исходных CSV (объединены в браузере)', merged: 'Два объединённых CSV', requests: 'Обновление только заявок' }[s.mode] || s.mode,
    `Срез: ${fmt.date(s.dataDate)}, применён ${fmt.dateTime(s.committedAt)}`,
    `${fmt.int(c.houses?.rows)} адресов, ${fmt.int(c.entrances?.real)} подъездов, ${fmt.int(c.entrances?.stubs)} заглушек`,
    c.requests ? `Агрегатов заявок: дом ${fmt.int(c.requests.houseLevel)}, подъезд ${fmt.int(c.requests.entranceLevel)}` : '',
    app.state.edcGoneCount ? `Адресов, пропавших из последнего снимка: ${fmt.int(app.state.edcGoneCount)}` : '']);
}

function sourceCardGeo() {
  const st = app.state;
  const by = {};
  for (const g of st.geo.values()) by[g.status] = (by[g.status] || 0) + 1;
  const buildings = [...st.geo.values()].filter((g) => g.building).length;
  return srcCard('Геоданные (ручная работа)', st.geo.size > 0, [
    `${fmt.int(st.geo.size)} домов с координатами, ${fmt.int(buildings)} контуров, ${fmt.int(st.zones.length)} зон подъездов`,
    Object.entries(by).map(([k, n]) => `${{ manual: 'вручную', verified: 'проверено', auto: 'требует проверки', imported: 'из файла', osm: 'OSM по адресу', yandex: 'Яндекс Геокодер', mosreg: 'реестр Москвы' }[k] || k}: ${fmt.int(n)}`).join(', ') || 'Хранятся отдельно от ежемесячных выгрузок.',
    `Ручных соответствий МЖИ и ЕДЦ: ${fmt.int(st.overrides.size)}`]);
}

function qualityCard() {
  const st = app.state;
  const card = h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'Отчёт о качестве данных')));
  const sec = (title, items) => h('div', { style: { marginBottom: '12px' } }, h('h4', { style: { fontSize: '13px', marginBottom: '6px' } }, title),
    h('div', { class: 'stack', style: { gap: '4px' } }, items.filter(Boolean)));
  const line = (label, value, opts = {}) => h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '12px', borderBottom: '1px dashed var(--grid)', padding: '3px 0' } },
    h('span', { class: 'small' }, opts.link ? h('a', { href: '#houses', onclick: (e) => { e.preventDefault(); opts.link(); } }, label) : label, opts.hint ? h('span', { class: 'muted' }, ` (${opts.hint})`) : null),
    h('span', { class: `small num ${opts.warn ? '' : 'ink2'}`, style: opts.warn ? { color: 'var(--danger-ink)', fontWeight: 600 } : {} }, value));
  const toHouses = (patch) => () => { Object.assign(app.ui.table, { q: '', hs: '', cov: '', match: '', actual: '', type: '', setting: '', geo: '', reqMin: '', reqMax: '', page: 0 }, patch); go('houses'); };
  const grid = h('div', { class: 'grid-3' });
  const r = st.snapMji ? st.snapMji.report || {} : null;
  grid.append(sec('Реестр МЖИ', r ? [
    line('Записей', fmt.int(r.rowsTotal)),
    line('Без ФИАС', fmt.int(r.noFias)),
    line('Некорректный ФИАС (не UUID)', fmt.int(r.invalidFias), { hint: (r.invalidFiasExamples || []).slice(0, 3).join(', '), warn: r.invalidFias > 0 }),
    line('Повторяющиеся ФИАС', `${fmt.int(r.dupFiasValues)} значений / ${fmt.int(r.dupFiasRows)} строк`),
    line('Без округа и района', fmt.int(r.noOkrug), { warn: r.noOkrug > 0 }),
    line('Без управляющей организации', fmt.int(r.noUk)),
    line('Без UNOM', fmt.int(r.noUnom), { warn: r.noUnom > 0 }),
  ] : [h('div', { class: 'muted small' }, 'Нет данных')]));
  const k = kpiOf(st.rows, geoSet());
  const es = st.edcStats;
  grid.append(sec('Сопоставление МЖИ и ЕДЦ', es ? [
    line('Сопоставлено', `${fmt.int(k.matched)} (${fmt.pct(k.matchRate)})`),
    line('Не найдено в ЕДЦ', fmt.int(k.na.not_matched || 0), { link: toHouses({ cov: 'na:not_matched' }) }),
    line('Конфликты (несколько записей ЕДЦ)', fmt.int(k.conflict), { link: toHouses({ match: 'conflict' }), warn: k.conflict > 0 }),
    line('Сопоставлено по ФИАС (резерв)', fmt.int(st.rows.filter((x) => x.mm === 'fias').length)),
    line('Ручных соответствий', fmt.int(st.overrides.size)),
    line('Неактуальные по ЕДЦ', fmt.int(k.na.edc_not_actual || 0), { link: toHouses({ cov: 'na:edc_not_actual' }) }),
    line('Тип ЕДЦ не «Жилое»', fmt.int((k.na.edc_not_residential || 0) + (k.na.edc_type_unknown || 0))),
    line('Без подъездов в ЕДЦ', fmt.int(k.na.no_entrances || 0), { link: toHouses({ cov: 'na:no_entrances' }) }),
    line('Нет координат', fmt.int(k.mkd - k.geo), { link: toHouses({ geo: 'none' }) }),
  ] : [h('div', { class: 'muted small' }, 'Нет выгрузок ЕДЦ')]));
  const c = st.snapEdc ? st.snapEdc.report?.control || {} : null;
  grid.append(sec('Выгрузки ЕДЦ', es && c ? [
    line('Адресов ЕДЦ (последние версии)', fmt.int(es.edcHouses)),
    line('actual: true / false / не задано', `${fmt.int(es.actualTrue)} / ${fmt.int(es.actualFalse)} / ${fmt.int(es.actualNull)}`),
    line('Жилые и актуальные (предварительно)', fmt.int(es.residentialActual), { hint: 'не равно реестру МЖИ' }),
    line('Жилые актуальные вне МЖИ', fmt.int(es.residentialActualOutsideMji)),
    line('УНОМ повторяется в ЕДЦ', `${fmt.int(es.edcUnomDupValues)} значений`),
    line('Заявок 2026 на адресах вне МЖИ', fmt.int(es.requestsOutsideMji), { hint: 'без округа' }),
    line('Заявок на конфликтных УНОМ', fmt.int(es.requestsOnConflict), { hint: 'не распределены' }),
    c.unmatchedHouse ? line('Несопоставленные агрегаты «Дом»', `${fmt.int(c.unmatchedHouse.unmatched)} (${fmt.int(c.unmatchedHouse.unmatchedRequests)} заявок)`, { warn: c.unmatchedHouse.unmatched > 0 }) : null,
    c.unmatchedEntrance ? line('Подъездные агрегаты без распределения', `${fmt.int(c.unmatchedEntrance.unmatched)} (UNKNOWN / entrances.id / NUMBER)`) : null,
    c.entrances ? line('Расхождение числа подъездов (дома vs подъезды)', fmt.int(c.entrances.etMismatch), { warn: c.entrances.etMismatch > 0 }) : null,
    line('Расхождение УНОМ адреса и заявок', fmt.int(es.unomMismatch)),
  ] : [h('div', { class: 'muted small' }, 'Нет выгрузок ЕДЦ')]));
  card.append(grid);
  const texts = st.snapEdc && st.snapEdc.controlTexts;
  if (texts && texts.length) card.append(h('details', null, h('summary', null, `Контрольные отчёты S2 (${texts.length})`), texts.map((t) => h('div', null, h('div', { class: 'small', style: { margin: '8px 0 4px' } }, t.name), h('pre', { class: 'raw' }, t.text)))));
  const geoReview = [...st.geo.values()].filter((g) => g.status === 'auto' || g.review).length;
  if (geoReview) card.append(h('div', { class: 'note warn' }, icon('warn'), h('div', null, `${fmt.int(geoReview)} геоточек требуют проверки. `, h('a', { href: '#houses', onclick: (e) => { e.preventDefault(); toHouses({ geo: 'review' })(); } }, 'Открыть список'))));
  return card;
}

function historyCard() {
  const snaps = app.state.snapshots.filter((s) => s.status !== 'staging');
  return h('div', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', null, 'История снимков'), h('span', { class: 'sub' }, 'метаданные и KPI сохраняются; строки старых снимков удаляются для экономии места')),
    snaps.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' },
      h('thead', null, h('tr', null, ['Источник', 'Дата среза', 'Применён', 'Статус', 'Файлы', 'Строк', 'Сопоставлено', '% обслуживается', '% подъездов', 'Заявок 2026'].map((x, i) => h('th', { class: i > 4 ? 'r' : '' }, x)))),
      h('tbody', null, snaps.map((s) => h('tr', null,
        h('td', null, s.source === 'mji' ? 'МЖИ' : `ЕДЦ (${{ raw: '3 CSV', merged: '2 CSV', requests: 'заявки' }[s.mode] || s.mode})`),
        h('td', null, fmt.date(s.dataDate)), h('td', null, fmt.dateTime(s.committedAt)),
        h('td', null, s.status === 'active' ? h('span', { class: 'badge st-full' }, 'активный') : h('span', { class: 'muted' }, 'архив')),
        h('td', { class: 'small' }, (s.files || []).map((f) => f.name).join(', ')),
        h('td', { class: 'r' }, fmt.int(s.source === 'mji' ? s.rows : s.report?.control?.houses?.rows)),
        h('td', { class: 'r' }, s.kpi ? fmt.int(s.kpi.matched) : na()),
        h('td', { class: 'r' }, s.kpi && s.kpi.servedShare !== undefined && s.source === 'edc' ? fmt.pct(s.kpi.servedShare) : na()),
        h('td', { class: 'r' }, s.kpi && s.kpi.entrTotal ? fmt.pct(s.kpi.entrShare) : na()),
        h('td', { class: 'r' }, s.kpi && s.source === 'edc' ? fmt.int(s.kpi.req.total) : na())))))) : h('div', { class: 'muted small' }, 'Снимков пока нет'),
    h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Разница двух накопительных выгрузок не равна точному потоку заявок за месяц, поэтому помесячный ряд не строится.'));
}

function geoToolsCard() {
  const fileIn = h('input', { type: 'file', accept: '.csv,.geojson,.json', class: 'hidden', onchange: (e) => app.importGeoFiles([...e.target.files]) });
  return h('div', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h3', null, 'Геопривязка'), h('span', { class: 'sub' }, 'отдельно от ежемесячных выгрузок')),
    h('div', { class: 'small ink2' }, 'Координаты всех домов реестра из выбранных источников: адресный реестр Москвы по UNOM, OpenStreetMap и Яндекс Геокодер по адресу.'),
    h('div', { class: 'actions-row' },
      h('button', { class: 'btn btn-primary', onclick: () => openGeocodeDialog(app) }, icon('pin', 16), 'Найти координаты всех домов'),
      h('button', { class: 'btn', onclick: () => batchGeocodeDialog() }, icon('search', 16), 'Район через Nominatim'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('upload', 16), 'Импорт CSV/GeoJSON'),
      h('button', { class: 'btn', onclick: exportGeo, disabled: !app.state.geo.size && !app.state.zones.length }, icon('download', 16), 'Экспорт GeoJSON')),
    fileIn,
    h('div', { class: 'small muted' }, 'CSV: колонки unom, lat, lon (или УНОМ, широта, долгота), опционально source, accuracy. GeoJSON: Point или Polygon с properties.UNOM. JSON адресного реестра с data.mos.ru (поля UNOM и geoData). Точки вне Москвы отбрасываются.'));
}

function boundariesCard() {
  const b = app.state.boundaries;
  const fileIn = (kind) => h('input', { type: 'file', accept: '.geojson,.json', class: 'hidden', onchange: (e) => importBoundariesFile(e.target.files[0], kind) });
  const fo = fileIn('okrug'); const fa = fileIn('area');
  const info = (x) => (x ? `${x.geojson.features.length} полигонов, ${x.source}, ${fmt.date(x.fetchedAt)}${x.unmatched && x.unmatched.length ? `, не сопоставлено: ${x.unmatched.length}` : ''}` : 'не загружены');
  return h('div', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h3', null, 'Границы для заливки карты')),
    h('div', { class: 'small ink2' }, `Округа: ${info(b.okrug)}`), h('div', { class: 'small ink2' }, `Районы: ${info(b.area)}`),
    h('div', { class: 'actions-row' },
      h('button', { class: `btn ${b.okrug && b.area ? '' : 'btn-primary'}`, onclick: () => loadBoundaries() }, icon('layers', 16), b.okrug && b.area ? 'Обновить границы' : 'Загрузить границы округов и районов')),
    h('div', { class: 'actions-row' },
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => fo.click() }, 'Округа из GeoJSON'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => fa.click() }, 'Районы из GeoJSON')), fo, fa,
    h('div', { class: 'small muted' }, 'Границы берутся из OpenStreetMap: список через Overpass API (несколько серверов), полигоны через Nominatim, при сбое повтор и запасной путь. Сохраняются в data/local/osm и в браузере. Названия сопоставляются с округами и районами МЖИ; несопоставленные полигоны рисуются пунктиром.'));
}

function backupCard() {
  const fileIn = h('input', { type: 'file', accept: '.json,.ndjson,.gz', class: 'hidden', onchange: (e) => restoreBackup(e.target.files[0]) });
  const est = h('div', { class: 'small muted' });
  storageEstimate().then((e) => { if (e) est.textContent = `Занято в браузере: ${fmt.bytes(e.usage)} из доступных ${fmt.bytes(e.quota)}. Хранилище привязано к профилю браузера и адресу localhost:8000.`; });
  return h('div', { class: 'card stack' }, h('h3', null, 'Резервная копия'),
    h('div', { class: 'actions-row' },
      h('button', { class: 'btn', onclick: () => makeBackup('user') }, icon('download', 16), 'Геоданные и ручные правки'),
      h('button', { class: 'btn', onclick: () => makeBackup('full') }, icon('download', 16), 'Полная копия'),
      h('button', { class: 'btn', onclick: () => fileIn.click() }, icon('upload', 16), 'Восстановить')), fileIn, est,
    h('div', { class: 'actions-row', style: { marginTop: '8px' } },
      h('button', { class: 'btn btn-sm btn-danger', onclick: wipeSources }, icon('trash', 14), 'Удалить выгрузки (геоданные сохранить)'),
      h('button', { class: 'btn btn-sm btn-danger', onclick: wipeAll }, icon('trash', 14), 'Удалить всё')));
}

function settingsCard() {
  const email = h('input', { type: 'email', value: app.settings.nominatimEmail || '', placeholder: 'name@example.ru', style: { width: '100%' } });
  return h('div', { class: 'card stack' }, h('h3', null, 'Настройки'),
    h('div', { class: 'field-inline' }, h('label', null, 'Контактный e-mail для Nominatim (рекомендуется политикой OSM)'), email),
    h('div', { class: 'actions-row' }, h('button', {
      class: 'btn btn-sm', onclick: () => {
        app.settings.nominatimEmail = email.value.trim();
        try { localStorage.setItem('mca-settings', JSON.stringify(app.settings)); } catch (_) { /* приватный режим */ }
        toast('Сохранено', 'ok');
      },
    }, 'Сохранить'), h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { try { localStorage.removeItem('mca-nominatim-consent'); } catch (_) { /* */ } toast('Согласие на Nominatim сброшено'); } }, 'Сбросить согласие на Nominatim')));
}

// ---------------------------------------------------------------- действия: соответствия

app.setOverride = async (u, r, reason) => {
  await put('overrides', { u, r, reason, created_at: new Date().toISOString() });
  await rebuild();
  openCard(app, u);
  toast(r ? 'Соответствие сохранено вручную' : 'Отмечено: соответствия нет', 'ok');
};

app.clearOverride = async (u) => {
  await del('overrides', u);
  await rebuild();
  openCard(app, u);
  toast('Ручной выбор сброшен');
};

async function rebuild() {
  const m = modal({ title: 'Пересчёт сопоставления', body: h('div', { class: 'progress' }, h('i', { style: { width: '60%' } })), actions: [], dismissable: false });
  try { await app.worker.call('rebuild'); await loadState(); render(); } finally { m.close(); }
}

// ---------------------------------------------------------------- действия: геоданные

app.saveGeo = async (rec) => {
  const prev = app.state.geo.get(rec.u);
  await put('geo', { ...(prev || {}), ...rec, updated_at: new Date().toISOString() });
  await reloadGeo();
  if (document.getElementById('drawer').classList.contains('open')) openCard(app, rec.u);
};

app.deleteGeo = async (u) => {
  await del('geo', u);
  await reloadGeo();
  openCard(app, u);
};

app.saveZone = async (z) => {
  await put('zones', z);
  await reloadGeo();
  openCard(app, z.u);
};

app.deleteZone = async (id) => {
  const z = app.state.zones.find((x) => x.id === id);
  await del('zones', id);
  await reloadGeo();
  if (z) openCard(app, z.u);
};

app.showMapView = () => {
  if (app.ui.view !== 'map') go('map');
};

app.showOnMap = (u) => {
  closeCard();
  go('map');
  setTimeout(() => app.map.focus(u), 80);
};

app.pickPoint = async (row) => {
  closeCard();
  go('map');
  const g = app.state.geo.get(row.u);
  if (g) app.map.focus(row.u);
  const p = await app.map.pickPoint(`Кликните по зданию: ${row.address}`);
  if (!p) { openCard(app, row.u); return; }
  await app.saveGeo({ u: row.u, ur: row.ur, lat: p.lat, lon: p.lon, source: 'указано вручную на карте', accuracy: 'точка вручную', status: 'manual', verified_at: new Date().toISOString(), address_at_geocode: row.address, review: '' });
  openCard(app, row.u);
  toast('Геопозиция сохранена', 'ok');
};

app.drawBuilding = async (row) => {
  closeCard();
  go('map');
  if (app.state.geo.has(row.u)) app.map.focus(row.u);
  const gj = await app.map.drawPolygon(`Обведите здание, двойной клик завершает контур: ${row.address}`);
  if (!gj) { openCard(app, row.u); return; }
  const c = centroidOf(gj);
  const prev = app.state.geo.get(row.u);
  await app.saveGeo({
    u: row.u, ur: row.ur, lat: prev ? prev.lat : c.lat, lon: prev ? prev.lon : c.lon, building: gj,
    source: prev ? `${prev.source}; контур нарисован вручную` : 'контур нарисован вручную', accuracy: 'контур вручную', status: 'manual',
    verified_at: new Date().toISOString(), address_at_geocode: row.address, review: '',
  });
  openCard(app, row.u);
};

app.drawZone = async (row, entr) => {
  closeCard();
  go('map');
  if (app.state.geo.has(row.u)) app.map.focus(row.u);
  const label = entr.num ? `подъезд ${entr.lb}` : `подъезд ${entr.e.slice(0, 8)}...`;
  const gj = await app.map.drawPolygon(`Нарисуйте условную зону: ${label}`);
  if (!gj) { openCard(app, row.u); return; }
  const old = app.state.zones.find((z) => z.u === row.u && z.entrance_root_id === entr.e);
  const z = { u: row.u, entrance_root_id: entr.e, entrance_number: entr.num ? entr.lb : '', polygon: gj, source: 'нарисовано вручную', accuracy: 'estimated', created_at: new Date().toISOString() };
  if (old) z.id = old.id;
  await app.saveZone(z);
  toast('Зона подъезда сохранена как условная (estimated)', 'ok');
};

app.importGeoFiles = async (files) => {
  let recs = [];
  const warnings = [];
  for (const f of files) {
    try {
      const res = parseGeoFile(f.name, await f.text());
      recs = recs.concat(res.records);
      warnings.push(...res.warnings);
    } catch (e) { warnings.push(`${f.name}: ${e.message}`); }
  }
  const known = recs.filter((r) => app.state.rowsByU.has(r.u));
  const protectedN = known.filter((r) => { const g = app.state.geo.get(r.u); return g && (g.status === 'manual' || g.status === 'verified'); }).length;
  return new Promise((resolve) => {
    let overwrite = false;
    modal({
      title: 'Импорт геоданных',
      body: h('div', { class: 'stack' },
        h('div', null, `Найдено объектов: ${fmt.int(recs.length)}, из них с UNOM из реестра МЖИ: ${fmt.int(known.length)}.`),
        protectedN ? h('label', { class: 'check-row' }, h('input', { type: 'checkbox', onchange: (e) => { overwrite = e.target.checked; } }),
          h('div', null, `Перезаписать ${fmt.int(protectedN)} проверенных/ручных геопозиций`, h('div', { class: 'small muted' }, 'По умолчанию ручная работа сохраняется.'))) : null,
        warnings.length ? h('details', null, h('summary', null, `Предупреждения (${warnings.length})`), h('pre', { class: 'raw' }, warnings.slice(0, 200).join('\n'))) : null),
      actions: [
        { label: 'Отмена', onClick: () => resolve(false) },
        {
          label: 'Импортировать', kind: 'primary', disabled: !known.length, onClick: async () => {
            const toSave = known.filter((r) => { const g = app.state.geo.get(r.u); return overwrite || !g || !(g.status === 'manual' || g.status === 'verified'); });
            await tx('geo', 'readwrite', (s) => { for (const r of toSave) s.geo.put({ ...(app.state.geo.get(r.u) || {}), ...r }); });
            await reloadGeo();
            toast(`Импортировано геопозиций: ${fmt.int(toSave.length)}`, 'ok');
            resolve(true);
          },
        },
      ],
    });
  });
};

function exportGeo() {
  const fc = exportGeoJson([...app.state.geo.values()], app.state.zones, app.state.rowsByU);
  download(new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }), `coverage_geodata_${new Date().toISOString().slice(0, 10)}.geojson`);
}

async function batchGeocodeDialog() {
  const rows = app.state.rows;
  let okrug = app.f.okrug || 'ЦАО';
  let area = app.f.area || '';
  let limit = 30;
  const body = h('div', { class: 'stack' });
  const draw = () => {
    clear(body);
    const areas = [...new Set(rows.filter((r) => r.okrug === okrug).map((r) => r.area).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    if (!area || !areas.includes(area)) area = areas[0] || '';
    const cand = rows.filter((r) => r.okrug === okrug && r.area === area && !app.state.geo.has(r.u));
    body.append(
      h('p', { class: 'ink2' }, 'Будут найдены координаты домов выбранного района без геопозиции. Если номер дома совпал с OSM, точка сохраняется со статусом «требует проверки». Дома без совпадения пропускаются, их можно привязать вручную.'),
      h('div', { class: 'filter-bar' },
        h('div', { class: 'field-inline' }, h('label', null, 'Округ'), select(OKRUGS.map((o) => [o.code, o.code]), okrug, (val) => { okrug = val; area = ''; draw(); })),
        h('div', { class: 'field-inline' }, h('label', null, 'Район'), select(areas.map((a) => [a, a]), area, (val) => { area = val; draw(); })),
        h('div', { class: 'field-inline' }, h('label', null, 'Не больше'), select([[10, '10'], [20, '20'], [30, '30'], [50, '50']].map(([a, b]) => [String(a), b]), String(limit), (val) => { limit = Number(val); }))),
      h('div', { class: 'small muted' }, `Домов без координат в районе: ${fmt.int(cand.length)}. Отправляется только текст адреса.`));
  };
  draw();
  const dlg = modal({
    title: 'Геопривязка района через OSM Nominatim', body, wide: true,
    actions: [{ label: 'Закрыть' }, {
      label: 'Начать', kind: 'primary', close: false, onClick: async () => {
        if (!(await nominatimConsent())) return;
        const list = rows.filter((r) => r.okrug === okrug && r.area === area && !app.state.geo.has(r.u)).slice(0, limit);
        let stop = false;
        let ok = 0; let skipped = 0; let errors = 0;
        const bar = h('i'); const stage = h('div', { class: 'small ink2' });
        const log = h('pre', { class: 'raw', style: { maxHeight: '220px' } });
        dlg.setBody(h('div', { class: 'stack' }, h('div', { class: 'progress' }, bar), stage, log));
        dlg.setActions([{ label: 'Остановить', close: false, onClick: () => { stop = true; } }]);
        for (let i = 0; i < list.length && !stop; i++) {
          const r = list[i];
          stage.textContent = `${i + 1} из ${list.length}: ${r.address}`;
          bar.style.width = `${((i + 1) / list.length) * 100}%`;
          try {
            const cands = await nominatimSearch(r.address, { email: app.settings.nominatimEmail });
            const exact = cands.filter((c) => c.exact);
            if (exact.length === 1) {
              const c = exact[0];
              const center = c.geometry ? centroidOf(c.geometry) : null;
              await put('geo', { u: r.u, ur: r.ur, lat: center ? center.lat : c.lat, lon: center ? center.lon : c.lon, building: c.geometry || null, source: `OSM Nominatim${c.osm ? ` (${c.osm})` : ''}`, accuracy: accuracyOf(c), status: 'auto', verified_at: '', address_at_geocode: r.address, updated_at: new Date().toISOString() });
              ok++; log.textContent += `найден: ${r.address}\n`;
            } else {
              skipped++; log.textContent += `пропущен: ${r.address} (${exact.length > 1 ? 'несколько совпадений' : cands.length ? 'номер дома не совпал' : 'не найдено'})\n`;
            }
          } catch (e) {
            errors++; log.textContent += `! ${r.address}: ${e.message}\n`;
            if (/429|Failed to fetch|NetworkError/i.test(e.message)) { stop = true; log.textContent += 'Остановлено: нет доступа к Nominatim или превышен лимит.\n'; }
          }
          log.scrollTop = log.scrollHeight;
        }
        stage.textContent = `Готово: найдено ${ok}, пропущено ${skipped}, ошибок ${errors}. Найденные точки отмечены «требует проверки».`;
        dlg.setActions([{ label: 'Закрыть', kind: 'primary' }]);
        await reloadGeo();
        if (ok && app.ui.view === 'map') {
          const any = list.find((r) => app.state.geo.has(r.u));
          if (any) app.map.focus(any.u);
        }
        return false;
      },
    }],
  });
}

/** Границы округов и районов одной кнопкой: serve.py скачивает их в data/local/osm, приложение сохраняет у себя. */
async function loadBoundaries() {
  const rowsEl = h('div', { class: 'run-steps' });
  const bar = h('i', { style: { width: '3%' } });
  const stage = h('div', { class: 'small muted' }, 'Подготовка');
  const m = modal({
    title: 'Границы округов и районов', dismissable: false,
    actions: [{ label: 'Отменить', close: false, onClick: () => postJson('api/boundaries/cancel').catch(() => null) }],
    body: h('div', { class: 'stack', style: { gap: '12px' } },
      h('div', { class: 'ink2' }, 'Загрузка из OpenStreetMap: сначала список границ, затем их полигоны. Обычно занимает меньше минуты.'),
      rowsEl, h('div', { class: 'progress' }, bar), stage),
  });
  const ICON = { ok: 'checkCircle', run: 'refresh', wait: 'help', fail: 'xCircle' };
  const show = (job) => {
    clear(rowsEl);
    let frac = 0;
    for (const [kind, title] of [['okrug', 'Округа'], ['area', 'Районы и поселения']]) {
      const c = job[kind] || {};
      const state = c.state === 'ok' ? 'ok' : job.state === 'error' && c.via ? 'fail' : c.via ? 'run' : 'wait';
      const part = c.state === 'ok' ? 1 : c.listed ? (c.got || 0) / c.listed : 0;
      frac += part / 2;
      const text = state === 'wait' ? 'ожидает'
        : state === 'ok' ? `получено ${fmt.int(c.got)} ${plural(c.got, 'граница', 'границы', 'границ')}`
          : c.listed ? `${c.via}: получено ${fmt.int(c.got || 0)} из ${fmt.int(c.listed)} (${Math.floor(part * 100)}%)` : `${c.via}...`;
      rowsEl.append(h('li', { class: `run-step ${state}` }, h('span', { class: 'ic' }, icon(ICON[state], 16)),
        h('div', null, h('b', null, title), h('div', { class: 'small ink2' }, text))));
    }
    bar.style.width = `${Math.max(3, Math.round(frac * 100))}%`;
    stage.textContent = job.stage || '';
  };
  try {
    const areas = [...new Set(app.state.rows.map((r) => r.area).filter(Boolean))];
    await postJson('api/boundaries/download', { areas, email: app.settings.nominatimEmail || '' });
    const st = await waitJob('api/boundaries', (s) => show(s.job || {}));
    if (st.job.state !== 'done') throw new Error(st.job.message || 'границы не получены');
    const n = await applyBoundaryFiles(st);
    toast(`Границы загружены: округов ${n.okrug}, районов ${n.area}${n.unmatched ? `; без сопоставления с МЖИ: ${n.unmatched}` : ''}`, 'ok', 7000);
  } catch (e) {
    toast(`Не удалось загрузить границы: ${e.message}. Повторите позже или загрузите GeoJSON вручную.`, 'error', 9000);
  } finally { m.close(); }
}

/** Прочитать сохранённые файлы границ (после загрузки или если данные браузера очищены). */
async function applyBoundaryFiles(st) {
  const n = { okrug: 0, area: 0, unmatched: 0 };
  for (const kind of ['okrug', 'area']) {
    const f = st[kind];
    if (!f || !f.exists) continue;
    const fc = await getJson(`${f.url}?v=${f.mtime || Date.now()}`);
    const r = await saveBoundaries(fc, kind, 'OpenStreetMap (© участники OpenStreetMap, ODbL)', { quiet: true });
    n[kind] = fc.features.length;
    n.unmatched += r.unmatched.length;
  }
  render();
  return n;
}

async function importBoundariesFile(file, kind) {
  if (!file) return;
  try {
    const fc = JSON.parse(await file.text());
    if (fc.type !== 'FeatureCollection') throw new Error('Ожидается GeoJSON FeatureCollection');
    fc.features = fc.features.filter((f) => f.geometry && /Polygon/.test(f.geometry.type));
    await saveBoundaries(fc, kind, `файл ${file.name}`);
  } catch (e) { toast(`Ошибка GeoJSON: ${e.message}`, 'error', 8000); }
}

async function saveBoundaries(fc, kind, source, { quiet = false } = {}) {
  const areas = [...new Set(app.state.rows.map((r) => r.area).filter(Boolean))];
  const { unmatched } = annotateBoundaries(fc, kind, areas);
  if (!fc.features.length) throw new Error('В ответе нет полигонов');
  await setMeta(kind === 'okrug' ? 'boundaries_okrug' : 'boundaries_area', { geojson: fc, source, fetchedAt: new Date().toISOString(), unmatched });
  app.state.boundaries = { okrug: await getMeta('boundaries_okrug'), area: await getMeta('boundaries_area') };
  if (kind === 'area') app.map.layerOn.area = true;
  if (!quiet) {
    toast(`Загружено полигонов: ${fc.features.length}${unmatched.length ? `, без сопоставления: ${unmatched.length}` : ''}`, unmatched.length ? 'info' : 'ok', 7000);
    render();
  }
  return { unmatched };
}

// ---------------------------------------------------------------- резервные копии

async function makeBackup(kind) {
  const m = modal({ title: 'Резервная копия', body: h('div', { class: 'progress' }, h('i', { style: { width: '30%' } })), actions: [], dismissable: false });
  try {
    const res = (await app.worker.call('backup', { kind }, { onProgress: (p) => { const i = m.el.querySelector('.progress > i'); if (i) i.style.width = `${p.pct}%`; } })).result;
    download(res.blob, res.name);
    toast(`Сохранено: ${res.name} (${fmt.bytes(res.blob.size)})`, 'ok');
  } catch (e) { toast(e.message, 'error'); } finally { m.close(); }
}

async function restoreBackup(file) {
  if (!file) return;
  if (!(await confirmDialog('Восстановить из копии?', 'Полная копия заменит все данные приложения. Копия «геоданные и ручные правки» добавит/обновит точки, контуры, зоны и соответствия.', 'Восстановить'))) return;
  const m = modal({ title: 'Восстановление', body: h('div', { class: 'progress' }, h('i', { style: { width: '20%' } })), actions: [], dismissable: false });
  try {
    const res = (await app.worker.call('restore', { file }, { onProgress: (p) => { const i = m.el.querySelector('.progress > i'); if (i) i.style.width = `${p.pct}%`; } })).result;
    await app.worker.call('init');
    await app.reload();
    toast(`Восстановлено записей: ${fmt.int(res.restored)}`, 'ok');
  } catch (e) { toast(e.message, 'error', 8000); } finally { m.close(); }
}

async function wipeSources() {
  if (!(await confirmDialog('Удалить выгрузки?', 'Будут удалены снимки МЖИ и ЕДЦ и история. Геоточки, контуры, зоны подъездов и ручные соответствия останутся.', 'Удалить', 'danger'))) return;
  await app.worker.call('wipeSources');
  await app.reload();
  toast('Выгрузки удалены');
}

async function wipeAll() {
  if (!(await confirmDialog('Удалить все данные?', 'Будут удалены все выгрузки, геоданные, зоны подъездов и ручные соответствия в этом браузере. Сначала сохраните резервную копию.', 'Удалить всё', 'danger'))) return;
  await tx(Object.keys(STORES), 'readwrite', (s) => {
    for (const st of Object.values(s)) st.clear();
  });
  await app.worker.call('init');
  await app.reload();
  toast('Все данные удалены');
}

boot();
