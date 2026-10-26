// Сквозной тест в headless Chromium (Playwright): импорт МЖИ и ЕДЦ через интерфейс, сверка KPI с расчётом в node,
// повторный импорт идентичного снимка, сохранность геоданных, режим объединённых CSV, обновление только заявок,
// скачивание офлайн-карты кнопкой, резервная копия. Данные СИНТЕТИЧЕСКИЕ (tests/fixtures/synthetic),
// реальный реестр и интернет не нужны: карта качается с локального сервера с поддержкой Range.
//
// Запуск: node tests/e2e/run.mjs   (нужны Python 3 и Playwright с Chromium)
// Скриншоты: tests/e2e/output/
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, mkdtempSync, rmSync, rmdirSync, existsSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { ROOT, FIX, readCsv, mergeRaw } from '../helpers.mjs';
import { parseMji } from '../../core/mji.js';
import { Joiner, kpiOf } from '../../analytics.js';
import { parseAddress, streetBag } from '../../core/addrmatch.js';
import { OKRUGS } from '../../core/okrugs.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright не найден: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const OUT = join(ROOT, 'tests', 'e2e', 'output');
// «Папка с выгрузками» для теста: копии синтетических фикстур под реальными именами выгрузок DBeaver
const SRC_DIR = mkdtempSync(join(tmpdir(), 'mca-e2e-'));
const SOURCES_CONFIG = join(SRC_DIR, 'sources.local.json');
const USER_NAMES = {
  mji: '19.10.26_МКД_SELECT_t_content_code_AS_Код_t_content_District_AS_Округ_t_cont_202610191348.csv',
  houses: 'Запрос № 2. Выгрузка № 1 — ВСЕ адреса, одна строка на дом.csv',
  entrances: 'Запрос № 3. Выгрузка № 2 — ВСЕ адреса и подъезды, одна строка на подъезд.csv',
  requests: 'Запрос № 4. Выгрузка № 3 — заявки 2026 по дому И по подъезду в ОДНОМ файле.csv',
};
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('•', ...a);

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const PY_ARGS = process.platform === 'win32' && !process.env.PYTHON ? ['-3'] : [];

// Офлайн-карта: синтетическая «сборка мира» в формате PMTiles и сервер с поддержкой Range вместо build.protomaps.com
const BASEMAP = join(ROOT, 'data', 'local', 'moscow.pmtiles');
const BASEMAP_TEST = !existsSync(BASEMAP); // карту пользователя тест не трогает
let basemapSamples = [];
function rangeServer(file) {
  const buf = readFileSync(file);
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!m) { resp.writeHead(200, { 'Content-Length': buf.length }); resp.end(buf); return; }
      const a = Number(m[1]); const b = Math.min(Number(m[2]), buf.length - 1);
      resp.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Content-Length': b - a + 1 });
      resp.end(buf.subarray(a, b + 1));
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

// Адреса OSM: локальный «Overpass» с адресами синтетических домов в записи, как в OSM
// (другой порядок слов, «Ё», заглавные буквы в номере). Часть домов пропущена, один адрес неоднозначен.
const ADDRESSES = join(ROOT, 'data', 'local', 'osm', 'moscow_addresses.json');
const GEOCODED = join(ROOT, 'data', 'local', 'geocoded_houses.csv');
const BOUNDS = ['okrug', 'area'].map((k) => join(ROOT, 'data', 'local', 'osm', `boundaries_${k}.geojson`));
const BOUNDS_TEST = BOUNDS.every((f) => !existsSync(f));
const GEOCODE_TEST = !existsSync(ADDRESSES) && !existsSync(GEOCODED) && !existsSync(join(ROOT, 'data', 'local', 'yandex_geocoder_cache.json'));
function overpassElements() {
  const m = readCsv(join(FIX, 'mji_synthetic.csv'));
  const iA = m.header.indexOf('Наименование/адрес');
  const iU = m.header.indexOf('UNOM');
  const els = [];
  const plan = new Map();
  m.rows.forEach((r, i) => {
    const p = parseAddress(r[iA]);
    if (i % 7 === 3) { plan.set(r[iU], 'notfound'); return; }
    const street = p.street.split(' ').reverse().join(' ').replace(/е/g, (ch, k) => (k === 1 ? 'ё' : ch));
    const hn = p.keys[0].toUpperCase().replace('К', 'к').replace('С', 'с');
    const lat = 55.55 + (i % 40) * 0.008;
    const lon = 37.35 + Math.floor(i / 40) * 0.05;
    els.push({ type: 'way', id: 1000 + i, center: { lat, lon }, tags: { building: 'yes', 'addr:street': street, 'addr:housenumber': hn } });
    if (i === 11) {
      els.push({ type: 'way', id: 9000, center: { lat: lat + 0.2, lon }, tags: { building: 'yes', 'addr:street': street, 'addr:housenumber': hn } });
      plan.set(r[iU], 'ambiguous');
    } else plan.set(r[iU], streetBag(p.street) && p.keys.length ? 'ok' : 'unparsed');
  });
  return { els, plan };
}
// Имитация HTTP Геокодера Яндекса: дом по любому адресу, кроме одного (для него только улица)
const GEOCODER_CONFIG = join(SRC_DIR, 'geocoder.local.json');
const YANDEX_CACHE = join(ROOT, 'data', 'local', 'yandex_geocoder_cache.json');
function yandexServer(streetOnly) {
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      const q = new URL(req.url, 'http://x').searchParams.get('geocode') || '';
      let n = 0;
      for (const ch of q) n = (n * 31 + ch.charCodeAt(0)) % 100000;
      const kind = streetOnly.some((a) => q.endsWith(a)) ? 'street' : 'house';
      const member = { GeoObject: { metaDataProperty: { GeocoderMetaData: { precision: kind === 'house' ? 'exact' : 'street', kind, text: q } }, Point: { pos: `${(37.4 + (n % 400) / 1000).toFixed(5)} ${(55.6 + (n % 300) / 1000).toFixed(5)}` } } };
      resp.writeHead(200, { 'Content-Type': 'application/json' });
      resp.end(JSON.stringify({ response: { GeoObjectCollection: { featureMember: [member] } } }));
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}
// Границы: Overpass отдаёт список (12 округов и районы синтетического реестра), Nominatim /lookup отдаёт полигоны
function boundaryRelations(areas) {
  const okr = OKRUGS.map((o, i) => ({ type: 'relation', id: 500 + i, tags: { name: o.full, admin_level: '5', boundary: 'administrative' } }));
  const ar = areas.map((a, i) => ({ type: 'relation', id: 800 + i, tags: { name: `район ${a}`, admin_level: '8', boundary: 'administrative' } }));
  return { 5: okr, 8: ar };
}
function osmServer(elements, relations) {
  const body = JSON.stringify({ version: 0.6, elements });
  return new Promise((res) => {
    const srv = http.createServer((req, resp) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        resp.writeHead(200, { 'Content-Type': 'application/json' });
        const u = new URL(req.url, 'http://x');
        if (u.pathname.endsWith('/lookup')) { // Nominatim: квадраты по сетке над Москвой
          const ids = u.searchParams.get('osm_ids').split(',').map((x) => Number(x.slice(1)));
          resp.end(JSON.stringify({ type: 'FeatureCollection', features: ids.map((id) => {
            const x = 37.3 + (id % 10) * 0.07; const y = 55.55 + (Math.floor(id / 10) % 6) * 0.07;
            return { type: 'Feature', properties: { osm_type: 'relation', osm_id: id }, geometry: { type: 'Polygon', coordinates: [[[x, y], [x + 0.06, y], [x + 0.06, y + 0.06], [x, y + 0.06], [x, y]]] } };
          }) }));
          return;
        }
        const q = new URLSearchParams(data).get('data') || '';
        if (q.includes('boundary')) resp.end(JSON.stringify({ elements: relations[q.includes('"admin_level"="5"') ? 5 : 8] }));
        else resp.end(body);
      });
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function startServer(port, env = {}) {
  const args = [...PY_ARGS, 'serve.py', '--port', String(port), '--no-browser'];
  const proc = spawn(PY, args, { cwd: ROOT, stdio: 'ignore', env: { ...process.env, MCA_SOURCES_CONFIG: SOURCES_CONFIG, ...env } });
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/index.html`); if (r.ok) return proc; } catch (_) { /* ждём */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error('Сервер не запустился');
}

/** Ожидаемые KPI, рассчитанные в node тем же ядром, но без браузера и IndexedDB. */
function expectedKpi() {
  const m = readCsv(join(FIX, 'mji_synthetic.csv'));
  const { houses } = parseMji(m.header, m.rows);
  const j = new Joiner(houses);
  for (const e of mergeRaw().houses) j.consider(e);
  const { rows } = j.finish();
  return { kpi: kpiOf(rows), rows };
}

const pick = (k) => ({ mkd: k.mkd, matched: k.matched, conflict: k.conflict, evaluated: k.evaluated, full: k.full, partial: k.partial, none: k.none, entrTotal: k.entrTotal, entrLinked: k.entrLinked, req: k.req.total, open: k.req.open, critical: k.req.critical });

async function uiKpi(page) {
  return page.evaluate(async () => {
    const m = await import('/analytics.js');
    const k = m.kpiOf(window.__app.state.rows);
    return { mkd: k.mkd, matched: k.matched, conflict: k.conflict, evaluated: k.evaluated, full: k.full, partial: k.partial, none: k.none, entrTotal: k.entrTotal, entrLinked: k.entrLinked, req: k.req.total, open: k.req.open, critical: k.req.critical };
  });
}

// Playwright молча отбрасывает пути с кириллицей - передаём содержимое файлов с исходными именами.
const payload = (paths) => paths.map((p) => ({ name: p.split(/[\\/]/).pop(), mimeType: 'text/csv', buffer: readFileSync(p) }));

async function importViaWizard(page, files, opts = {}) {
  await page.click('.topbar .btn-primary');
  await page.waitForSelector('.modal input[type=file]', { state: 'attached' });
  await page.setInputFiles('.modal input[type=file]', payload(files));
  await page.waitForFunction((n) => document.querySelectorAll('.modal .file-item').length === n, files.length, { timeout: 30000 });
  return runWizard(page, opts);
}

async function runWizard(page, { expectJobs = 1, shot } = {}) {
  await page.click('text=Проверить и показать изменения');
  const previews = [];
  for (let i = 0; i < expectJobs; i++) {
    await page.waitForSelector('.modal button.btn-primary:has-text("Применить снимок"):not([disabled])', { timeout: 180000 });
    previews.push(await page.evaluate(() => window.__lastPreview));
    if (shot && i === 0) await page.screenshot({ path: join(OUT, shot) });
    await page.click('.modal button.btn-primary:has-text("Применить снимок")');
    await page.waitForFunction((prev) => !window.__lastPreview || window.__lastPreview !== prev || !document.querySelector('.modal'), previews[i], { timeout: 180000 }).catch(() => {});
    if (i < expectJobs - 1) await page.waitForFunction((prev) => window.__lastPreview && window.__lastPreview.snapId !== prev, previews[i].snapId, { timeout: 180000 });
  }
  await page.waitForFunction(() => !document.querySelector('.modal-back'), null, { timeout: 180000 });
  await page.waitForTimeout(300);
  return previews;
}

function prepareSourceFolder() {
  copyFileSync(join(FIX, 'mji_synthetic.csv'), join(SRC_DIR, USER_NAMES.mji));
  copyFileSync(join(FIX, '01_дома.csv'), join(SRC_DIR, USER_NAMES.houses));
  copyFileSync(join(FIX, '02_подъезды.csv'), join(SRC_DIR, USER_NAMES.entrances));
  copyFileSync(join(FIX, '03_заявки_2026.csv'), join(SRC_DIR, USER_NAMES.requests));
  writeFileSync(join(SRC_DIR, 'Запрос № 1. Какие типы домов есть в ЕДЦ (контроль, без экспорта).csv'), '"Тип дома в ЕДЦ (house_type)","Пример адреса"\nЖилое,x\n');
  // Имя заявок намеренно с ошибкой - тест исправит его в окне
  writeFileSync(SOURCES_CONFIG, JSON.stringify({ folder: SRC_DIR, files: { ...USER_NAMES, requests: 'опечатка.csv', geo: '' } }));
}

(async () => {
  prepareSourceFolder();
  const planet = join(SRC_DIR, 'planet.pmtiles');
  basemapSamples = JSON.parse(execFileSync(PY, [...PY_ARGS, '-c', 'import sys, test_tools as t; t.write_e2e_source(sys.argv[1])', planet], { cwd: join(ROOT, 'tests') }).toString());
  const tileServer = await rangeServer(planet);
  const osm = overpassElements();
  const synthAreas = [...new Set(expectedKpi().rows.map((r) => r.area).filter(Boolean))];
  const overpass = await osmServer(osm.els, boundaryRelations(synthAreas));
  const m0 = readCsv(join(FIX, 'mji_synthetic.csv'));
  const ambAddr = m0.rows.filter((r) => osm.plan.get(r[m0.header.indexOf('UNOM')]) === 'ambiguous').map((r) => r[m0.header.indexOf('Наименование/адрес')]);
  const yandex = await yandexServer(ambAddr);
  const port = await freePort();
  const server = await startServer(port, {
    MCA_BASEMAP_SOURCE: `http://127.0.0.1:${tileServer.address().port}/planet.pmtiles`,
    MCA_OVERPASS_URL: `http://127.0.0.1:${overpass.address().port}/api/interpreter`,
    MCA_NOMINATIM_URL: `http://127.0.0.1:${overpass.address().port}/nominatim`,
    MCA_YANDEX_URL: `http://127.0.0.1:${yandex.address().port}/1.x/`,
    MCA_GEOCODER_CONFIG: GEOCODER_CONFIG,
  });
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|tile/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Загрузить из папки выгрузок');
    await page.screenshot({ path: join(OUT, '01_onboarding.png') });

    const exp = expectedKpi();
    log('ожидаемые KPI (node):', JSON.stringify(pick(exp.kpi)));

    // 1) МЖИ + три сырых CSV ЕДЦ из «папки с выгрузками»: имена как у DBeaver, одно имя исправляется в окне
    const raw = ['01_дома.csv', '02_подъезды.csv', '03_заявки_2026.csv'].map((f) => join(FIX, f));
    await page.click('text=Загрузить из папки выгрузок');
    await page.waitForSelector('.modal input[aria-label="SQL № 4 (заявки 2026)"]');
    assert.equal(await page.locator('.modal .badge.st-none').count(), 1, 'неверное имя файла заявок помечено «не найден»');
    await page.fill('.modal input[aria-label="SQL № 4 (заявки 2026)"]', USER_NAMES.requests);
    await page.click('.modal button:has-text("Сохранить и проверить")');
    await page.waitForFunction(() => document.querySelectorAll('.modal .badge.st-full').length === 5); // папка + 4 файла
    await page.screenshot({ path: join(OUT, '01b_sources.png') });
    assert.equal(JSON.parse(readFileSync(SOURCES_CONFIG, 'utf8')).files.requests, USER_NAMES.requests, 'имя сохранено в config');
    await page.click('.modal button:has-text("Загрузить отмеченные")');
    await page.waitForFunction(() => document.querySelectorAll('.modal .file-item').length === 4, null, { timeout: 30000 });
    assert.deepEqual((await page.locator('.modal .file-item .fn').allTextContents()).sort(), Object.values(USER_NAMES).sort());
    const pv = await runWizard(page, { expectJobs: 2, shot: '02_preview.png' });
    assert.equal(pv[0].source, 'mji');
    assert.equal(pv[1].source, 'edc');
    assert.equal(pv[1].report.control.houses.rows, 400);
    assert.equal(pv[1].report.control.entrances.rows, 1025);
    let k = await uiKpi(page);
    log('KPI в интерфейсе:', JSON.stringify(k));
    assert.deepEqual(k, pick(exp.kpi), 'KPI интерфейса = расчёт в node');

    // Нет двойного счёта: заявки = сумма домовых агрегатов сопоставленных домов
    const houseLevel = exp.rows.filter((r) => r.m === 'matched').reduce((s, r) => s + r.q[0], 0);
    assert.equal(k.req, houseLevel, 'заявки = только уровень «Дом»');
    const entrLevel = mergeRaw().entrances.reduce((s, e) => s + e.q[0], 0);
    assert.notEqual(k.req, houseLevel + entrLevel);
    log('двойного счёта нет: заявок', k.req);

    // Повторное открытие: все четыре файла отмечены как «уже загружен» и не выбраны
    await page.click('.nav-item[data-view="import"]');
    await page.click('#view-import button:has-text("Папка и имена файлов")');
    await page.waitForSelector('.modal input[aria-label="SQL № 4 (заявки 2026)"]');
    assert.equal(await page.locator('.modal :text("уже загружен в приложение")').count(), 4);
    assert.equal(await page.locator('.modal input[type=checkbox]:checked').count(), 0);
    await page.click('.modal button:has-text("Закрыть")');
    log('загрузка из папки: имена вводятся в окне, загруженные файлы распознаются при повторном открытии');

    // 2) Повторный импорт идентичного снимка → 0 изменений, KPI те же
    const pv2 = await importViaWizard(page, raw);
    assert.deepEqual([pv2[0].diff.added, pv2[0].diff.changed, pv2[0].diff.gone], [0, 0, 0], 'идентичный снимок без изменений');
    assert.deepEqual(await uiKpi(page), k);
    log('повторный импорт идентичного снимка: 0 новых / 0 изменённых / 0 исчезнувших');

    // 3) Геоданные (тестовые координаты) переживают обновление ЕДЦ
    const matched = exp.rows.filter((r) => r.m === 'matched').slice(0, 6);
    const geoCsv = 'unom,lat,lon,source\n' + matched.map((r, i) => `${r.ur},${(55.75 + i * 0.004).toFixed(6)},${(37.6 + i * 0.006).toFixed(6)},e2e-тест`).join('\n') + '\n';
    const geoPath = join(OUT, 'geo_test.csv');
    writeFileSync(geoPath, geoCsv);
    await page.click('.nav-item[data-view="import"]');
    await page.setInputFiles('#view-import input[type=file][accept=".csv,.geojson,.json"]', payload([geoPath]));
    await page.click('.modal button.btn-primary:has-text("Импортировать")');
    await page.waitForFunction(() => window.__app.state.geo.size === 6);
    const merged = ['expected_houses_merged.csv', 'expected_entrances_merged.csv'].map((f) => join(FIX, f));
    const pv3 = await importViaWizard(page, merged);
    assert.equal(pv3[0].mode, 'merged');
    assert.equal(await page.evaluate(() => window.__app.state.geo.size), 6, 'геоточки сохранились после импорта');
    assert.deepEqual(await uiKpi(page), k, 'объединённые CSV (Python S2) дают те же KPI, что сырые CSV');
    log('геоданные сохранены; режим объединённых CSV = режим сырых CSV');

    // 4) Только заявки поверх снимка
    const pv4 = await importViaWizard(page, [join(FIX, '03_заявки_2026.csv')]);
    assert.equal(pv4[0].mode, 'requests');
    assert.deepEqual(await uiKpi(page), k, 'обновление только заявок теми же данными не меняет KPI');

    // 4б) Ошибка в выгрузке (дубликат агрегата заявок) останавливает импорт и ничего не меняет
    const reqText = readFileSync(join(FIX, '03_заявки_2026.csv'), 'utf8');
    const lastLine = reqText.trimEnd().split('\n').pop();
    const badPath = join(OUT, '03_заявки_2026_дубль.csv');
    writeFileSync(badPath, reqText.trimEnd() + '\n' + lastLine + '\n');
    await page.click('.topbar .btn-primary');
    await page.waitForSelector('.modal input[type=file]', { state: 'attached' });
    await page.setInputFiles('.modal input[type=file]', payload([badPath]));
    await page.waitForFunction(() => document.querySelectorAll('.modal .file-item').length === 1);
    await page.click('text=Проверить и показать изменения');
    await page.waitForSelector('.modal :text("Импорт остановлен")', { timeout: 60000 });
    assert.match(await page.evaluate(() => document.querySelector('.modal').innerText), /повторяет ключ более ранней строки/);
    await page.screenshot({ path: join(OUT, '02b_import_error.png') });
    await page.click('.modal button:has-text("Закрыть")');
    await page.waitForFunction(() => !document.querySelector('.modal-back'));
    assert.deepEqual(await uiKpi(page), k, 'после ошибки импорта данные не изменились');
    log('ошибочная выгрузка остановлена до применения, данные не изменены');

    // 5) Скриншоты видов
    await page.click('.nav-item[data-view="map"]');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, '03_map.png') });
    await page.evaluate(() => window.__app.map.focus(window.__app.state.geo.keys().next().value));
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, '04_map_zoom.png') });
    await page.click('.nav-item[data-view="heat"]');
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUT, '05_heat.png') });
    await page.click('.nav-item[data-view="rating"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, '06_rating.png'), fullPage: true });
    await page.click('.nav-item[data-view="houses"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, '07_houses.png') });
    await page.click('#view-houses tbody tr.clickable');
    await page.waitForSelector('.drawer.open .entr, .drawer.open .note', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, '08_card.png') });
    await page.click('.drawer.open .drawer-head .icon-btn');
    await page.click('.nav-item[data-view="import"]');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(OUT, '09_import_quality.png'), fullPage: true });

    // 5б) Офлайн-карта: одна кнопка, файл сохраняется в data/local, браузерный читатель PMTiles видит тайлы
    if (BASEMAP_TEST) {
      await page.click('.nav-item[data-view="map"]');
      await page.click('#view-map button:has-text("Скачать карту Москвы")');
      await page.waitForFunction(() => window.__app.map.activeBasemap === 'pmtiles', null, { timeout: 60000 });
      const got = await page.evaluate(async (samples) => {
        const src = new window.protomapsL.PmtilesSource(`data/local/moscow.pmtiles?v=${Date.now()}`, false);
        const out = [];
        for (const [z, x, y] of samples) {
          const t = await src.p.getZxy(z, x, y);
          out.push(t ? btoa(String.fromCharCode(...new Uint8Array(t.data))) : null);
        }
        return out;
      }, basemapSamples);
      assert.deepEqual(got, basemapSamples.map((s) => s[3]), 'тайлы вырезки читаются protomaps-leaflet');
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(OUT, '03b_map_offline.png') });
      await page.click('.nav-item[data-view="import"]');
      await page.waitForSelector('#view-import :text("Карта сохранена на компьютере")');
      assert.equal(await page.locator('#view-import button:has-text("Обновить карту")').count(), 1);
      assert.match(await page.evaluate(() => document.querySelector('#nav-status').innerText), /Офлайн-карта/);
      log(`офлайн-карта скачана кнопкой и читается в браузере (${basemapSamples.length} контрольных тайлов)`);
    } else {
      log('офлайн-карта: data/local/moscow.pmtiles уже есть, проверка скачивания пропущена');
    }

    // 6) Полная резервная копия → восстановление
    const restored = await page.evaluate(async () => {
      const a = window.__app;
      const b = (await a.worker.call('backup', { kind: 'full' })).result;
      const file = new File([b.blob], b.name);
      const r = (await a.worker.call('restore', { file })).result;
      await a.worker.call('init');
      await a.reload();
      return { restored: r.restored, size: b.blob.size, geo: a.state.geo.size, rows: a.state.rows.length };
    });
    assert.equal(restored.geo, 6);
    assert.equal(restored.rows, k.mkd);
    assert.deepEqual(await uiKpi(page), k, 'KPI после восстановления из полной копии');
    log(`резервная копия: ${restored.restored} записей, ${restored.size} байт - восстановлено без потерь`);

    // 7) Координаты всех домов одной кнопкой: справочник OSM скачивается сам, остаток ищется через Яндекс
    if (GEOCODE_TEST) {
      const kept = new Set(matched.map((r) => r.ur));
      const expectOsm = exp.rows.filter((r) => osm.plan.get(r.ur) === 'ok' && !kept.has(r.ur)).length;
      const ambiguousU = [...osm.plan].filter(([, v]) => v === 'ambiguous').map(([u]) => u);
      await page.click('.nav-item[data-view="import"]');
      await page.click('#view-import button:has-text("Найти координаты всех домов")');
      await page.waitForSelector('.modal :text("Яндекс Геокодер: указать ключ API")');
      await page.click('.modal summary');
      await page.fill('.modal input[aria-label="Ключ API Яндекс Геокодера"]', 'test-key-1234');
      await page.click('.modal button:has-text("Сохранить")');
      await page.waitForSelector('.modal :text("ключ …1234")');
      await page.click('.modal button.btn-block:has-text("Найти координаты всех домов")');
      await page.waitForSelector('.modal :text("С координатами")', { timeout: 90000 });
      await page.screenshot({ path: join(OUT, '10_geocode.png') });
      const geo = await page.evaluate(() => {
        const by = {};
        for (const g of window.__app.state.geo.values()) by[g.status] = (by[g.status] || 0) + 1;
        return by;
      });
      assert.equal(geo.imported, 6, 'точки из файла не перезаписаны');
      assert.equal(geo.osm, expectOsm, 'по адресам OSM найдены все однозначные адреса');
      // Яндекс нашёл остальные, кроме адреса, для которого вернул только улицу
      assert.equal(geo.yandex, k.mkd - 6 - expectOsm - ambiguousU.length, 'остальные найдены через Яндекс');
      const total = 6 + geo.osm + geo.yandex;
      const csvLines = readFileSync(GEOCODED, 'utf8').trim().split(/\r?\n/);
      assert.equal(csvLines.length, total + 1, 'копия координат сохранена в data/local/geocoded_houses.csv');
      assert.ok(!JSON.stringify(await (await fetch(`http://127.0.0.1:${port}/api/yandex`)).json()).includes('test-key'), 'ключ не отдаётся наружу');
      await page.click('.modal button:has-text("Закрыть")');
      await page.click('.nav-item[data-view="map"]');
      await page.evaluate(() => { window.__app.map.map.setView([55.75, 37.6], 10); });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(OUT, '11_map_geocoded.png') });
      log(`координаты одной кнопкой: OSM ${geo.osm}, Яндекс ${geo.yandex}, вручную 6; всего ${total} из ${k.mkd}`);
    } else {
      log('координаты по адресам: справочник или geocoded_houses.csv уже есть, проверка пропущена');
    }

    // 8) Границы округов и районов одной кнопкой (список из Overpass, полигоны из Nominatim), сохраняются на диск
    if (BOUNDS_TEST) {
      await page.click('.nav-item[data-view="import"]');
      await page.click('#view-import button:has-text("Загрузить границы округов и районов")');
      await page.waitForSelector('.toast:has-text("Границы загружены")', { timeout: 60000 });
      const b = await page.evaluate(() => {
        const s = window.__app.state.boundaries;
        return { okrug: s.okrug.geojson.features.length, area: s.area.geojson.features.length, um: s.okrug.unmatched.length + s.area.unmatched.length };
      });
      assert.deepEqual(b, { okrug: 12, area: synthAreas.length, um: 0 }, 'все полигоны сопоставлены с округами и районами МЖИ');
      assert.ok(BOUNDS.every((f) => existsSync(f)), 'границы сохранены в data/local/osm');
      await page.click('.nav-item[data-view="map"]');
      await page.evaluate(() => { window.__app.map.map.setView([55.75, 37.6], 9); });
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(OUT, '12_map_boundaries.png') });
      log(`границы: округов ${b.okrug}, районов ${b.area}, все сопоставлены с МЖИ`);
    } else {
      log('границы: файлы в data/local/osm уже есть, проверка пропущена');
    }

    assert.deepEqual(errors, [], `ошибки в консоли: ${errors.join(' | ')}`);
    log('E2E: все проверки пройдены. Скриншоты:', OUT);
  } catch (e) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0]) {
      await pages[0].screenshot({ path: join(OUT, 'failure.png') }).catch(() => {});
      console.error('Модальное окно:', await pages[0].evaluate(() => document.querySelector('.modal')?.innerText?.slice(0, 1500)).catch(() => ''));
    }
    console.error('Ошибки страницы:', errors);
    throw e;
  } finally {
    await browser.close();
    server.kill();
    tileServer.close();
    overpass.close();
    yandex.close();
    if (BASEMAP_TEST) for (const f of [BASEMAP, `${BASEMAP}.json`]) rmSync(f, { force: true });
    if (GEOCODE_TEST) for (const f of [ADDRESSES, GEOCODED, YANDEX_CACHE]) rmSync(f, { force: true });
    if (BOUNDS_TEST) for (const f of BOUNDS) rmSync(f, { force: true });
    try { rmdirSync(join(ROOT, 'data', 'local', 'osm')); } catch (_) { /* папка не пуста или её нет */ }
    rmSync(SRC_DIR, { recursive: true, force: true });
  }
})().catch((e) => { console.error('E2E ОШИБКА:', e); process.exit(1); });

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
