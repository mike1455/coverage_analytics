// Карта (Leaflet): подложки, заливка округов и районов по показателю, дома с геопозицией в цветах статуса,
// контуры зданий, зоны подъездов, сетка шестиугольников активности и ручная разметка (Leaflet-Geoman).
// На карту попадают ТОЛЬКО дома с сохранённой геопозицией - без случайных или «примерных» точек.

import { h, clear, fmt, NA, icon } from './ui.js';
import { houseStatus, HS_LABEL, HS_ORDER, metricValue, METRICS, quantileBreaks, classOf } from './analytics.js';
import { okrugByCode } from './core/okrugs.js';
import { rampResolved, rampSteps, fmtMetric, cssVar, HS_ICON } from './charts.js';
import { basemapState, basemapShort, onBasemap, startBasemapDownload } from './basemap.js';

const L = window.L;
const MOSCOW = [55.751, 37.618];
const PMTILES_URL = 'data/local/moscow.pmtiles';

export const BASEMAPS = {
  pmtiles: { label: 'Офлайн-карта (OSM)', offline: true },
  carto: { label: 'CARTO (онлайн, по теме)', url: 'https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}{r}.png', sub: 'abcd', max: 20, attr: '© участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>' },
  osm: { label: 'OpenStreetMap (онлайн)', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19, attr: '© участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
  dgis: { label: '2ГИС (онлайн)', url: 'https://tile{s}.maps.2gis.com/tiles?x={x}&y={y}&z={z}', sub: '0123', max: 18, attr: '© <a href="https://2gis.ru">2ГИС</a>' },
  none: { label: 'Без подложки' },
};

const COLORS = () => {
  const v = cssVar;
  return {
    full: v('--hs-full'), partial: v('--hs-partial'), none: v('--hs-none'), unknown: v('--hs-unknown'), excluded: v('--hs-excluded'),
    surface: v('--surface'), ink: v('--ink'), accent: v('--accent'), muted: v('--muted'),
  };
};

/**
 * Шкала цвета для заливки: доли - линейно от минимума до максимума, остальное - по квантилям (5 классов),
 * чтобы несколько очень больших значений не делали всё остальное одинаково светлым.
 */
export function colorScale(values, metric, ramp) {
  const vals = values.filter(Number.isFinite);
  if (!vals.length) return { t: () => null, legend: [], ramp };
  if ((METRICS[metric] || {}).fmt === 'pct') {
    const lo = Math.min(...vals); const hi = Math.max(...vals);
    return {
      ramp, kind: 'linear', lo, hi,
      t: (v) => (Number.isFinite(v) ? (hi > lo ? (v - lo) / (hi - lo) : 0.5) : null),
      legend: [{ t: 0, label: fmtMetric(metric, lo) }, { t: 1, label: fmtMetric(metric, hi) }],
    };
  }
  const br = quantileBreaks(vals, 5);
  const n = br.length;
  const lo = Math.min(...vals); const hi = Math.max(...vals);
  const edges = [lo, ...br, hi];
  return {
    ramp, kind: 'quantile', breaks: br,
    t: (v) => (Number.isFinite(v) ? (n ? classOf(v, br) / n : 0.5) : null),
    legend: edges.slice(0, -1).map((a, i) => ({ t: n ? i / n : 0.5, label: `${fmtMetric(metric, a)} - ${fmtMetric(metric, edges[i + 1])}` })),
  };
}

export class MapView {
  constructor({ onHouse, onOkrug, onArea }) {
    this.cb = { onHouse, onOkrug, onArea };
    this.el = h('div', { id: 'map', role: 'region', 'aria-label': 'Карта Москвы' });
    this.shell = h('div', { class: 'map-shell' }, this.el);
    this.map = null;
    this.mode = 'coverage';
    // Слои помнятся отдельно для карты домов и карты активности
    this.layerSets = {
      coverage: { okrug: true, area: false, houses: true, buildings: true, zones: true, excluded: false, hex: false },
      activity: { okrug: true, area: true, hex: false },
    };
    this.pmtiles = { available: false, rangeOk: false, checked: false };
    try { this.basemapId = localStorage.getItem('mca-basemap') || ''; } catch (_) { this.basemapId = ''; }
    onBasemap(() => this._renderControls());
  }

  get layerOn() {
    return this.layerSets[this.mode] || this.layerSets.coverage;
  }

  mount(parent) {
    if (this.shell.parentNode !== parent) parent.appendChild(this.shell);
    if (!this.map) this._create();
    setTimeout(() => this.map.invalidateSize(), 30);
  }

  _create() {
    this.map = L.map(this.el, { zoomControl: false, preferCanvas: true, minZoom: 8, maxZoom: 19, attributionControl: true })
      .setView(MOSCOW, 10);
    this.map.attributionControl.setPrefix(false); // без надписи Leaflet, остаются только источники данных
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
      hex: L.layerGroup().addTo(this.map),
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
      const version = head.headers.get('last-modified') || head.headers.get('content-length') || '';
      this.pmtiles = { available: true, rangeOk, checked: true, version, size: Number(head.headers.get('content-length')) || 0 };
    } catch (_) {
      this.pmtiles = { available: false, rangeOk: false, checked: true };
    }
  }

  /** После скачивания или обновления карты: перечитать файл (новый адрес сбрасывает кэш браузера). */
  async reloadOffline() {
    await this.checkPmtiles();
    if (this.map) this.applyBasemap('pmtiles');
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
        url: `${PMTILES_URL}?v=${encodeURIComponent(this.pmtiles.version || '')}`, flavor: this.isDark ? 'dark' : 'light', lang: 'ru',
        attribution: '© участники <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, <a href="https://protomaps.com">Protomaps</a>',
      });
      // Если файл карты повреждён или не читается, сказать об этом, а не показывать пустой фон
      this.pmErrors = 0;
      this.pmLoaded = 0;
      this.base.on('tileload', () => { this.pmLoaded++; });
      this.base.on('tileerror', () => { this.pmErrors++; if (this.pmErrors === 6 && !this.pmLoaded) this._renderControls(); });
    } else if (def && def.url) {
      const url = def.url.replace('{style}', this.isDark ? 'dark_all' : 'light_all');
      this.base = L.tileLayer(url, { subdomains: def.sub || 'abc', maxZoom: 19, maxNativeZoom: def.max, attribution: def.attr, crossOrigin: true });
      this.base.on('tileerror', () => { this.tileErrors = (this.tileErrors || 0) + 1; this._renderControls(); });
    }
    if (this.base) this.base.addTo(this.map).bringToBack();
    this._renderControls();
  }

  /** Полное обновление слоёв. ctx: {rows, geo, zones, boundaries, okrugKpi, areaKpi, choro, filters, hex} */
  update(ctx) {
    if (!this.map) return;
    this.ctx = ctx;
    this._renderChoropleth();
    this._renderHouses();
    this._renderHex();
    this._renderLegend();
    this._renderControls();
    this._renderOverlay();
  }

  setMode(mode) {
    this.mode = mode;
    if (this.ctx) this.update(this.ctx);
  }

  // ---------- заливка округов и районов ----------
  _renderChoropleth() {
    const { boundaries, okrugKpi, areaKpi, choro, filters } = this.ctx;
    this.groups.okrug.clearLayers();
    this.groups.area.clearLayers();
    this.scales = {};
    const c = COLORS();
    const hexOn = this.mode === 'activity' && this.layerOn.hex;
    const paint = (layerGroup, fc, keyProp, kpiMap, onClick, kind, filled) => {
      if (!fc) return;
      const scale = colorScale([...kpiMap.values()].map((k) => choro.value(k)), choro.id, choro.ramp);
      if (filled) this.scales[kind] = scale;
      L.geoJSON(fc, {
        renderer: this.renderer,
        style: (f) => {
          const key = f.properties[keyProp];
          const k = kpiMap.get(key);
          const t = k ? scale.t(choro.value(k)) : null;
          const sel = (kind === 'okrug' && filters.okrug === key) || (kind === 'area' && filters.area === key);
          const fill = filled && t !== null;
          return {
            color: sel ? c.ink : c.muted, weight: sel ? 2.5 : kind === 'okrug' ? 1.4 : 0.7, opacity: 0.9,
            fillColor: fill ? rampResolved(scale.ramp, t) : c.muted, fillOpacity: fill ? (this.mode === 'activity' ? 0.62 : 0.45) : 0.03,
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
    // Если включены районы, округа остаются контуром, а заливка идёт по районам
    const areaOn = this.layerOn.area && boundaries.area;
    if (this.layerOn.okrug && boundaries.okrug) paint(this.groups.okrug, boundaries.okrug.geojson, '_okrug', okrugKpi, this.cb.onOkrug, 'okrug', !areaOn && !hexOn);
    if (areaOn) paint(this.groups.area, boundaries.area.geojson, '_area', areaKpi, this.cb.onArea, 'area', !hexOn);
  }

  // ---------- дома ----------
  _renderHouses() {
    const { rows, geo, zones } = this.ctx;
    for (const g of ['houses', 'buildings', 'zones', 'excluded']) this.groups[g].clearLayers();
    this.counts = {};
    if (this.mode === 'activity') { this.map.removeLayer(this.groups.excluded); return; }
    const c = COLORS();
    let n = 0;
    // Когда домов на карте тысячи, точки мельче, чтобы город не превращался в сплошное пятно
    let nGeo = 0;
    for (const r of rows) if (geo.has(r.u)) nGeo++;
    const radius = nGeo > 5000 ? 3.5 : nGeo > 1000 ? 5 : 6.5;
    const weight = nGeo > 5000 ? 0.8 : 2;
    for (const r of rows) {
      const g = geo.get(r.u);
      if (!g) continue;
      n++;
      const st = houseStatus(r);
      this.counts[st] = (this.counts[st] || 0) + 1;
      const target = st === 'excluded' ? this.groups.excluded : this.groups.houses;
      const color = c[st] || c.unknown;
      if (g.building && this.layerOn.buildings) {
        L.geoJSON(g.building, {
          renderer: this.renderer,
          style: { color, weight: 1.5, fillColor: color, fillOpacity: 0.35, dashArray: st === 'excluded' ? '4 3' : null },
        }).on('click', () => this.cb.onHouse(r.u)).bindTooltip(r.address, { sticky: true })
          .addTo(st === 'excluded' ? this.groups.excluded : this.groups.buildings);
      }
      if (this.layerOn.houses) {
        L.circleMarker([g.lat, g.lon], {
          renderer: this.renderer, radius, weight, color: c.surface, fillColor: color, fillOpacity: 1,
          dashArray: st === 'excluded' ? '2 2' : null,
        }).on('click', () => this.cb.onHouse(r.u))
          .bindTooltip(() => h('div', null, h('b', null, r.address), h('div', null, HS_LABEL[st]),
            r.e && r.e.et ? h('div', { class: 'muted' }, `Подъездов обслуживается: ${fmt.int(Math.min(r.e.el, r.e.et))} из ${fmt.int(r.e.et)}`) : null,
            r.q ? h('div', { class: 'muted' }, `Заявок 2026: ${fmt.int(r.q[0])}`) : null,
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
        }).bindTooltip(`Подъезд ${z.entrance_number || NA}, ${z.accuracy === 'verified' ? 'проверенная зона' : 'условная зона'}`, { sticky: true })
          .on('click', () => this.cb.onHouse(z.u)).addTo(this.groups.zones);
      }
    }
    if (this.layerOn.excluded) this.groups.excluded.addTo(this.map); else this.map.removeLayer(this.groups.excluded);
    this.geoShown = n;
  }

  // ---------- сетка шестиугольников (активность по домам с координатами) ----------
  _renderHex() {
    this.groups.hex.clearLayers();
    this.hexScale = null;
    const hx = this.ctx.hex;
    if (this.mode !== 'activity' || !this.layerOn.hex || !hx || !hx.cells.length) return;
    const { choro } = this.ctx;
    const c = COLORS();
    const scale = colorScale(hx.cells.map((cell) => choro.value(cell.k)), choro.id, choro.ramp);
    this.hexScale = scale;
    for (const cell of hx.cells) {
      const v = choro.value(cell.k);
      const t = scale.t(v);
      L.polygon(cell.ring, {
        renderer: this.renderer, color: c.surface, weight: 1, opacity: 0.9,
        fillColor: t === null ? c.muted : rampResolved(scale.ramp, t), fillOpacity: t === null ? 0.15 : 0.82,
      }).bindTooltip(() => h('div', null,
        h('div', null, `${choro.label}: `, h('b', null, choro.text(cell.k))),
        h('div', { class: 'muted' }, `Домов с координатами в ячейке: ${fmt.int(cell.k.mkd)}, обслуживаются ${fmt.int(cell.k.served)}`),
        h('div', { class: 'muted' }, `Заявок 2026: ${fmt.int(cell.k.req.total)}`),
        h('div', { class: 'muted' }, 'Клик приближает ячейку')), { sticky: true })
        .on('click', () => this.map.setView([cell.lat, cell.lon], Math.max(this.map.getZoom() + 2, 14)))
        .addTo(this.groups.hex);
    }
  }

  // ---------- легенда ----------
  _scaleLegend(title, scale, foot) {
    const el = this.legendEl;
    el.append(h('h4', null, title));
    if (scale.kind === 'linear') {
      el.append(h('div', { class: 'lg-ramp' }, rampSteps(scale.ramp).map((st) => h('i', { style: { background: st.color } }))),
        h('div', { class: 'heat-scale-l' }, h('span', null, scale.legend[0].label), h('span', null, scale.legend[1].label)));
    } else {
      for (const it of scale.legend) {
        el.append(h('div', { class: 'lg-row' }, h('i', { class: 'sw sq', style: { background: rampResolved(scale.ramp, it.t) } }), it.label));
      }
    }
    if (foot) el.append(h('div', { class: 'lg-foot' }, foot));
  }

  _renderLegend() {
    const el = this.legendEl;
    clear(el);
    const { choro } = this.ctx;
    if (this.mode === 'activity') {
      const hx = this.ctx.hex;
      if (this.layerOn.hex && this.hexScale) {
        this._scaleLegend(`${choro.label}: ячейки 600 м`, this.hexScale,
          `Только дома с координатами: ${fmt.int(hx.geoRows)} из ${fmt.int(this.ctx.rows.length)}. Ячейки без домов не рисуются.`);
      } else if (this.scales.area || this.scales.okrug) {
        this._scaleLegend(`${choro.label}: ${this.scales.area ? 'районы' : 'округа'}`, this.scales.area || this.scales.okrug,
          'Считается по всем домам района, координаты не нужны. Классы по квантилям: в каждом примерно поровну районов.');
      } else {
        el.append(h('h4', null, choro.label), h('div', { class: 'lg-foot' }, 'Загрузите границы округов и районов или включите сетку по домам с координатами.'));
      }
      return;
    }
    const counts = this.counts || {};
    el.append(h('h4', null, 'Дома на карте'));
    for (const k of HS_ORDER) {
      if (k === 'excluded' && !this.layerOn.excluded) continue;
      if (!counts[k] && (k === 'unknown' || k === 'excluded')) continue;
      el.append(h('div', { class: 'lg-row' }, h('i', { class: 'sw', style: { background: `var(--hs-${k})` } }),
        icon(HS_ICON[k], 14), HS_LABEL[k], h('span', { class: 'n' }, fmt.int(counts[k] || 0))));
    }
    const sc = this.scales.area || this.scales.okrug;
    if (sc) {
      el.append(h('div', { class: 'lg-sep' }));
      this._scaleLegend(`Заливка ${this.scales.area ? 'районов' : 'округов'}: ${choro.label}`, sc);
    }
    el.append(h('div', { class: 'lg-foot' }, 'На карте только дома с сохранённой геопозицией.'));
  }

  // ---------- переключатели ----------
  _renderControls() {
    if (!this.controls) return;
    clear(this.controls);
    const pm = this.pmtiles;
    const bm = basemapState();
    const offlineHint = !bm.api || (pm.available && bm.job.state !== 'running') ? null
      : bm.job.state === 'running' ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, `Офлайн-карта: ${basemapShort(bm)}`)
        : h('button', { class: 'btn btn-sm', style: { marginTop: '8px', width: '100%', justifyContent: 'center' }, onclick: () => startBasemapDownload() }, icon('download', 14), 'Скачать карту Москвы');
    const base = h('div', { class: 'map-panel' },
      h('div', { class: 'ttl' }, 'Подложка'),
      h('select', { 'aria-label': 'Подложка карты', onchange: (e) => this.applyBasemap(e.target.value) },
        Object.entries(BASEMAPS).map(([id, b]) => h('option', {
          value: id, selected: id === this.activeBasemap, disabled: id === 'pmtiles' && !(pm.available && pm.rangeOk),
        }, id === 'pmtiles' && !pm.available ? `${b.label} (не скачана)` : id === 'pmtiles' && !pm.rangeOk ? `${b.label} (нужен serve.py)` : b.label))),
      this.tileErrors && this.activeBasemap !== 'pmtiles' && this.activeBasemap !== 'none'
        ? h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'Онлайн-подложка не загружается: нет доступа в интернет.') : null,
      this.activeBasemap === 'pmtiles' && this.pmErrors >= 6 && !this.pmLoaded
        ? h('div', { class: 'small', style: { marginTop: '6px', color: 'var(--danger-ink)' } }, 'Офлайн-карта не читается. Обновите её (раздел «Импорт и качество данных») или выберите онлайн-подложку.') : null,
      offlineHint);
    this.controls.append(base);
    const t = (key, label, disabled) => h('label', null, h('input', {
      type: 'checkbox', checked: this.layerOn[key] && !disabled, disabled,
      onchange: (e) => { this.layerOn[key] = e.target.checked; this.update(this.ctx); },
    }), label);
    const b = this.ctx ? this.ctx.boundaries : {};
    if (this.mode === 'activity') {
      this.controls.append(h('div', { class: 'map-panel' },
        h('div', { class: 'ttl' }, 'Слои'),
        t('okrug', 'Округа', !b.okrug),
        t('area', 'Районы (заливка)', !b.area),
        t('hex', 'Сетка по домам с координатами')));
    } else {
      this.controls.append(h('div', { class: 'map-panel' },
        h('div', { class: 'ttl' }, 'Слои'),
        t('okrug', 'Округа', !b.okrug),
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
