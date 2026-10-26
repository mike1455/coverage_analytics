// Геоданные: геокодирование (OSM Nominatim - только по явному действию пользователя и с его согласия),
// границы округов/районов (OSM Overpass или GeoJSON-файл), импорт/экспорт координат.
// Ничего не геокодируется автоматически и массово: политика Nominatim - не более 1 запроса в секунду.

import { normUnom, str } from './core/util.js';
import { normOkrug, areaKey } from './core/okrugs.js';
import { parseCsvText } from './core/csv.js';

export const MOSCOW_BBOX = { minLon: 36.8, minLat: 55.13, maxLon: 37.97, maxLat: 56.03 };
export const inMoscow = (lat, lon) => lat >= MOSCOW_BBOX.minLat && lat <= MOSCOW_BBOX.maxLat && lon >= MOSCOW_BBOX.minLon && lon <= MOSCOW_BBOX.maxLon;

// ---------- адрес МЖИ → запрос геокодера ----------

// Сокращения в адресах МЖИ. \b в JS не работает с кириллицей, поэтому границы задаются явно.
const ABBR = [
  ['пер', 'переулок'], ['ул', 'улица'], ['пр-т', 'проспект'], ['просп', 'проспект'], ['пр-д', 'проезд'],
  ['б-р', 'бульвар'], ['ш', 'шоссе'], ['наб', 'набережная'], ['пл', 'площадь'], ['туп', 'тупик'],
  ['пос', 'посёлок'], ['мкр', 'микрорайон'],
].map(([a, full]) => [new RegExp(`(^|[\\s,(])${a.replace(/[-.]/g, '\\$&')}\\.?(?=[\\s,)]|$)`, 'gi'), `$1${full}`]);

/** Разбор адреса МЖИ: улица, номер дома в формате OSM Москвы («30», «35-37с4», «11к2»). */
export function parseMjiAddress(address) {
  let s = str(address).replace(/\s+/g, ' ');
  // Длинная форма ГАР: «Российская Федерация, город Москва, внутригородская территория ... , улица, дом 4, корпус 1»
  s = s.replace(/^Российская Федерация,\s*/i, '').replace(/^город Москва,\s*/i, '')
    .replace(/внутригородская территория (муниципальный округ|поселение|городской округ) [^,]+,\s*/i, '');
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  let house = '';
  let korp = '';
  let stroy = '';
  const rest = [];
  for (const p of parts) {
    let m;
    // Длинные варианты раньше коротких; значение обязано начинаться с цифры («деревня Раево» - не дом).
    if ((m = p.match(/^(?:дом|владение|влд\.?|вл\.?|д\.?)\s*(\d.*)$/i))) house = m[1].replace(/\s+/g, '');
    else if ((m = p.match(/^(?:корпус|корп\.?|к\.?)\s*(\d.*)$/i))) korp = m[1].replace(/\s+/g, '');
    else if ((m = p.match(/^(?:строение|стр\.?|с\.?)\s*(\d.*)$/i))) stroy = m[1].replace(/\s+/g, '');
    else rest.push(p);
  }
  let street = rest.join(', ');
  for (const [re, rep] of ABBR) street = street.replace(re, rep);
  street = street.replace(/\s+/g, ' ').trim();
  const housenumber = `${house}${korp ? `к${korp}` : ''}${stroy ? `с${stroy}` : ''}`;
  return { street, house, korp, stroy, housenumber };
}

export function normHouseNumber(v) {
  return str(v).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, '').replace(/корпус|корп\.?/g, 'к').replace(/строение|стр\.?/g, 'с');
}

// ---------- Nominatim ----------

let lastCall = 0;
async function throttle() {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

/**
 * Поиск кандидатов по адресу МЖИ. Отправляется ТОЛЬКО текст адреса (без УНОМ, ФИАС, заявок).
 * @returns {Promise<Array<{lat, lon, display, cls, type, osm, housenumber, exact, geometry}>>}
 */
export async function nominatimSearch(address, { email = '' } = {}) {
  const a = parseMjiAddress(address);
  const base = 'https://nominatim.openstreetmap.org/search';
  const common = `format=jsonv2&addressdetails=1&polygon_geojson=1&limit=5&countrycodes=ru&accept-language=ru` +
    `&viewbox=${MOSCOW_BBOX.minLon},${MOSCOW_BBOX.maxLat},${MOSCOW_BBOX.maxLon},${MOSCOW_BBOX.minLat}&bounded=1` +
    (email ? `&email=${encodeURIComponent(email)}` : '');
  const tries = [];
  if (a.street && a.housenumber) tries.push(`${base}?${common}&street=${encodeURIComponent(`${a.housenumber} ${a.street}`)}&city=${encodeURIComponent('Москва')}`);
  tries.push(`${base}?${common}&q=${encodeURIComponent(`Москва, ${a.street}${a.housenumber ? `, ${a.housenumber}` : ''}`)}`);
  for (const url of tries) {
    await throttle();
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (res.status === 429) throw new Error('Nominatim ограничил частоту запросов (429). Подождите и повторите позже.');
    if (!res.ok) throw new Error(`Nominatim ответил ${res.status}`);
    const list = await res.json();
    if (list.length) {
      return list.map((r) => {
        const hn = r.address ? r.address.house_number : '';
        return {
          lat: Number(r.lat), lon: Number(r.lon), display: r.display_name, cls: r.category || r.class, type: r.type,
          osm: r.osm_type && r.osm_id ? `${r.osm_type}/${r.osm_id}` : '', housenumber: hn || '',
          exact: !!(a.housenumber && hn && normHouseNumber(hn) === normHouseNumber(a.housenumber)),
          geometry: r.geojson && /Polygon/.test(r.geojson.type) ? r.geojson : null,
        };
      }).filter((c) => inMoscow(c.lat, c.lon));
    }
  }
  return [];
}

/** Оценка точности кандидата для записи в geo_cache. */
export function accuracyOf(c) {
  if (c.geometry && c.exact) return 'контур здания OSM, номер дома совпал';
  if (c.exact) return 'точка здания, номер дома совпал';
  if (c.cls === 'building' || c.type === 'house') return 'здание, номер дома не подтверждён';
  return `приблизительно (${c.cls || ''}/${c.type || ''})`;
}

// ---------- границы (Overpass) ----------

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

export function overpassQuery(level) {
  return `[out:json][timeout:180];area["ISO3166-2"="RU-MOW"]->.msk;` +
    `(relation(area.msk)["boundary"="administrative"]["admin_level"="${level}"];);out geom;`;
}

export async function fetchBoundaries(level) {
  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'data=' + encodeURIComponent(overpassQuery(level)),
  });
  if (!res.ok) throw new Error(`Overpass API ответил ${res.status}. Повторите позже или загрузите GeoJSON вручную.`);
  return osmToBoundaries(await res.json());
}

/** Overpass JSON → FeatureCollection полигонов (osmtogeojson), только (Multi)Polygon. */
export function osmToBoundaries(osmJson, toGeo = (typeof window !== 'undefined' ? window.osmtogeojson : null)) {
  if (!toGeo) throw new Error('Не загружена библиотека osmtogeojson');
  const fc = toGeo(osmJson, { flatProperties: true });
  const features = fc.features.filter((f) => f.geometry && /Polygon/.test(f.geometry.type) && String(f.id || f.properties.id || '').includes('relation'));
  return { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', properties: { name: f.properties.name || '', id: f.id || f.properties.id }, geometry: simplifyGeometry(f.geometry, 0.00025) })) };
}

/** Привязка полигонов к округам/районам МЖИ по названию. */
export function annotateBoundaries(fc, kind, knownAreas = []) {
  const areaMap = new Map(knownAreas.map((a) => [areaKey(a), a]));
  const unmatched = [];
  for (const f of fc.features) {
    const p = f.properties || (f.properties = {});
    const names = [p.name, p.NAME, p.name_ru, p['name:ru'], p.ABBREV, p.okrug, p.district, p.NAME_AO, p.OKRUG, p.ADM_NAME].filter(Boolean);
    if (kind === 'okrug') {
      let code = '';
      for (const n of names) { code = normOkrug(n); if (code) break; }
      p._okrug = code;
      if (!code) unmatched.push(names[0] || '(без названия)');
    } else {
      let area = '';
      for (const n of names) { const k = areaKey(n); if (areaMap.has(k)) { area = areaMap.get(k); break; } }
      p._area = area;
      if (!area) unmatched.push(names[0] || '(без названия)');
    }
  }
  return { fc, unmatched };
}

// ---------- упрощение геометрии (Дуглас - Пекер) ----------

function sqSegDist(p, a, b) {
  let x = a[0]; let y = a[1];
  let dx = b[0] - x; let dy = b[1] - y;
  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}

export function simplifyRing(pts, tol) {
  if (pts.length <= 4) return pts;
  const sq = tol * tol;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1; keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [f, l] = stack.pop();
    let max = 0; let idx = 0;
    for (let i = f + 1; i < l; i++) {
      const d = sqSegDist(pts[i], pts[f], pts[l]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > sq) { keep[idx] = 1; stack.push([f, idx], [idx, l]); }
  }
  const out = pts.filter((_, i) => keep[i]).map((p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6]);
  return out.length >= 4 ? out : pts;
}

export function simplifyGeometry(g, tol) {
  if (g.type === 'Polygon') return { type: 'Polygon', coordinates: g.coordinates.map((r) => simplifyRing(r, tol)) };
  if (g.type === 'MultiPolygon') return { type: 'MultiPolygon', coordinates: g.coordinates.map((p) => p.map((r) => simplifyRing(r, tol))) };
  return g;
}

export function centroidOf(geom) {
  const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : null;
  if (!ring) return null;
  // Смещение к первой вершине - иначе при координатах ~37/55 теряется точность.
  const [x0, y0] = ring[0];
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xj = ring[j][0] - x0; const yj = ring[j][1] - y0; const xi = ring[i][0] - x0; const yi = ring[i][1] - y0;
    const f = xj * yi - xi * yj;
    a += f; cx += (xj + xi) * f; cy += (yj + yi) * f;
  }
  if (!a) return { lon: x0, lat: y0 };
  return { lon: x0 + cx / (3 * a), lat: y0 + cy / (3 * a) };
}

// ---------- импорт координат (CSV / GeoJSON) ----------

/**
 * Разбор файла геоданных: CSV с колонками unom + lat + lon (или широта/долгота) либо GeoJSON с properties.UNOM.
 * Возвращает записи geo_cache; точки вне Москвы отбрасываются с предупреждением.
 */
export function parseGeoFile(name, text, sourceLabel = '') {
  const out = [];
  const warnings = [];
  const src = sourceLabel || `импорт: ${name}`;
  const now = new Date().toISOString();
  if (/\.(geo)?json$/i.test(name) || /^\s*\{/.test(text)) {
    const gj = JSON.parse(text);
    const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [];
    for (const f of feats) {
      const p = f.properties || {};
      const unomRaw = p.unom ?? p.UNOM ?? p.Unom ?? p['УНОМ'];
      const u = normUnom(unomRaw);
      if (!u || !f.geometry) { warnings.push('Объект без UNOM или геометрии пропущен'); continue; }
      let lat; let lon; let building = null;
      if (f.geometry.type === 'Point') [lon, lat] = f.geometry.coordinates;
      else if (/Polygon/.test(f.geometry.type)) {
        building = f.geometry;
        const c = centroidOf(f.geometry);
        lat = c.lat; lon = c.lon;
      } else { warnings.push(`UNOM ${unomRaw}: геометрия ${f.geometry.type} не поддерживается`); continue; }
      if (!inMoscow(lat, lon)) { warnings.push(`UNOM ${unomRaw}: координаты вне Москвы`); continue; }
      out.push({ u, ur: String(unomRaw), lat, lon, building, source: p.source || src, accuracy: p.accuracy || (building ? 'контур из файла' : 'точка из файла'), status: p.status === 'verified' ? 'verified' : 'imported', verified_at: p.verified_at || '', updated_at: now });
    }
  } else {
    const { header, rows } = parseCsvText(text);
    const hs = header.map((x) => x.trim().toLowerCase());
    const iU = hs.findIndex((x) => ['unom', 'уном'].includes(x));
    const iLat = hs.findIndex((x) => ['lat', 'latitude', 'широта', 'y'].includes(x));
    const iLon = hs.findIndex((x) => ['lon', 'lng', 'long', 'longitude', 'долгота', 'x'].includes(x));
    const iSrc = hs.findIndex((x) => x === 'source' || x === 'источник');
    const iAcc = hs.findIndex((x) => x === 'accuracy' || x === 'точность');
    if (iU < 0 || iLat < 0 || iLon < 0) throw new Error('CSV геоданных должен содержать колонки unom, lat, lon (или УНОМ, широта, долгота).');
    for (const r of rows) {
      const u = normUnom(r[iU]);
      const lat = Number(String(r[iLat]).replace(',', '.'));
      const lon = Number(String(r[iLon]).replace(',', '.'));
      if (!u || !Number.isFinite(lat) || !Number.isFinite(lon)) { warnings.push(`Строка пропущена: ${r.join(';').slice(0, 80)}`); continue; }
      if (!inMoscow(lat, lon)) { warnings.push(`UNOM ${r[iU]}: координаты вне Москвы (${lat}, ${lon})`); continue; }
      out.push({ u, ur: r[iU], lat, lon, building: null, source: (iSrc >= 0 && r[iSrc]) || src, accuracy: (iAcc >= 0 && r[iAcc]) || 'точка из файла', status: 'imported', verified_at: '', updated_at: now });
    }
  }
  return { records: out, warnings };
}

/** Экспорт геоданных и зон подъездов в GeoJSON. */
export function exportGeoJson(geoList, zones, rowsByU) {
  const features = [];
  for (const g of geoList) {
    const row = rowsByU.get(g.u);
    const props = { unom: g.ur || g.u, address: row ? row.address : '', source: g.source, accuracy: g.accuracy, status: g.status, verified_at: g.verified_at || '' };
    features.push({ type: 'Feature', properties: { ...props, kind: 'point' }, geometry: { type: 'Point', coordinates: [g.lon, g.lat] } });
    if (g.building) features.push({ type: 'Feature', properties: { ...props, kind: 'building' }, geometry: g.building });
  }
  for (const z of zones) {
    features.push({ type: 'Feature', properties: { kind: 'entrance_zone', unom: z.u, entrance_root_id: z.entrance_root_id, entrance_number: z.entrance_number, source: z.source, accuracy: z.accuracy }, geometry: z.polygon });
  }
  return { type: 'FeatureCollection', features };
}
