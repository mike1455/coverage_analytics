// Тесты геомодуля: разбор адресов МЖИ, импорт координат, конвертация границ OSM, упрощение.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMjiAddress, normHouseNumber, parseGeoFile, osmToBoundaries, annotateBoundaries, simplifyRing, centroidOf, exportGeoJson, inMoscow } from '../geo.js';

// UMD-сборка из vendor: в пакете с "type": "module" загружаем её как CommonJS вручную.
const osmtogeojson = (() => {
  const module = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../vendor/osmtogeojson/osmtogeojson.js', import.meta.url), 'utf8'))(module, module.exports);
  return module.exports;
})();

test('адрес МЖИ → улица и номер дома в формате OSM', () => {
  assert.deepEqual(pick(parseMjiAddress('Большой Афанасьевский пер., д.30')), ['Большой Афанасьевский переулок', '30']);
  assert.deepEqual(pick(parseMjiAddress('Афанасьевский Большой пер., д.35-37, стр.4')), ['Афанасьевский Большой переулок', '35-37с4']);
  assert.deepEqual(pick(parseMjiAddress('Ленинский пр-т, д.12, корп.2')), ['Ленинский проспект', '12к2']);
  assert.deepEqual(pick(parseMjiAddress('Российская Федерация, город Москва, внутригородская территория поселение Краснопахорское, деревня Раево, Ирландская улица, дом 4, корпус 1')), ['деревня Раево, Ирландская улица', '4к1']);
  assert.equal(normHouseNumber('35-37 С4'), normHouseNumber('35-37с4'));
});
const pick = (a) => [a.street, a.housenumber];

test('импорт координат: CSV и GeoJSON, точки вне Москвы отбрасываются', () => {
  const csv = parseGeoFile('g.csv', 'УНОМ;широта;долгота\n0015425;55,7512;37,5901\n2;59.9;30.3\n');
  assert.equal(csv.records.length, 1);
  assert.equal(csv.records[0].u, '15425');
  assert.equal(csv.records[0].lat, 55.7512);
  assert.equal(csv.warnings.length, 1);
  const gj = parseGeoFile('g.geojson', JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { UNOM: 7 }, geometry: { type: 'Polygon', coordinates: [[[37.60, 55.75], [37.61, 55.75], [37.61, 55.76], [37.60, 55.76], [37.60, 55.75]]] } },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [37.6, 55.75] } },
  ] }));
  assert.equal(gj.records.length, 1);
  assert.ok(gj.records[0].building);
  assert.ok(Math.abs(gj.records[0].lat - 55.755) < 1e-9);
  assert.throws(() => parseGeoFile('x.csv', 'a,b\n1,2\n'), /unom, lat, lon/);
  assert.equal(inMoscow(55.75, 37.6), true);
  assert.equal(inMoscow(59.9, 30.3), false);
});

test('границы OSM (Overpass out geom) → полигоны с привязкой к округам МЖИ', () => {
  const way = (id, coords) => ({ type: 'way', ref: id, role: 'outer', geometry: coords.map(([lon, lat]) => ({ lat, lon })) });
  const osm = { elements: [
    { type: 'relation', id: 1, tags: { type: 'boundary', boundary: 'administrative', admin_level: '5', name: 'Центральный административный округ' },
      members: [way(11, [[37.5, 55.7], [37.7, 55.7], [37.7, 55.8]]), way(12, [[37.7, 55.8], [37.5, 55.8], [37.5, 55.7]])] },
    { type: 'relation', id: 2, tags: { type: 'boundary', boundary: 'administrative', admin_level: '5', name: 'Неизвестный округ' },
      members: [way(21, [[37.8, 55.7], [37.9, 55.7], [37.9, 55.8], [37.8, 55.7]])] },
  ] };
  const fc = osmToBoundaries(osm, osmtogeojson);
  assert.equal(fc.features.length, 2);
  assert.match(fc.features[0].geometry.type, /Polygon/);
  const { unmatched } = annotateBoundaries(fc, 'okrug');
  assert.equal(fc.features.find((f) => f.properties.name.startsWith('Центр')).properties._okrug, 'ЦАО');
  assert.deepEqual(unmatched, ['Неизвестный округ']);
  const areas = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'район Арбат' }, geometry: fc.features[0].geometry }] };
  annotateBoundaries(areas, 'area', ['Арбат', 'Хамовники']);
  assert.equal(areas.features[0].properties._area, 'Арбат');
  // окончания в OSM и МЖИ могут отличаться: «поселение Филимонковское» и «Филимонковский»
  const g = fc.features[0].geometry;
  const ns = { type: 'FeatureCollection', features: ['поселение Филимонковское', 'поселение Краснопахорское', 'городской округ Троицк', 'район Северный'].map((name) => ({ type: 'Feature', properties: { name }, geometry: g })) };
  const r = annotateBoundaries(ns, 'area', ['Филимонковский', 'Краснопахорский', 'Троицк', 'Северный', 'Северное Бутово']);
  assert.deepEqual(ns.features.map((f) => f.properties._area), ['Филимонковский', 'Краснопахорский', 'Троицк', 'Северный']);
  assert.deepEqual(r.unmatched, []);
});

test('упрощение контура сохраняет замыкание и центр', () => {
  const ring = [];
  for (let i = 0; i <= 360; i += 2) ring.push([37.6 + 0.01 * Math.cos((i * Math.PI) / 180), 55.75 + 0.01 * Math.sin((i * Math.PI) / 180)]);
  const s = simplifyRing(ring, 0.0005);
  assert.ok(s.length < ring.length && s.length >= 4);
  assert.deepEqual(s[0], s[s.length - 1]);
  const c = centroidOf({ type: 'Polygon', coordinates: [s] });
  assert.ok(Math.abs(c.lat - 55.75) < 1e-3 && Math.abs(c.lon - 37.6) < 1e-3);
});

test('экспорт GeoJSON: точки, контуры и зоны подъездов с источником', () => {
  const fc = exportGeoJson([{ u: '1', ur: '001', lat: 55.7, lon: 37.6, source: 'вручную', accuracy: 'точка', status: 'manual', building: { type: 'Polygon', coordinates: [[[37.6, 55.7], [37.61, 55.7], [37.6, 55.71], [37.6, 55.7]]] } }],
    [{ u: '1', entrance_root_id: 'e', entrance_number: '1', polygon: { type: 'Polygon', coordinates: [] }, source: 'вручную', accuracy: 'estimated' }],
    new Map([['1', { address: 'адрес' }]]));
  assert.deepEqual(fc.features.map((f) => f.properties.kind), ['point', 'building', 'entrance_zone']);
  assert.equal(fc.features[0].properties.unom, '001');
});

test('JSON адресного реестра с data.mos.ru: UNOM, контур и центр', () => {
  const poly = { type: 'Polygon', coordinates: [[[37.60, 55.75], [37.61, 55.75], [37.61, 55.76], [37.60, 55.76], [37.60, 55.75]]] };
  const text = JSON.stringify([
    { global_id: 1, UNOM: 5000002, ADDRESS: 'улица Лескова, дом 5', geoData: poly, geodata_center: { type: 'Point', coordinates: [37.605, 55.755] } },
    { global_id: 2, UNOM: '5000003', geoData: JSON.stringify(poly) }, // геометрия строкой, центра нет
    { global_id: 3, UNOM: 7, geodata_center: { type: 'Point', coordinates: [30.3, 59.9] } }, // вне Москвы
  ]);
  const { records, warnings } = parseGeoFile('data-60562.json', text);
  assert.equal(records.length, 2);
  assert.deepEqual([records[0].u, records[0].lat, records[0].lon], ['5000002', 55.755, 37.605]);
  assert.equal(records[0].building.type, 'Polygon');
  assert.ok(Math.abs(records[1].lat - 55.755) < 1e-6 && Math.abs(records[1].lon - 37.605) < 1e-6, 'центр по контуру');
  assert.equal(records[0].source, 'Адресный реестр Москвы, data.mos.ru');
  assert.equal(warnings.length, 1);
});
