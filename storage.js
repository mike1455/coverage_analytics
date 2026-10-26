// IndexedDB: долговременное локальное хранилище (работает и в окне, и в Web Worker).
// Снимки источников версионируются полем `s`; активный снимок задаётся одной записью meta.active,
// поэтому переключение на новый снимок атомарно. Геоданные, зоны подъездов и ручные
// соответствия хранятся отдельно и импортом ЕДЦ/МЖИ не затрагиваются.

export const DB_NAME = 'moscow-coverage-analytics';
export const DB_VERSION = 1;

export const STORES = {
  meta: { keyPath: 'key' },
  snapshots: { keyPath: 'id' },
  mji: { keyPath: ['s', 'u'] },
  // Снимки ЕДЦ - в двух чередующихся «слотах»: новый пишется в свободный, старый после переключения
  // очищается через clear() (мгновенно), а не построчным delete(range) с обновлением индексов.
  edc_houses_0: { keyPath: ['s', 'r'], indexes: { by_unom: ['s', 'un'], by_fias: ['s', 'fi'], by_rec: ['s', 'i'] } },
  edc_houses_1: { keyPath: ['s', 'r'], indexes: { by_unom: ['s', 'un'], by_fias: ['s', 'fi'], by_rec: ['s', 'i'] } },
  edc_entr_0: { keyPath: ['s', 'h'] }, // одна запись на дом: подъезды в массиве L (core/compact.js)
  edc_entr_1: { keyPath: ['s', 'h'] },
  edc_gone: { keyPath: 'r' },
  mji_gone: { keyPath: 'u' },
  geo: { keyPath: 'u' },
  zones: { keyPath: 'id', autoIncrement: true, indexes: { by_u: 'u' } },
  overrides: { keyPath: 'u' },
  geoq: { keyPath: 'u' },
  cache: { keyPath: 'key' },
};

export const H = (slot) => `edc_houses_${slot || 0}`;
export const E = (slot) => `edc_entr_${slot || 0}`;
export const SOURCE_STORES = ['snapshots', 'mji', 'edc_houses_0', 'edc_houses_1', 'edc_entr_0', 'edc_entr_1', 'edc_gone', 'mji_gone', 'cache'];

// Хранилища, которые относятся к ручной работе пользователя - их нельзя терять при импорте.
export const USER_STORES = ['geo', 'zones', 'overrides', 'geoq'];

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const st = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: !!def.autoIncrement });
        for (const [iname, ipath] of Object.entries(def.indexes || {})) st.createIndex(iname, ipath);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('База данных занята другой вкладкой приложения. Закройте лишние вкладки.'));
  });
  return dbPromise;
}

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Транзакция: fn(stores) может вернуть значение; промис разрешается после complete. */
export async function tx(names, mode, fn) {
  const db = await openDb();
  const list = Array.isArray(names) ? names : [names];
  return new Promise((resolve, reject) => {
    const t = db.transaction(list, mode);
    const stores = Object.fromEntries(list.map((n) => [n, t.objectStore(n)]));
    let result;
    let fnErr = null;
    t.oncomplete = () => (fnErr ? reject(fnErr) : resolve(result));
    t.onerror = () => reject(t.error || fnErr);
    t.onabort = () => reject(t.error || fnErr || new Error('Транзакция IndexedDB прервана'));
    Promise.resolve()
      .then(() => fn(stores, t))
      .then((r) => { result = r; })
      .catch((e) => { fnErr = e; try { t.abort(); } catch (_) { /* уже завершена */ } });
  });
}

export const get = (store, key) => tx(store, 'readonly', (s) => reqP(s[store].get(key)));
export const put = (store, val) => tx(store, 'readwrite', (s) => reqP(s[store].put(val)));
export const del = (store, key) => tx(store, 'readwrite', (s) => reqP(s[store].delete(key)));
export const getAll = (store, range, count) => tx(store, 'readonly', (s) => reqP(s[store].getAll(range, count)));
export const count = (store, range) => tx(store, 'readonly', (s) => reqP(s[store].count(range)));
export const clear = (store) => tx(store, 'readwrite', (s) => reqP(s[store].clear()));

export function putMany(store, vals) {
  if (!vals.length) return Promise.resolve();
  return tx(store, 'readwrite', (s) => {
    const st = s[store];
    for (const v of vals) st.put(v);
  });
}

/** Диапазон всех записей снимка s для составного ключа [s, ...]. */
export function snapRange(s) {
  return IDBKeyRange.bound([s], [s, []]);
}

export function deleteRange(store, range) {
  return tx(store, 'readwrite', (s) => reqP(s[store].delete(range)));
}

function keyOf(val, keyPath) {
  return Array.isArray(keyPath) ? keyPath.map((k) => val[k]) : val[keyPath];
}

/**
 * Чтение большого диапазона порциями через getAll (быстрее курсора).
 * onChunk(values) может быть async. Возвращает число прочитанных записей.
 */
export async function scan(store, range, onChunk, chunk = 20000) {
  const keyPath = STORES[store].keyPath;
  let lower = range ? range.lower : undefined;
  const upper = range ? range.upper : undefined;
  let open = false;
  let total = 0;
  for (;;) {
    let r;
    if (lower === undefined) r = upper === undefined ? null : IDBKeyRange.upperBound(upper);
    else r = upper === undefined ? IDBKeyRange.lowerBound(lower, open) : IDBKeyRange.bound(lower, upper, open, false);
    const vals = await getAll(store, r, chunk);
    if (!vals.length) break;
    total += vals.length;
    await onChunk(vals);
    if (vals.length < chunk) break;
    lower = keyOf(vals[vals.length - 1], keyPath);
    open = true;
  }
  return total;
}

export async function getMeta(key, fallback = null) {
  const r = await get('meta', key);
  return r ? r.value : fallback;
}

export function setMeta(key, value) {
  return put('meta', { key, value });
}

export async function getActive() {
  return (await getMeta('active')) || { mji: null, edc: null, edcSlot: 0 };
}

// ---------- кэш сопоставления МЖИ и ЕДЦ: заголовок + порции строк ----------
// Одно значение на десятки мегабайт IndexedDB хранит как внешний blob - медленно и ненадёжно.
// Поэтому строки пишутся порциями по JOIN_CHUNK, а заголовок (идентификаторы снимков, KPI) - отдельно.
export const JOIN_CHUNK = 2000;

/** Записать кэш в уже открытую транзакцию (хранилище cache). Возвращает промис завершения запросов. */
export async function putJoined(cacheStore, header, rows) {
  const old = await reqP(cacheStore.get('joined'));
  const n = Math.ceil(rows.length / JOIN_CHUNK);
  for (let i = 0; i < n; i++) cacheStore.put({ key: `joined:${i}`, rows: rows.slice(i * JOIN_CHUNK, (i + 1) * JOIN_CHUNK) });
  for (let i = n; i < ((old && old.chunks) || 0); i++) cacheStore.delete(`joined:${i}`);
  cacheStore.put({ ...header, key: 'joined', chunks: n, count: rows.length });
}

export const getJoinedHeader = () => get('cache', 'joined');

export async function getJoined() {
  return tx('cache', 'readonly', async (s) => {
    const head = await reqP(s.cache.get('joined'));
    if (!head) return null;
    const parts = await Promise.all(Array.from({ length: head.chunks || 0 }, (_, i) => reqP(s.cache.get(`joined:${i}`))));
    const rows = [];
    for (const p of parts) if (p) for (const r of p.rows) rows.push(r);
    if (rows.length !== head.count) return null; // повреждённый кэш - будет пересчитан
    return { ...head, rows };
  });
}

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch (_) { /* недоступно */ }
  return null;
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch (_) { /* недоступно */ }
  return false;
}
