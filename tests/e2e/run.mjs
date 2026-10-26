// Сквозной тест в headless Chromium (Playwright): импорт МЖИ и ЕДЦ через интерфейс, сверка KPI с расчётом в node,
// повторный импорт идентичного снимка, сохранность геоданных, режим объединённых CSV, обновление только заявок,
// резервная копия. Данные — СИНТЕТИЧЕСКИЕ (tests/fixtures/synthetic), реальный реестр не нужен.
//
// Запуск: node tests/e2e/run.mjs   (нужны Python 3 и Playwright с Chromium)
// Скриншоты: tests/e2e/output/
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { ROOT, FIX, readCsv, mergeRaw } from '../helpers.mjs';
import { parseMji } from '../../core/mji.js';
import { Joiner, kpiOf } from '../../analytics.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.error('Playwright не найден: npm i -D playwright && npx playwright install chromium'); process.exit(2); }

const OUT = join(ROOT, 'tests', 'e2e', 'output');
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log('•', ...a);

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

async function startServer(port) {
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
  const args = process.platform === 'win32' && !process.env.PYTHON ? ['-3', 'serve.py', '--port', String(port), '--no-browser'] : ['serve.py', '--port', String(port), '--no-browser'];
  const proc = spawn(py, args, { cwd: ROOT, stdio: 'ignore' });
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

// Playwright молча отбрасывает пути с кириллицей — передаём содержимое файлов с исходными именами.
const payload = (paths) => paths.map((p) => ({ name: p.split(/[\\/]/).pop(), mimeType: 'text/csv', buffer: readFileSync(p) }));

async function importViaWizard(page, files, { expectJobs = 1, shot } = {}) {
  await page.click('.topbar .btn-primary');
  await page.waitForSelector('.modal input[type=file]', { state: 'attached' });
  await page.setInputFiles('.modal input[type=file]', payload(files));
  await page.waitForFunction((n) => document.querySelectorAll('.modal .file-item').length === n, files.length, { timeout: 30000 });
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

(async () => {
  const port = await freePort();
  const server = await startServer(port);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|tile/i.test(m.text())) errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Загрузить файлы');
    await page.screenshot({ path: join(OUT, '01_onboarding.png') });

    const exp = expectedKpi();
    log('ожидаемые KPI (node):', JSON.stringify(pick(exp.kpi)));

    // 1) МЖИ + три сырых CSV ЕДЦ одной операцией
    const raw = ['01_дома.csv', '02_подъезды.csv', '03_заявки_2026.csv'].map((f) => join(FIX, f));
    const pv = await importViaWizard(page, [join(FIX, 'mji_synthetic.csv'), ...raw], { expectJobs: 2, shot: '02_preview.png' });
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
    assert.match(await page.evaluate(() => document.querySelector('.modal').innerText), /Дублирующаяся агрегированная строка/);
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
    log(`резервная копия: ${restored.restored} записей, ${restored.size} байт — восстановлено без потерь`);

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
  }
})().catch((e) => { console.error('E2E ОШИБКА:', e); process.exit(1); });

process.on('unhandledRejection', (e) => { console.error(e); process.exit(1); });
