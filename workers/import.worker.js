// Web Worker импорта и тяжёлых вычислений. Запускается как module worker.
// Протокол: main → {id, cmd, ...}; worker → {id, type: 'progress' | 'preview' | 'result' | 'error', ...}.
// Импорт пишет новый снимок «рядом» (status=staging) и переключает активный снимок только после
// подтверждения пользователя — так обновление атомарно, а отмена ничего не портит.

import {
  openDb, tx, get, put, getAll, putMany, scan, snapRange, deleteRange, getActive, setMeta, clear, count,
  putJoined, getJoinedHeader,
  STORES, USER_STORES, SOURCE_STORES, H, E,
} from '../storage.js';
import { readCsvBlob, parseCsvText } from '../core/csv.js';
import { readXlsx } from '../core/xlsx.js';
import { parseMji } from '../core/mji.js';
import {
  RequestIndex, houseReader, entranceReader, mergeHouse, mergeEntrance, countEntranceNumber, finalizeRecord,
  detectKind, KIND_LABEL, Q,
} from '../core/edc.js';
import { recordHash, isUuid, normUuid, normUnom, lowerYo, ImportError, nowIso, guessDateFromFilename, dateKey } from '../core/util.js';
import { Joiner, kpiOf, groupKpi } from '../analytics.js';
import { packHouse, unpackHouse, packEntrances, unpackEntrances } from '../core/compact.js';

const BATCH = 4000;
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}`;
let pending = null; // {id, commit(dataDate), cancel()}
let searchIndex = null; // {s, a: [], r: []}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const { id, cmd } = msg;
  const post = (type, payload = {}) => self.postMessage({ id, type, ...payload });
  const done = (result) => self.postMessage({ id, type: 'result', result });
  try {
    switch (cmd) {
      case 'init': done(await init()); break;
      case 'detect': done(await detectFiles(msg.files)); break;
      case 'importMji': await importMji(msg, post); break;
      case 'importEdc': await importEdc(msg, post); break;
      case 'commit': {
        if (!pending || pending.id !== msg.target) throw new Error('Нет ожидающего подтверждения импорта.');
        const p = pending; pending = null;
        done(await p.commit(msg.dataDate, post));
        break;
      }
      case 'cancel': {
        if (pending && pending.id === msg.target) { const p = pending; pending = null; await p.cancel(); }
        done({ cancelled: true });
        break;
      }
      case 'rebuild': done(await rebuildJoin(post)); break;
      case 'search': done(await searchEdc(msg.q, msg.limit || 50)); break;
      case 'houseDetail': done(await houseDetail(msg.r)); break;
      case 'records': done(await records(msg.rs)); break;
      case 'backup': done(await backup(msg.kind, post)); break;
      case 'restore': done(await restore(msg.file, post)); break;
      case 'wipeSources': done(await wipeSources()); break;
      default: throw new Error(`Неизвестная команда: ${cmd}`);
    }
  } catch (e) {
    post('error', { message: e && e.message ? e.message : String(e), name: e && e.name, details: e && e.details });
  }
};

// ---------------------------------------------------------------- init / GC

async function init() {
  await openDb();
  const snaps = await getAll('snapshots');
  const active = await getActive();
  // Прерванные импорты и не удалённые старые снимки — освобождаем место.
  for (const sn of snaps) {
    const isActive = sn.id === active.mji || sn.id === active.edc;
    if (isActive) continue;
    if (sn.status === 'staging') {
      if (sn.source === 'mji') await deleteRange('mji', snapRange(sn.id));
      await tx('snapshots', 'readwrite', (s) => { s.snapshots.delete(sn.id); });
    } else if (!sn.rowsDropped) {
      if (sn.source === 'mji') await deleteRange('mji', snapRange(sn.id));
      await put('snapshots', { ...sn, rowsDropped: true, status: sn.status === 'active' ? 'archived' : sn.status });
    }
  }
  // Свободный слот ЕДЦ должен быть пустым (прерванный импорт, сбой при переключении)
  for (const slot of [0, 1]) {
    if (active.edc && slot === (active.edcSlot || 0)) continue;
    if (await count(H(slot))) { await clear(H(slot)); await clear(E(slot)); }
  }
  const joined = await getJoinedHeader();
  const stale = !joined || joined.mji !== active.mji || joined.edc !== active.edc;
  if (active.mji && stale) await rebuildJoin(() => {});
  return { active, snapshots: await getAll('snapshots') };
}

// ---------------------------------------------------------------- определение файлов

async function readHeader(file) {
  if (/\.xlsx$/i.test(file.name)) {
    const { rows } = readXlsx(await file.arrayBuffer());
    return rows[0] || [];
  }
  // Кодировку определит полный разбор; здесь достаточно первой строки.
  const bytes = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
  let txt;
  try { txt = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true }); } catch (_) {
    txt = new TextDecoder('windows-1251').decode(bytes);
  }
  const firstLines = txt.split(/\r?\n/).slice(0, 2).join('\n');
  return parseCsvText(firstLines).header;
}

async function detectFiles(files) {
  const out = [];
  for (const f of files) {
    try {
      if (/\.(geo)?json$/i.test(f.name)) { out.push({ name: f.name, size: f.size, kind: 'geo' }); continue; }
      if (/\.txt$/i.test(f.name)) { out.push({ name: f.name, size: f.size, kind: 'control' }); continue; }
      const header = await readHeader(f);
      let kind = detectKind(header);
      if (kind === 'unknown' && header.some((h) => /^(unom|унум|унoм|уном)$/i.test(String(h).trim())) &&
          header.some((h) => /^(lat|latitude|широта)$/i.test(String(h).trim()))) kind = 'geo';
      out.push({ name: f.name, size: f.size, kind, label: KIND_LABEL[kind] || kind, header: header.slice(0, 40) });
    } catch (e) {
      out.push({ name: f.name, size: f.size, kind: 'unknown', error: e.message });
    }
  }
  return out;
}

// ---------------------------------------------------------------- МЖИ

async function importMji(msg, post) {
  const file = msg.file;
  const snapId = newId('mji');
  post('progress', { stage: 'Чтение реестра МЖИ', pct: 5 });
  let header;
  let rows;
  let fileInfo = { role: 'mji', name: file.name, size: file.size, lastModified: file.lastModified };
  if (/\.xlsx$/i.test(file.name)) {
    const x = readXlsx(await file.arrayBuffer());
    header = x.rows[0] || [];
    rows = x.rows.slice(1);
    fileInfo.sheet = x.sheetName;
    fileInfo.format = 'xlsx';
  } else {
    rows = [];
    const info = await readCsvBlob(file, {
      onHeader: (h) => { header = h; },
      onRow: (r) => rows.push(r),
    });
    Object.assign(fileInfo, { format: 'csv', encoding: info.encoding, delimiter: info.delimiter });
  }
  post('progress', { stage: 'Проверка МЖИ', pct: 30 });
  const { houses, report } = parseMji(header, rows);
  rows = null;
  fileInfo.rows = report.rowsTotal;
  const active = await getActive();
  const prevSnap = active.mji;
  const diff = { added: 0, changed: 0, gone: 0, same: 0, examples: { added: [], changed: [], gone: [] }, addressChanged: [] };
  if (!report.errors.length) {
    post('progress', { stage: 'Сравнение с предыдущим снимком', pct: 45 });
    const prev = new Map();
    if (prevSnap) for (const h of await getAll('mji', snapRange(prevSnap))) prev.set(h.u, h);
    const seen = new Set();
    for (const h of houses) {
      h.s = snapId;
      h.hs = recordHash(stripLine(h));
      seen.add(h.u);
      const p = prev.get(h.u);
      if (!prevSnap) continue;
      if (!p) { diff.added++; pushEx(diff.examples.added, `${h.ur} ${h.address}`); }
      else if (p.hs !== h.hs) {
        diff.changed++;
        pushEx(diff.examples.changed, `${h.ur} ${h.address}`);
        if (p.address !== h.address) diff.addressChanged.push(h.u);
      } else diff.same++;
    }
    if (prevSnap) for (const u of prev.keys()) if (!seen.has(u)) { diff.gone++; pushEx(diff.examples.gone, `${prev.get(u).ur} ${prev.get(u).address}`); }
    diff.goneKeys = prevSnap ? [...prev.keys()].filter((u) => !seen.has(u)) : [];
    post('progress', { stage: 'Запись снимка МЖИ', pct: 60 });
    await put('snapshots', {
      id: snapId, source: 'mji', status: 'staging', createdAt: nowIso(), files: [fileInfo],
      suggestedDate: guessDateFromFilename(file.name) || isoDay(file.lastModified),
    });
    for (let i = 0; i < houses.length; i += BATCH) await putMany('mji', houses.slice(i, i + BATCH));
  }
  post('progress', { stage: 'Расчёт аналитики', pct: 75 });
  let kpiBefore = null;
  let kpiAfter = null;
  let joined = null;
  if (!report.errors.length) {
    const before = await getJoinedHeader();
    kpiBefore = before ? before.kpi || null : null;
    joined = await computeJoin(houses, active.edc, null, active.edcSlot);
    kpiAfter = kpiOf(joined.rows);
  }
  const { columns, ...reportLite } = report;
  const preview = {
    source: 'mji', snapId, file: fileInfo, report: reportLite, columns: columnsInfo(columns), diff: liteDiff(diff),
    kpiBefore, kpiAfter, byOkrugAfter: joined ? groupKpi(joined.rows, 'okrug') : null,
    suggestedDate: guessDateFromFilename(file.name) || isoDay(file.lastModified),
    blocking: report.errors.length > 0, hasPrev: !!prevSnap,
  };
  pending = {
    id: msg.id,
    commit: async (dataDate) => {
      if (preview.blocking) throw new Error('Импорт содержит критические ошибки и не может быть применён.');
      const prevRows = prevSnap ? new Map((await getAll('mji', snapRange(prevSnap))).map((h) => [h.u, h])) : new Map();
      await tx(['meta', 'snapshots', 'cache', 'mji_gone', 'geo'], 'readwrite', async (s) => {
        const act = (await reqP(s.meta.get('active')))?.value || { mji: null, edc: null };
        act.mji = snapId;
        s.meta.put({ key: 'active', value: act });
        const sn = await reqP(s.snapshots.get(snapId));
        s.snapshots.put({
          ...sn, status: 'active', committedAt: nowIso(), dataDate: dataDate || preview.suggestedDate,
          report: reportLite, diff: liteDiff(diff), kpi: kpiAfter, byOkrug: preview.byOkrugAfter, rows: houses.length,
        });
        if (prevSnap) {
          const old = await reqP(s.snapshots.get(prevSnap));
          if (old) s.snapshots.put({ ...old, status: 'archived', replacedBy: snapId });
        }
        for (const u of diff.goneKeys) {
          const p = prevRows.get(u);
          s.mji_gone.put({ u, record: p, missingSince: snapId, missingSinceDate: dataDate || preview.suggestedDate });
        }
        for (const h of houses) s.mji_gone.delete(h.u);
        // Геометрию при смене адреса не двигаем — ставим отметку «требует проверки».
        for (const u of diff.addressChanged) {
          const g = await reqP(s.geo.get(u));
          if (g) s.geo.put({ ...g, review: 'address_changed', reviewNote: 'Адрес в МЖИ изменился после геопривязки' });
        }
        await putJoined(s.cache, { mji: snapId, edc: act.edc, builtAt: nowIso(), edcStats: joined.edcStats, kpi: kpiAfter }, joined.rows);
      });
      if (prevSnap) {
        await deleteRange('mji', snapRange(prevSnap));
        const old = await get('snapshots', prevSnap);
        if (old) await put('snapshots', { ...old, rowsDropped: true });
      }
      return { committed: true, snapId };
    },
    cancel: async () => {
      await deleteRange('mji', snapRange(snapId));
      await tx('snapshots', 'readwrite', (s) => { s.snapshots.delete(snapId); });
    },
  };
  post('preview', { preview });
}

function stripLine(h) {
  const { line, s, hs, ...rest } = h;
  return rest;
}

// ---------------------------------------------------------------- ЕДЦ

async function importEdc(msg, post) {
  const { mode, files, opts = {} } = msg;
  const snapId = newId('edc');
  const active = await getActive();
  const prevSnap = active.edc;
  const prevSlot = active.edcSlot || 0;
  const slot = prevSnap ? 1 - prevSlot : 0;
  const HS = H(slot); const ES = E(slot); const HP = H(prevSlot); const EP = E(prevSlot);
  await clear(HS); await clear(ES);
  if (mode === 'requests' && !prevSnap) throw new ImportError('Для обновления только заявок нужен уже загруженный снимок адресов ЕДЦ.');
  const need = mode === 'raw' ? ['houses', 'entrances', 'requests'] : mode === 'merged' ? ['houses', 'entrances'] : ['requests'];
  for (const r of need) if (!files[r]) throw new ImportError(`Не выбран файл: ${roleLabel(r, mode)}`);

  const report = { errors: [], warnings: [], files: [], control: {} };
  const fileInfo = (role, f, info) => {
    const o = { role, name: f.name, size: f.size, lastModified: f.lastModified, ...info };
    report.files.push(o);
    return o;
  };
  await put('snapshots', { id: snapId, source: 'edc', status: 'staging', mode, createdAt: nowIso(), slot });

  try {
    // 1) Агрегаты заявок (SQL № 4)
    let index = null;
    if (mode === 'raw' || mode === 'requests') {
      index = new RequestIndex();
      const f = files.requests;
      const info = await readCsvBlob(f, {
        onHeader: (h) => {
          if (detectKind(h) !== 'requests') throw new ImportError(`Файл «${f.name}» не похож на выгрузку SQL № 4 (заявки).`);
          index.setHeader(h);
        },
        onRow: (row, line) => index.addRow(row, line),
        onChunk: (p) => progress(post, 'Заявки 2026 (SQL № 4)', p, 0, 20),
      });
      fileInfo('requests', f, { encoding: info.encoding, delimiter: info.delimiter, rows: info.rows });
      report.control.requests = {
        houseLevel: index.loaded['Дом'], entranceLevel: index.loaded['Подъезд'], otherLevel: index.otherLevel,
        noAddressKey: index.noAddressKey, houseLevelRequests: index.houseLevelTotal(),
        keyTypes: [...index.byKeyType.entries()].map(([k, n]) => ({ key: k, n })),
      };
      if (index.otherLevel) report.warnings.push(`${index.otherLevel} строк заявок с неизвестным «Уровнем агрегации» пропущены.`);
      if (index.noAddressKey) report.warnings.push(`${index.noAddressKey} агрегатов заявок без ID адреса.`);
    }

    // Хэши предыдущего снимка для предпросмотра изменений
    const prev = new Map();
    if (prevSnap) {
      post('progress', { stage: 'Чтение предыдущего снимка ЕДЦ', pct: 21 });
      await scan(HP, snapRange(prevSnap), (vals) => { for (const v of vals) prev.set(v.r, v.hs); });
    }
    const diff = { added: 0, changed: 0, same: 0, gone: 0, examples: { added: [], changed: [], gone: [] } };
    const seen = new Set();
    const houseEt = new Map();
    let houseRows = 0;
    const houseCtr = { matched: 0, notMatched: 0, mismatch: 0, methods: {} };
    const writeHouse = (rec, batch) => {
      finalizeRecord(rec);
      if (seen.has(rec.r)) throw new ImportError(`Повторяется ключ дома ${rec.r}: CSV № 2 больше не «одна строка на адрес». Проверьте SQL и root_id.`);
      seen.add(rec.r);
      houseEt.set(rec.r, rec.et);
      const p = prev.get(rec.r);
      if (prevSnap) {
        if (p === undefined) { diff.added++; pushEx(diff.examples.added, `${rec.r} ${rec.a}`); }
        else if (p !== rec.hs) { diff.changed++; pushEx(diff.examples.changed, `${rec.r} ${rec.a}`); }
        else diff.same++;
      }
      if (rec.qg > 0) houseCtr.matched++; else houseCtr.notMatched++;
      if (rec.qx) houseCtr.mismatch++;
      houseCtr.methods[rec.qm || '(нет)'] = (houseCtr.methods[rec.qm || '(нет)'] || 0) + 1;
      if (hk) hk.set(rec.r, [rec.ro, rec.i, rec.ur]);
      batch.push(packHouse(rec));
    };
    // Ключи адреса по дому — нужны для пересчёта подъездов в режиме «только заявки»
    const hk = mode === 'requests' ? new Map() : null;

    // 2) Дома
    if (mode === 'requests') {
      post('progress', { stage: 'Пересчёт заявок по домам', pct: 30 });
      await scan(HP, snapRange(prevSnap), async (vals) => {
        const batch = [];
        for (const old of vals) {
          const rec = unpackHouse(old);
          delete rec.hs;
          rec.s = snapId;
          mergeHouse(rec, index);
          writeHouse(rec, batch);
          houseRows++;
        }
        await putMany(HS, batch);
      });
      const prevSn = await get('snapshots', prevSnap);
      report.files.push(...(prevSn?.files || []).filter((x) => x.role !== 'requests').map((x) => ({ ...x, reused: true })));
    } else {
      const f = files.houses;
      let reader = null;
      let batch = [];
      const merged = mode === 'merged';
      const info = await readCsvBlob(f, {
        onHeader: (h) => {
          const kind = detectKind(h);
          if (kind !== (merged ? 'houses_merged' : 'houses')) {
            throw new ImportError(`Файл «${f.name}» распознан как «${KIND_LABEL[kind]}», а ожидался ${roleLabel('houses', mode)}.`);
          }
          reader = houseReader(h, merged);
        },
        onRow: (row, line) => {
          const rec = reader.read(row, line);
          rec.s = snapId;
          if (!merged) mergeHouse(rec, index);
          writeHouse(rec, batch);
          houseRows++;
        },
        onChunk: async (p) => {
          if (batch.length >= BATCH || p.done) { const b = batch; batch = []; await putMany(HS, b); }
          progress(post, 'Адреса ЕДЦ (SQL № 2)', p, 20, 55);
        },
      });
      fileInfo('houses', f, { encoding: info.encoding, delimiter: info.delimiter, rows: info.rows, unknownColumns: reader.cols.unknown });
      if (reader.cols.ambiguous.length) report.warnings.push(`Неоднозначные заголовки домов: ${reader.cols.ambiguous.join('; ')}`);
    }
    if (!houseRows) throw new ImportError('Выгрузка домов пуста.');
    if (prevSnap) for (const r of prev.keys()) if (!seen.has(r)) { diff.gone++; pushEx(diff.examples.gone, r); }
    diff.goneKeys = prevSnap ? [...prev.keys()].filter((r) => !seen.has(r)) : [];
    prev.clear();
    report.control.houses = { rows: houseRows, ...houseCtr };

    // 3) Подъезды: одна запись на дом (core/compact.js), строки-заглушки «нет подъездов» не хранятся
    const entrCtr = {};
    const entrSeen = new Set();
    const perHouse = new Map();
    let entrRows = 0;
    let stubRows = 0;
    let realEntr = 0;
    let orphan = 0;
    const entrMethods = {};
    const checkEntr = (e) => {
      const k = `${e.h}\u0001${e.e}`;
      if (entrSeen.has(k)) throw new ImportError(`Повторяется строка подъезда: дом ${e.h}, подъезд ${e.e || '(нет)'}. Проверьте экспорт SQL № 3.`);
      entrSeen.add(k);
      if (!houseEt.has(e.h)) orphan++;
      if (e.e) { realEntr++; perHouse.set(e.h, (perHouse.get(e.h) || 0) + 1); } else stubRows++;
      entrMethods[e.qm || '(нет)'] = (entrMethods[e.qm || '(нет)'] || 0) + 1;
      entrRows++;
    };
    // SQL № 3 отсортирован по адресу: подъезды дома идут подряд в пределах одного текста адреса.
    // Группы сбрасываются при смене адреса; если дом встретился снова позже — дозапись в конце (late).
    let groups = new Map();
    let curAddr = null;
    const flushed = new Set();
    const late = new Map();
    let outBatch = [];
    const flushGroups = () => {
      for (const [h, list] of groups) { outBatch.push(packEntrances(snapId, h, list)); flushed.add(h); }
      groups = new Map();
    };
    const addEntr = (e) => {
      if (!e.e) return;
      if (e.a !== curAddr) { flushGroups(); curAddr = e.a; }
      const target = flushed.has(e.h) ? late : groups;
      const list = target.get(e.h);
      if (list) list.push(e); else target.set(e.h, [e]);
    };
    const matchByNumber = !!opts.matchByNumber && mode !== 'merged';
    if (mode === 'requests') {
      const withKeys = (h, list) => {
        const k = hk.get(h) || [h, h, ''];
        for (const e of list) { e.ro = k[0]; e.i = k[1]; e.ur = k[2]; }
        return list;
      };
      let counts = null;
      if (matchByNumber) {
        counts = new Map();
        await scan(EP, snapRange(prevSnap), (vals) => {
          for (const g of vals) for (const e of withKeys(g.h, unpackEntrances(g))) countEntranceNumber(e, counts);
        });
      }
      post('progress', { stage: 'Пересчёт заявок по подъездам', pct: 60 });
      await scan(EP, snapRange(prevSnap), async (vals) => {
        const batch = [];
        for (const g of vals) {
          const list = withKeys(g.h, unpackEntrances(g));
          for (const e of list) {
            mergeEntrance(e, index, { matchByNumber, numberCounts: counts, counters: entrCtr });
            checkEntr(e);
          }
          batch.push(packEntrances(snapId, g.h, list));
        }
        await putMany(ES, batch);
      });
      const prevSn = await get('snapshots', prevSnap);
      stubRows = prevSn?.report?.control?.entrances?.stubs || 0;
      entrRows += stubRows;
    } else {
      const f = files.entrances;
      const merged = mode === 'merged';
      let counts = null;
      if (matchByNumber) {
        counts = new Map();
        let rd0 = null;
        await readCsvBlob(f, {
          onHeader: (h) => { rd0 = entranceReader(h, false); },
          onRow: (row, line) => countEntranceNumber(rd0.read(row, line), counts),
          onChunk: (p) => progress(post, 'Подъезды: подсчёт номеров', p, 55, 65),
        });
      }
      let reader = null;
      const info = await readCsvBlob(f, {
        onHeader: (h) => {
          const kind = detectKind(h);
          if (kind !== (merged ? 'entrances_merged' : 'entrances')) {
            throw new ImportError(`Файл «${f.name}» распознан как «${KIND_LABEL[kind]}», а ожидался ${roleLabel('entrances', mode)}.`);
          }
          reader = entranceReader(h, merged);
        },
        onRow: (row, line) => {
          const e = reader.read(row, line);
          if (!merged) mergeEntrance(e, index, { matchByNumber, numberCounts: counts, counters: entrCtr });
          checkEntr(e);
          addEntr(e);
        },
        onChunk: async (p) => {
          if (p.done) flushGroups();
          if (outBatch.length >= 1000 || p.done) { const b = outBatch; outBatch = []; await putMany(ES, b); }
          progress(post, 'Подъезды ЕДЦ (SQL № 3)', p, matchByNumber ? 65 : 55, 85);
        },
      });
      flushGroups();
      await putMany(ES, outBatch);
      outBatch = [];
      // Дома, чьи подъезды встретились не подряд: дописываем к уже сохранённой записи
      for (const [h, list] of late) {
        const prevRec = await get(ES, [snapId, h]);
        await put(ES, packEntrances(snapId, h, [...unpackEntrances(prevRec), ...list]));
      }
      late.clear(); flushed.clear();
      fileInfo('entrances', f, { encoding: info.encoding, delimiter: info.delimiter, rows: info.rows, unknownColumns: reader.cols.unknown });
      if (reader.cols.ambiguous.length) report.warnings.push(`Неоднозначные заголовки подъездов: ${reader.cols.ambiguous.join('; ')}`);
    }
    // Перекрёстная проверка домов и подъездов
    let etMismatch = 0;
    const etExamples = [];
    for (const [h, et] of houseEt) {
      const n = perHouse.get(h) || 0;
      if (n !== et) { etMismatch++; if (etExamples.length < 10) etExamples.push(`${h}: в домах ${et}, в подъездах ${n}`); }
    }
    report.control.entrances = {
      rows: entrRows, real: realEntr, stubs: stubRows, orphan, etMismatch, etExamples,
      uuidMatched: entrCtr.uuid || 0, numberMatched: entrCtr.number || 0, ambiguousNumbers: entrCtr.ambiguous || 0,
      methods: entrMethods, matchByNumber,
    };
    if (orphan) report.warnings.push(`${orphan} строк подъездов относятся к домам, которых нет в выгрузке домов (разные даты снимков?).`);
    if (etMismatch) report.warnings.push(`У ${etMismatch} домов число подъездов в CSV домов не совпадает с CSV подъездов. Примеры: ${etExamples.slice(0, 3).join('; ')}`);
    if (index) {
      report.control.unmatchedHouse = index.unmatchedReport('Дом');
      report.control.unmatchedEntrance = index.unmatchedReport('Подъезд');
    }
    houseEt.clear(); perHouse.clear(); entrSeen.clear(); seen.clear();

    // 4) Предварительная аналитика с текущим МЖИ
    post('progress', { stage: 'Сопоставление с МЖИ и расчёт KPI', pct: 88 });
    const before = await getJoinedHeader();
    const kpiBefore = before ? before.kpi || null : null;
    let joined = null;
    if (active.mji) joined = await computeJoin(null, snapId, active.mji, slot);
    const kpiAfter = joined ? kpiOf(joined.rows) : null;
    const suggestedDate = suggestEdcDate(report, index, files);
    const preview = {
      source: 'edc', mode, snapId, report, diff: liteDiff(diff), kpiBefore, kpiAfter,
      byOkrugAfter: joined ? groupKpi(joined.rows, 'okrug') : null, edcStatsAfter: joined ? joined.edcStats : null,
      suggestedDate, blocking: false, hasPrev: !!prevSnap, hasMji: !!active.mji,
    };
    const controlTexts = msg.controlTexts || [];
    pending = {
      id: msg.id,
      commit: async (dataDate, postC) => {
        const date = dataDate || suggestedDate;
        // Сохраняем «исчезнувшие» дома с последней известной записью (история, геометрия не теряется).
        const goneRecs = [];
        for (let i = 0; i < diff.goneKeys.length; i += 500) {
          const part = diff.goneKeys.slice(i, i + 500);
          const recs = await tx(HP, 'readonly', (s) => Promise.all(part.map((r) => reqP(s[HP].get([prevSnap, r])))));
          goneRecs.push(...recs.filter(Boolean));
        }
        await tx(['meta', 'snapshots', 'cache', 'edc_gone'], 'readwrite', async (s) => {
          const act = (await reqP(s.meta.get('active')))?.value || { mji: null, edc: null };
          act.edc = snapId;
          act.edcSlot = slot;
          s.meta.put({ key: 'active', value: act });
          const sn = await reqP(s.snapshots.get(snapId));
          s.snapshots.put({
            ...sn, status: 'active', committedAt: nowIso(), dataDate: date, files: report.files, report,
            diff: liteDiff(diff), kpi: kpiAfter, byOkrug: preview.byOkrugAfter, edcStats: preview.edcStatsAfter,
            controlTexts, matchByNumber,
          });
          if (prevSnap) {
            const old = await reqP(s.snapshots.get(prevSnap));
            if (old) s.snapshots.put({ ...old, status: 'archived', replacedBy: snapId });
          }
          for (const packed of goneRecs) {
            const { s: _s, ...rec } = unpackHouse(packed);
            s.edc_gone.put({ r: rec.r, un: rec.un, a: rec.a, record: rec, missingSince: snapId, missingSinceDate: date });
          }
          if (joined) await putJoined(s.cache, { mji: act.mji, edc: snapId, builtAt: nowIso(), edcStats: joined.edcStats, kpi: kpiAfter }, joined.rows);
        });
        // Вернувшиеся дома убираем из «исчезнувших»
        const gone = await getAll('edc_gone');
        const back = [];
        for (const g of gone) {
          if (g.missingSince === snapId) continue;
          const cur = await get(HS, [snapId, g.r]);
          if (cur) back.push(g.r);
        }
        if (back.length) await tx('edc_gone', 'readwrite', (s) => { for (const r of back) s.edc_gone.delete(r); });
        if (prevSnap) {
          postC && postC('progress', { stage: 'Удаление предыдущего снимка', pct: 95 });
          await clear(HP);
          await clear(EP);
          const old = await get('snapshots', prevSnap);
          if (old) await put('snapshots', { ...old, rowsDropped: true });
        }
        searchIndex = null;
        return { committed: true, snapId };
      },
      cancel: async () => {
        await clear(HS);
        await clear(ES);
        await tx('snapshots', 'readwrite', (s) => { s.snapshots.delete(snapId); });
      },
    };
    post('preview', { preview });
  } catch (e) {
    await clear(HS).catch(() => {});
    await clear(ES).catch(() => {});
    await tx('snapshots', 'readwrite', (s) => { s.snapshots.delete(snapId); }).catch(() => {});
    throw e;
  }
}

function suggestEdcDate(report, index, files) {
  let latest = '';
  if (index) for (const r of index.recs) if (r.last && dateKey(r.last) > latest) latest = dateKey(r.last);
  if (latest) return latest.slice(0, 10);
  const f = files.houses || files.requests;
  return isoDay(f && f.lastModified);
}

function roleLabel(role, mode) {
  if (mode === 'merged') return role === 'houses' ? 'объединённый «Дома_ЕДЦ_2026_с_заявками.csv»' : 'объединённый «Подъезды_ЕДЦ_2026_с_заявками.csv»';
  return { houses: '01_дома.csv (SQL № 2)', entrances: '02_подъезды.csv (SQL № 3)', requests: '03_заявки_2026.csv (SQL № 4)' }[role];
}

// ---------------------------------------------------------------- сопоставление

async function computeJoin(mjiHouses, edcSnap, mjiSnap, edcSlot) {
  const mji = mjiHouses || (mjiSnap ? await getAll('mji', snapRange(mjiSnap)) : []);
  const joiner = new Joiner(mji);
  if (edcSnap) await scan(H(edcSlot), snapRange(edcSnap), (vals) => { for (const e of vals) joiner.consider(unpackHouse(e)); });
  const overrides = new Map((await getAll('overrides')).map((o) => [o.u, o]));
  const overrideRecs = new Map();
  if (edcSnap) {
    for (const o of overrides.values()) {
      if (!o.r) continue;
      const rec = await get(H(edcSlot), [edcSnap, o.r]);
      if (rec) overrideRecs.set(o.r, unpackHouse(rec));
    }
  }
  return joiner.finish(overrides, overrideRecs);
}

async function rebuildJoin(post) {
  const active = await getActive();
  if (!active.mji) {
    await tx('cache', 'readwrite', (s) => { s.cache.clear(); });
    return { rebuilt: false };
  }
  post('progress', { stage: 'Пересчёт сопоставления', pct: 50 });
  const joined = await computeJoin(null, active.edc, active.mji, active.edcSlot);
  await tx('cache', 'readwrite', (s) => putJoined(s.cache, { mji: active.mji, edc: active.edc, builtAt: nowIso(), edcStats: joined.edcStats, kpi: kpiOf(joined.rows) }, joined.rows));
  return { rebuilt: true };
}

// ---------------------------------------------------------------- поиск и карточки

async function searchEdc(q, limit) {
  const active = await getActive();
  if (!active.edc) return { items: [], note: 'Данные ЕДЦ не загружены' };
  const s = active.edc;
  const HA = H(active.edcSlot); const EA = E(active.edcSlot);
  const query = String(q || '').trim();
  if (!query) return { items: [] };
  const out = new Map();
  const add = (rec) => { if (rec && !out.has(rec.r)) out.set(rec.r, brief(unpackHouse(rec))); };
  if (isUuid(query)) {
    const u = normUuid(query);
    add(await get(HA, [s, u]));
    await tx(HA, 'readonly', async (st) => {
      const byRec = await reqP(st[HA].index('by_rec').getAll([s, u], 10));
      const byFias = await reqP(st[HA].index('by_fias').getAll([s, u.toUpperCase()], 20));
      byRec.forEach(add); byFias.forEach(add);
    });
    // UUID подъезда → дом
    if (!out.size) {
      const all = await findEntranceByUuid(EA, s, u);
      for (const e of all) add(await get(HA, [s, e.h]));
    }
    return { items: [...out.values()].slice(0, limit), by: 'uuid' };
  }
  if (/^\d{1,9}$/.test(query)) {
    const recs = await tx(HA, 'readonly', (st) => reqP(st[HA].index('by_unom').getAll([s, normUnom(query)], limit)));
    recs.forEach(add);
    return { items: [...out.values()], by: 'unom' };
  }
  if (!searchIndex || searchIndex.s !== s) {
    const a = []; const r = [];
    await scan(HA, snapRange(s), (vals) => { for (const v of vals) { a.push(lowerYo(v.a)); r.push(v.r); } });
    searchIndex = { s, a, r };
  }
  const tokens = lowerYo(query).split(/[\s,.]+/).filter(Boolean);
  const hits = [];
  for (let i = 0; i < searchIndex.a.length && hits.length < limit; i++) {
    const addr = searchIndex.a[i];
    if (tokens.every((t) => addr.includes(t))) hits.push(searchIndex.r[i]);
  }
  const recs = await tx(HA, 'readonly', (st) => Promise.all(hits.map((r) => reqP(st[HA].get([s, r])))));
  recs.forEach(add);
  return { items: [...out.values()], by: 'address' };
}

async function findEntranceByUuid(store, s, u) {
  const found = [];
  await scan(store, snapRange(s), (vals) => { for (const g of vals) if (g.L.some((t) => t[0] === u)) found.push({ h: g.h }); });
  return found;
}

function brief(rec) {
  return { r: rec.r, a: rec.a, ur: rec.ur, un: rec.un, fi: rec.fi, ht: rec.ht, ac: rec.ac, et: rec.et, el: rec.el, q0: rec.q ? rec.q[Q.total] : 0 };
}

async function houseDetail(r) {
  const active = await getActive();
  if (!active.edc) return { house: null, entrances: [], gone: await get('edc_gone', r) };
  const house = unpackHouse(await get(H(active.edcSlot), [active.edc, r]));
  const entrances = house ? unpackEntrances(await get(E(active.edcSlot), [active.edc, r])) : [];
  const gone = house ? null : await get('edc_gone', r);
  return { house, entrances, gone, snap: active.edc };
}

async function records(rs) {
  const active = await getActive();
  if (!active.edc) return { items: [] };
  const HA = H(active.edcSlot);
  const items = await tx(HA, 'readonly', (st) => Promise.all(rs.map((r) => reqP(st[HA].get([active.edc, r])))));
  return { items: items.filter(Boolean).map(unpackHouse) };
}

// ---------------------------------------------------------------- резервное копирование

async function backup(kind, post) {
  const created = nowIso();
  const head = { format: 'moscow-coverage-analytics', version: 1, kind, created };
  if (kind === 'user') {
    const stores = {};
    for (const n of USER_STORES) stores[n] = await getAll(n);
    const metaKeys = ['boundaries_okrug', 'boundaries_area', 'settings'];
    stores.meta = (await getAll('meta')).filter((m) => metaKeys.includes(m.key));
    const blob = new Blob([JSON.stringify({ ...head, stores })], { type: 'application/json' });
    return { blob, name: `coverage_user_backup_${created.slice(0, 10)}.json` };
  }
  // Полная копия: NDJSON (строка на запись), потоково из IndexedDB, сжатие gzip при наличии CompressionStream.
  const names = Object.keys(STORES);
  const enc = new TextEncoder();
  let si = 0;
  let lower = null;
  let total = 0;
  const stream = new ReadableStream({
    start(c) { c.enqueue(enc.encode(JSON.stringify(head) + '\n')); },
    async pull(c) {
      while (si < names.length) {
        const name = names[si];
        const range = lower === null ? null : IDBKeyRange.lowerBound(lower, true);
        const vals = await getAll(name, range, 5000);
        if (!vals.length) { si++; lower = null; continue; }
        lower = keyOf(vals[vals.length - 1], STORES[name].keyPath);
        let chunk = '';
        for (const v of vals) chunk += JSON.stringify({ t: name, v }) + '\n';
        c.enqueue(enc.encode(chunk));
        total += vals.length;
        if (vals.length < 5000) { si++; lower = null; }
        post('progress', { stage: `Резервная копия: ${name}`, pct: Math.round((si / names.length) * 95), rows: total });
        return;
      }
      c.close();
    },
  });
  let out = stream;
  let ext = 'ndjson';
  if (typeof CompressionStream !== 'undefined') { out = stream.pipeThrough(new CompressionStream('gzip')); ext = 'ndjson.gz'; }
  const blob = await new Response(out).blob();
  return { blob, name: `coverage_full_backup_${created.slice(0, 10)}.${ext}`, records: total };
}

async function restore(file, post) {
  const magic = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let stream = file.stream();
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Браузер не поддерживает распаковку gzip.');
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  let eof = false;
  while (!eof && text.indexOf('\n') === -1) {
    const r = await reader.read();
    if (r.done) eof = true; else text += r.value;
  }
  const nl = text.indexOf('\n');
  const first = (nl === -1 ? text : text.slice(0, nl)).trim();
  let head;
  try { head = JSON.parse(first); } catch (e) { throw new Error('Файл не является резервной копией приложения (не JSON).'); }
  if (head.format !== 'moscow-coverage-analytics') throw new Error('Файл не является резервной копией приложения.');
  if (head.kind === 'user') {
    let n = 0;
    for (const [name, vals] of Object.entries(head.stores || {})) {
      if (name !== 'meta' && !USER_STORES.includes(name)) continue;
      await putMany(name, vals);
      n += vals.length;
    }
    await rebuildJoin(post);
    return { restored: n, kind: 'user' };
  }
  if (head.kind !== 'full') throw new Error('Неизвестный тип резервной копии.');
  post('progress', { stage: 'Очистка текущих данных', pct: 3 });
  await tx(Object.keys(STORES), 'readwrite', (s) => { for (const n of Object.keys(STORES)) s[n].clear(); });
  let rest = nl === -1 ? '' : text.slice(nl + 1);
  let buf = {};
  let n = 0;
  let readBytes = 0;
  const flush = async () => { for (const [name, vals] of Object.entries(buf)) await putMany(name, vals); buf = {}; };
  const consume = async (final) => {
    let i;
    while ((i = rest.indexOf('\n')) !== -1 || (final && rest)) {
      const line = i === -1 ? rest : rest.slice(0, i);
      rest = i === -1 ? '' : rest.slice(i + 1);
      if (!line.trim()) continue;
      const { t, v } = JSON.parse(line);
      if (!STORES[t]) continue;
      (buf[t] = buf[t] || []).push(v);
      if (++n % 5000 === 0) {
        await flush();
        post('progress', { stage: 'Восстановление записей', pct: Math.min(95, 5 + Math.round((readBytes / Math.max(file.size, 1)) * 90)), rows: n });
      }
    }
  };
  await consume(false);
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    readBytes += r.value.length;
    rest += r.value;
    await consume(false);
  }
  await consume(true);
  await flush();
  searchIndex = null;
  return { restored: n, kind: 'full' };
}

function keyOf(val, keyPath) {
  return Array.isArray(keyPath) ? keyPath.map((k) => val[k]) : val[keyPath];
}

async function wipeSources() {
  await tx(['meta', ...SOURCE_STORES], 'readwrite', (s) => {
    for (const n of SOURCE_STORES) s[n].clear();
    s.meta.put({ key: 'active', value: { mji: null, edc: null, edcSlot: 0 } });
  });
  searchIndex = null;
  return { wiped: true };
}

// ---------------------------------------------------------------- утилиты

function reqP(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

function pushEx(arr, v) { if (arr.length < 10) arr.push(v); }

function liteDiff(d) {
  const { goneKeys, addressChanged, ...rest } = d;
  return { ...rest, addressChangedCount: addressChanged ? addressChanged.length : undefined };
}

function columnsInfo(cols) {
  if (!cols) return null;
  return { unknown: cols.unknown, ambiguous: cols.ambiguous };
}

function isoDay(ms) {
  if (!ms) return new Date().toISOString().slice(0, 10);
  return new Date(ms).toISOString().slice(0, 10);
}

function progress(post, stage, p, from, to) {
  const frac = p.total ? p.bytes / p.total : 0;
  post('progress', { stage, pct: Math.round(from + (to - from) * frac), rows: p.rows });
}
