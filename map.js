// Карта (Leaflet): подложки, хороплет округов/районов, дома с геопозицией, контуры зданий, зоны подъездов,
// тепловой слой заявок (Leaflet.heat) и инструменты ручной разметки (Leaflet-Geoman).
// На карту попадают ТОЛЬКО дома с сохранённой геопозицией — без случайных или «примерных» точек.

import { h, clear, fmt, icon, STATUS } from './ui.js';
import { COV, COV_LABEL, heatPoints, REQ_METRICS, QUARTERS } from './analytics.js';
import { okrugByCode } from './core/okrugs.js';
import { seqColorResolved } from './charts.js';

const L = window.L;
const MOSCOW = [55.751, 37.618];
const PMTILES_URL = 'data/local/moscow.pmtiles';

export const BASEMAPS = {
  pmtiles: { label: 'Офлайн OSM (data/local/moscow.pmtiles)', offline: true },
  carto: { label: 'CARTO (онлайн, по теме)', url: 'https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}{r}.png', sub: 'abcd', max: 20, attr: '© участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>' },
  osm: { label: 'OpenStreetMap (онлайн)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '© участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  dgis: { label: '2ГИС (онлайн; условия — у 2ГИС)', url: 'https://tile{s}.maps.2gis.com/tiles?x={x}&y={y}&z={z}', sub: '0123', max: 18, attr: '© <a href="https://2gis.ru">2ГИС</a>' },
  none: { label: 'Без подложки' },
};

const COLORS = () => {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    full: v('--st-good'), partial: v('--st-serious'), none: v('--st-critical'), na: v('--st-unknown'), excluded: v('--st-excluded'),
    surface: v('--surface'), ink: v('--ink'), accent: v('--accent'), muted: v('--muted'),
  };
};

const HEAT_GRADIENT = { 0.15: '#fde4d6', 0.35: '#f7b48f', 0.55: '#ec835a', 0.75: '#d95926', 1.0: '#9c3413' };

export class MapView {
  constructor({ onHouse, onOkrug, onArea }) {
    this.cb = { onHouse, onOkrug, onArea };
    this.el = h('div', { id: 'map', role: 'region', 'aria-label': 'Карта Москвы' });
    this.shell = h('div', { class: 'map-shell' }, this.el);
    this.map = null;
    this.mode = 'coverage';
    this.layerOn = { okrug: true, area: false, houses: true, buildings: true, zones: true, excluded: false };
    this.pmtiles = { available: false, rangeOk: false, checked: false };
    try { this.basemapId = localStorage.getItem('mca-basemap') || ''; } catch (_) { this.basemapId = ''; }
  }

  mount(parent) {
    if (this.shell.parentNode !== parent) parent.appendChild(this.shell);
    if (!this.map) this._create();
    setTimeout(() => this.map.invalidateSize(), 30);
  }

  _create() {
    this.map = L.map(this.el, { zoomControl: false, preferCanvas: true, minZoom: 8, maxZoom: 19, attributionControl: true })
      .setView(MOSCOW, 10);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(this.map);
    this.renderer = L.canvas({ padding: 0.3 });
    this.groups = {
      okrug: L.layerGroup().addTo(this.map),
      area: L.layerGroup().addTo(this.map),
      buildings: L.layerGroup().addTo(this.map),
      zones: L.layerGroup().addTo(this.map),
      houses: L.layerGroup().addTo(this.map),
      excluded: L.layerGroup(),
      focus: L.layerGroup().addTo(this.map),
    };
    this.controls = h('div', { class: 'map-controls' });
    this.legendEl = h('div', { class: 'map-legend' });
    this.overlayEl = h('div', { class: 'map-overlay hidden' });
    this.shell.append(this.controls, this.legendEl, this.overlayEl);
    if (this.map.pm) {
      this.map.pm.setLang && this.map.pm.setLang('ru');
      this.map.pm.setGlobalOptions({ snappable: false, allowSelfIntersection: false });
    }
    this.checkPmtiles().then(() => this.applyBasemap());
  }

  async checkPmtiles() {
    try {
      const head = await fetch(PMTILES_URL, { method: 'HEAD', cache: 'no-store' });
      if (!head.ok) { this.pmtiles = { available: false, rangeOk: false, checked: true }; return; }
      const rangeOk = (head.headers.get('accept-ranges') || '').includes('bytes');
      this.pmtiles = { available: true, rangeOk, checked: true, size: Number(head.headers.get('content-length')) || 0 };
    } catch (_) {
      this.pmtiles = { available: false, rangeOk: false, checked: true };
    }
  }

  get isDark() {
    return getComputedStyle(document.documentElement).colorScheme.includes('dark');
  }

  applyBasemap(id) {
    if (id) { this.basemapId = id; try { localStorage.setItem('mca-basemap', id); } catch (_) { /* приватный режим */ } }
    let use = this.basemapId;
    if (!use || !BASEMAPS[use] || (use === 'pmtiles' && !(this.pmtiles.available && this.pmtiles.rangeOk))) {
      use = this.pmtiles.available && this.pmtiles.rangeOk ? 'pmtiles' : 'carto';
    }
    this.activeBasemap = use;
    if (this.base) { this.map.removeLayer(this.base); this.base = null; }
    const def = BASEMAPS[use];
    if (use === 'pmtiles' && window.protomapsL) {
      this.base = window.protomapsL.leafletLayer({
        url: PMTILES_URL, flavor: this.isDark ? 'dark' : 'light', lang: 'ru',
        attribution: '© участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="https://protomaps.com">Protomaps</a>',
      });
    } else if (def && def.url) {
      const url = def.url.replace('{style}', this.isDark ? 'dark_all' : 'light_all');
      this.base = L.tileLayer(url, { subdomains: def.sub || 'abc', maxZoom: 19, maxNativeZoom: def.max, attribution: def.attr, crossOrigin: true });
      this.base.on('tileerror', () => { this.tileErrors = (this.tileErrors || 0) + 1; this._renderControls(); });
    }
    if (this.base) this.base.addTo(this.map).bringToBack();
    this._renderControls();
  }

  /** Полное обновление слоёв. ctx: {rows, geo, zones, boundaries, okrugKpi, areaKpi, choro, filters, heat} */
  update(ctx) {
    if (!this.map) return;
    this.ctx = ctx;
    this._renderChoropleth();
    this._renderHouses();
    this._renderHeat();
    this._renderLegend();
    this._renderControls();
    this._renderOverlay();
  }

  setMode(mode) {
    this.mode = mode;
    if (this.ctx) this.update(this.ctx);
  }

  // ---------- хороплет округов и районов ----------
  _renderChoropleth() {
    const { boundaries, okrugKpi, areaKpi, choro, filters } = this.ctx;
    this.groups.okrug.clearLayers();
    this.groups.area.clearLayers();
    const c = COLORS();
    const paint = (layerGroup, fc, keyProp, kpiMap, onClick, kind) => {
      if (!fc) return;
      const vals = [...kpiMap.values()].map((k) => choro.value(k)).filter(Number.isFinite);
      const lo = Math.min(...vals); const hi = Math.max(...vals);
      const heat = this.mode === 'heat';
      L.geoJSON(fc, {
        renderer: this.renderer,
        style: (f) => {
          const key = f.properties[keyProp];
          const k = kpiMap.get(key);
          const v = k ? choro.value(k) : null;
          const t = Number.isFinite(v) ? (hi > lo ? (v - lo) / (hi - lo) : 0.5) : null;
          const sel = (kind === 'okrug' && filters.okrug === key) || (kind === 'area' && filters.area === key);
          return {
            color: sel ? c.ink : c.muted, weight: sel ? 2.5 : kind === 'okrug' ? 1.2 : 0.7, opacity: 0.9,
            fillColor: t === null || heat ? c.muted : seqColorResolved(t), fillOpacity: heat ? 0.03 : t === null ? 0.05 : 0.42,
            dashArray: key ? null : '3 3',
          };
        },
        onEachFeature: (f, layer) => {
          const key = f.properties[keyProp];
          const k = kpiMap.get(key);
          const name = kind === 'okrug' ? (okrugByCode(key)?.full || f.properties.name) : (key || f.properties.name);
          layer.bindTooltip(() => {
            const box = h('div', null, h('b', null, name || 'Без названия'));
            if (!key) box.append(h('div', { class: 'muted' }, 'Не сопоставлено с МЖИ по названию'));
            else if (k) box.append(h('div', null, `${choro.label}: `, h('b', null, choro.text(k))), h('div', { class: 'muted' }, choro.sub(k)));
            return box;
          }, { sticky: true });
          if (key) layer.on('click', () => onClick && onClick(key));
        },
      }).addTo(layerGroup);
    };
    if (this.layerOn.okrug && boundaries.okrug) paint(this.groups.okrug, boundaries.okrug.geojson, '_okrug', okrugKpi, this.cb.onOkrug, 'okrug');
    if (this.layerOn.area && boundaries.area) paint(this.groups.area, boundaries.area.geojson, '_area', areaKpi, this.cb.onArea, 'area');
  }

  // ---------- дома ----------
  _renderHouses() {
    const { rows, geo, zones } = this.ctx;
    for (const g of ['houses', 'buildings', 'zones', 'excluded']) this.groups[g].clearLayers();
    if (this.mode === 'heat') { this.map.removeLayer(this.groups.excluded); return; }
    const c = COLORS();
    let n = 0;
    this.counts = { full: 0, partial: 0, none: 0, na: 0, excluded: 0 };
    for (const r of rows) {
      const g = geo.get(r.u);
      if (!g) continue;
      n++;
      const cov = r.cov || COV.na;
      this.counts[cov] = (this.counts[cov] || 0) + 1;
      const target = cov === COV.excluded ? this.groups.excluded : this.groups.houses;
      const color = c[cov] || c.na;
      if (g.building && this.layerOn.buildings) {
        L.geoJSON(g.building, {
          renderer: this.renderer,
          style: { color, weight: 1.5, fillColor: color, fillOpacity: 0.35, dashArray: cov === COV.excluded ? '4 3' : null },
        }).on('click', () => this.cb.onHouse(r.u)).bindTooltip(r.address, { sticky: true })
          .addTo(cov === COV.excluded ? this.groups.excluded : this.groups.buildings);
      }
      if (this.layerOn.houses) {
        L.circleMarker([g.lat, g.lon], {
          renderer: this.renderer, radius: 6.5, weight: 2, color: c.surface, fillColor: color, fillOpacity: 1,
          dashArray: cov === COV.excluded ? '2 2' : null,
        }).on('click', () => this.cb.onHouse(r.u))
          .bindTooltip(() => h('div', null, h('b', null, r.address), h('div', null, STATUS[cov].label),
            g.status === 'verified' || g.status === 'manual' ? null : h('div', { class: 'muted' }, `Геопозиция: ${g.accuracy || 'не проверена'}`)), { direction: 'top', offset: [0, -6] })
          .addTo(target);
      }
    }
    if (this.layerOn.zones) {
      const byU = new Set(rows.map((r) => r.u));
      for (const z of zones) {
        if (!byU.has(z.u) || !z.polygon) continue;
        L.geoJSON(z.polygon, {
          renderer: this.renderer,
          style: { color: c.accent, weight: 1.5, dashArray: z.accuracy === 'verified' ? null : '5 4', fillColor: c.accent, fillOpacity: 0.12 },
        }).bindTooltip(`Подъезд ${z.entrance_number || '—'} · ${z.accuracy === 'verified' ? 'проверенная зона' : 'условная зона'}`, { sticky: true })
          .on('click', () => this.cb.onHouse(z.u)).addTo(this.groups.zones);
      }
    }
    if (this.layerOn.excluded) this.groups.excluded.addTo(this.map); else this.map.removeLayer(this.groups.excluded);
    this.geoShown = n;
  }

  // ---------- тепловая карта ----------
  _renderHeat() {
    if (this.heat) { this.map.removeLayer(this.heat); this.heat = null; }
    this.heatInfo = null;
    if (this.mode !== 'heat') return;
    const { rows, geo, heat } = this.ctx;
    const res = heatPoints(rows, geo, heat.metric, heat.quarter, { onlyVerified: heat.onlyVerified });
    this.heatInfo = res;
    if (!res.pts.length || !L.heatLayer) return;
    const maxV = Math.max(...res.pts.map((p) => p.v));
    const w = (v) => (heat.log ? Math.log1p(v) / Math.log1p(maxV) : v / maxV);
    this.heat = L.heatLayer(res.pts.map((p) => [p.lat, p.lon, w(p.v)]), {
      radius: heat.radius || 24, blur: 18, maxZoom: 15, max: 1, minOpacity: 0.25, gradient: HEAT_GRADIENT,
    }).addTo(this.map);
    // Невидимые маркеры поверх тепла — чтобы клик открывал карточку с исходными числами
    for (const p of res.pts) {
      L.circleMarker([p.lat, p.lon], { renderer: this.renderer, radius: 7, opacity: 0, fillOpacity: 0 })
        .bindTooltip(() => {
          const r = rows.find((x) => x.u === p.u);
          return h('div', null, h('b', null, r ? r.address : p.u), h('div', null, `${REQ_METRICS[heat.metric].label}${heat.quarter ? `, ${QUARTERS[heat.quarter]}` : ''}: `, h('b', null, fmt.int(p.v))));
        }, { direction: 'top' })
        .on('click', () => this.cb.onHouse(p.u)).addTo(this.groups.houses);
    }
  }

  // ---------- легенда ----------
  _renderLegend() {
    const el = this.legendEl;
    clear(el);
    if (this.mode === 'heat') {
      const info = this.heatInfo || { pts: [], withReq: 0 };
      el.append(
        h('h4', null, 'Концентрация заявок (домовой уровень)'),
        h('div', { class: 'heat-scale', style: { background: `linear-gradient(90deg, ${Object.values(HEAT_GRADIENT).join(', ')})` } }),
        h('div', { class: 'heat-scale-l' }, h('span', null, 'меньше'), h('span', null, 'больше')),
        h('div', { class: 'lg-foot' }, `Тепловая карта по ${fmt.int(info.pts.length)} геокодированным домам из ${fmt.int(info.withReq)} домов с заявками. Не экстраполируется на всю Москву.`),
      );
      return;
    }
    const counts = this.counts || {};
    el.append(h('h4', null, 'Обслуживание по привязкам ЕДЦ'));
    for (const k of ['full', 'partial', 'none', 'na', 'excluded']) {
      if (k === 'excluded' && !this.layerOn.excluded) continue;
      el.append(h('div', { class: 'lg-row' }, h('i', { class: 'sw', style: { background: `var(--st-${k === 'full' ? 'good' : k === 'partial' ? 'serious' : k === 'none' ? 'critical' : k === 'na' ? 'unknown' : 'excluded'})` } }),
        icon(STATUS[k].icon, 14), COV_LABEL[k], h('span', { class: 'n' }, fmt.int(counts[k] || 0))));
    }
    el.append(h('div', { class: 'lg-foot' }, 'Найденная настройка обслуживания в ЕДЦ — не подтверждённое подключение. «Нет привязки» ≠ «отключён». На карте только дома с сохранённой геопозицией.'));
  }

  // ---------- переключатели ----------
  _renderControls() {
    if (!this.controls) return;
    clear(this.controls);
    const pm = this.pmtiles;
    const base = h('div', { class: 'map-panel' },
      h('div', { class: 'ttl' }, 'Подложка'),
      h('select', { 'aria-label': 'Подложка карты', onchange: (e) => this.applyBasemap(e.target.value) },
        Object.entries(BASEMAPS).map(([id, b]) => h('option', {
          value: id, selected: id === this.activeBasemap, disabled: id === 'pmtiles' && !(pm.available && pm.rangeOk),
        }, id === 'pmtiles' && !pm.available ? `${b.label} — файл не найден` : id === 'pmtiles' && !pm.rangeOk ? `${b.label} — нужен serve.py` : b.label))),
      this.tileErrors && this.activeBasemap !== 'pmtiles' && this.activeBasemap !== 'none'
        ? h('div', { class: 'muted small', style: { marginTop: '6px', maxWidth: '230px' } }, 'Тайлы не загружаются (нет интернета?). Офлайн-подложка: см. README → «Офлайн-карта».') : null);
    this.controls.append(base);
    if (this.mode !== 'heat') {
      const t = (key, label, disabled) => h('label', null, h('input', {
        type: 'checkbox', checked: this.layerOn[key] && !disabled, disabled,
        onchange: (e) => { this.layerOn[key] = e.target.checked; this.update(this.ctx); },
      }), label);
      const b = this.ctx ? this.ctx.boundaries : {};
      this.controls.append(h('div', { class: 'map-panel' },
        h('div', { class: 'ttl' }, 'Слои'),
        t('okrug', 'Округа (заливка по показателю)', !b.okrug),
        t('area', 'Районы', !b.area),
        t('houses', 'Дома (точки)'),
        t('buildings', 'Контуры зданий'),
        t('zones', 'Зоны подъездов (условные)'),
        t('excluded', 'Неактуальные / нежилые')));
    }
  }

  _renderOverlay() {
    const el = this.overlayEl;
    const ctx = this.ctx;
    clear(el);
    const show = ctx.overlay;
    el.classList.toggle('hidden', !show);
    if (show) el.append(show);
  }

  // ---------- навигация ----------
  focus(u) {
    const g = this.ctx && this.ctx.geo.get(u);
    this.groups.focus.clearLayers();
    if (!g) return false;
    const c = COLORS();
    if (g.building) {
      const lyr = L.geoJSON(g.building);
      this.map.fitBounds(lyr.getBounds(), { maxZoom: 18, padding: [60, 60] });
    } else this.map.setView([g.lat, g.lon], Math.max(this.map.getZoom(), 17));
    L.circleMarker([g.lat, g.lon], { radius: 14, color: c.ink, weight: 2.5, fill: false }).addTo(this.groups.focus);
    return true;
  }

  fitOkrug(code) {
    const b = this.ctx && this.ctx.boundaries.okrug;
    if (!b) return;
    const feats = b.geojson.features.filter((f) => f.properties._okrug === code);
    if (feats.length) this.map.fitBounds(L.geoJSON({ type: 'FeatureCollection', features: feats }).getBounds(), { padding: [20, 20] });
  }

  /** Однократный выбор точки кликом по карте. */
  pickPoint(hint) {
    return new Promise((resolve) => {
      const hintEl = h('div', { class: 'map-pick-hint' }, icon('pin', 16), hint,
        h('button', { onclick: () => { cleanup(); resolve(null); } }, 'Отмена'));
      const cleanup = () => { hintEl.remove(); this.map.off('click', onClick); this.el.style.cursor = ''; };
      const onClick = (e) => { cleanup(); resolve({ lat: e.latlng.lat, lon: e.latlng.lng }); };
      this.shell.appendChild(hintEl);
      this.el.style.cursor = 'crosshair';
      this.map.once('click', onClick);
    });
  }

  /** Рисование полигона (Leaflet-Geoman). Возвращает GeoJSON-геометрию. */
  drawPolygon(hint) {
    return new Promise((resolve) => {
      if (!this.map.pm) { resolve(null); return; }
      const hintEl = h('div', { class: 'map-pick-hint' }, icon('polygon', 16), hint,
        h('button', { onclick: () => { cleanup(); this.map.pm.disableDraw(); resolve(null); } }, 'Отмена'));
      const onCreate = (e) => {
        const gj = e.layer.toGeoJSON().geometry;
        e.layer.remove();
        cleanup();
        resolve(gj);
      };
      const cleanup = () => { hintEl.remove(); this.map.off('pm:create', onCreate); };
      this.shell.appendChild(hintEl);
      this.map.on('pm:create', onCreate);
      this.map.pm.enableDraw('Polygon', { snappable: false, finishOn: 'dblclick', templineStyle: { color: '#2a78d6' }, hintlineStyle: { color: '#2a78d6', dashArray: [5, 5] } });
    });
  }

  previewCandidates(cands) {
    this.groups.focus.clearLayers();
    const c = COLORS();
    const pts = [];
    cands.forEach((cand, i) => {
      if (cand.geometry) L.geoJSON(cand.geometry, { style: { color: c.accent, weight: 2, fillOpacity: 0.15 } }).addTo(this.groups.focus);
      L.marker([cand.lat, cand.lon], { title: `${i + 1}. ${cand.display}` }).bindTooltip(`${i + 1}`, { permanent: true, direction: 'top' }).addTo(this.groups.focus);
      pts.push([cand.lat, cand.lon]);
    });
    if (pts.length) this.map.fitBounds(pts, { maxZoom: 17, padding: [60, 60] });
  }
}
