// Карточка дома (правая панель): МЖИ, сопоставление с ЕДЦ, признаки ЕДЦ, подъезды, заявки 2026, геопривязка.

import { h, clear, fmt, NA, na, icon, kv, statusBadge, toast, modal, confirmDialog, plural } from './ui.js';
import { MATCH_LABEL, NA_REASON, COV_LABEL, classify } from './analytics.js';
import { Q, isIdLabel } from './core/edc.js';
import { nominatimSearch, accuracyOf, centroidOf } from './geo.js';

const drawer = () => document.getElementById('drawer');

export function closeCard() {
  drawer().classList.remove('open');
}

/** Карточка дома МЖИ по UNOM (u). */
export async function openCard(app, u) {
  const row = app.state.rowsByU.get(u);
  if (!row) return openGoneCard(app, u);
  const d = drawer();
  clear(d);
  const head = h('div', { class: 'drawer-head' },
    h('div', { class: 'grow' },
      h('h2', null, row.address || '(адрес не указан)'),
      h('div', { class: 'crumbs' }, [row.okrug, row.area, `UNOM ${row.ur || NA}`].filter(Boolean).join(', ')),
      h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
        statusBadge(row.cov, row.cov === 'na' || row.cov === 'excluded' ? `${COV_LABEL[row.cov]}: ${NA_REASON[row.na] || ''}` : null))),
    h('button', { class: 'icon-btn', 'aria-label': 'Закрыть карточку', onclick: closeCard }, icon('close')));
  const body = h('div', { class: 'drawer-body' });
  d.append(head, body);
  d.classList.add('open');

  const e = row.e;
  const q = row.q;
  body.append(h('div', { class: 'mini-kpis' },
    mini(e ? `${fmt.int(e.el)} / ${fmt.int(e.et)}` : NA, 'подъездов с привязкой / всего'),
    mini(q ? fmt.int(q[Q.total]) : NA, 'заявок 2026 (дом)'),
    mini(q ? fmt.int(q[Q.open]) : NA, 'без даты закрытия'),
    mini(q ? fmt.int(q[Q.critical]) : NA, 'критических')));

  body.append(matchSection(app, row));
  body.append(sect('Реестр МЖИ', null,
    kv('Адрес (МЖИ)', row.address),
    kv('UNOM', row.ur, { mono: true, copy: true }),
    kv('ФИАС', row.fiasRaw ? h('span', null, row.fiasRaw, !row.fiasValid ? h('span', { class: 'chip warn', style: { marginLeft: '6px' } }, 'некорректный') : row.fiasDup ? h('span', { class: 'chip warn', style: { marginLeft: '6px' } }, 'повторяется в МЖИ') : null) : '', { mono: true, copy: row.fiasRaw || false }),
    kv('Код МЖИ', row.code, { mono: true }),
    kv('Округ / район', `${row.okrug}${row.area ? ` / ${row.area}` : ''}`),
    kv('Управляющая организация', row.uk)));

  // Полная запись ЕДЦ (признаки, заявки, подъезды) подгружается из worker - в кэше сопоставления только краткая сводка
  const edcBox = e ? h('div', { class: 'muted small' }, 'Загрузка признаков ЕДЦ...') : null;
  const entrBox = sect('Подъезды (ЕДЦ)', null, h('div', { class: 'muted small' }, e ? 'Загрузка...' : 'Нет сопоставленной записи ЕДЦ.'));
  const reqBox = q ? h('div') : null;
  body.append(...[edcBox, entrBox, reqBox].filter(Boolean));
  body.append(geoSection(app, row));

  if (e) {
    try {
      const det = (await app.worker.call('houseDetail', { r: e.r })).result;
      if (det.house) {
        edcBox.replaceWith(edcSection(det.house));
        if (reqBox) reqBox.replaceWith(requestsSection(det.house, app));
      } else {
        edcBox.replaceWith(h('div', { class: 'note warn' }, icon('warn'), h('div', null, 'Запись ЕДЦ не найдена в текущем снимке. Обновите страницу.')));
        if (reqBox) reqBox.remove();
      }
      entrBox.replaceWith(entrancesSection(app, row, det));
    } catch (err) {
      entrBox.replaceWith(sect('Подъезды (ЕДЦ)', null, h('div', { class: 'note error' }, icon('warn'), err.message)));
    }
  }
}

function mini(v, l) {
  return h('div', { class: 'mini' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
}

function sect(title, extra, ...children) {
  return h('section', { class: 'sect' }, h('h3', null, title, extra), ...children);
}

function yn(v) {
  return v === true ? 'true' : v === false ? h('b', null, 'false') : h('span', { class: 'muted' }, 'не определено');
}

// ---------- сопоставление ----------
function matchSection(app, row) {
  const box = sect('Сопоставление МЖИ и ЕДЦ', null);
  const method = { unom: 'по УНОМ', fias: 'по ФИАС (резервный ключ)', manual: 'вручную' }[row.mm] || '';
  box.append(kv('Статус', h('span', null, h('b', null, MATCH_LABEL[row.m] || row.m), method ? `, ${method}` : '')));
  if (row.mr) box.append(kv('Правило', row.mr));
  if (row.mc > 1) box.append(kv('Кандидатов ЕДЦ', fmt.int(row.mc)));
  if (row.m === 'conflict' && row.cands && row.cands.length) {
    const list = h('div', { class: 'stack', style: { gap: '6px' } }, h('div', { class: 'muted small' }, 'Загрузка кандидатов...'));
    box.append(h('div', { class: 'note warn' }, icon('warn'), h('div', null, 'Несколько записей ЕДЦ подходят к этому УНОМ. Дом не участвует в рейтинге, пока соответствие не подтверждено вручную.')), list);
    app.worker.call('records', { rs: row.cands }).then((res) => {
      clear(list);
      for (const c of res.result.items) {
        const cls = classify(c);
        list.append(h('div', { class: 'entr', style: { gridTemplateColumns: '1fr auto' } },
          h('div', null, h('div', null, h('b', null, c.a || '(без адреса)')),
            h('div', { class: 'meta mono' }, c.r),
            h('div', { class: 'meta' }, `${c.ht || 'тип не указан'}, actual=${c.ac === null ? NA : c.ac}, подъездов ${c.et}, с привязкой ${c.el}, заявок ${c.q ? c.q[Q.total] : 0}`),
            h('div', { class: 'meta' }, COV_LABEL[cls.cov], cls.na ? ` (${NA_REASON[cls.na]})` : '')),
          h('button', { class: 'btn btn-sm', onclick: () => app.setOverride(row.u, c.r, 'выбрано вручную среди кандидатов') }, 'Выбрать')));
      }
    });
  }
  const actions = h('div', { class: 'actions-row' });
  if (row.mm === 'manual' || row.m === 'override_none' || row.m === 'override_missing') {
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => app.clearOverride(row.u) }, icon('refresh', 14), 'Сбросить ручной выбор'));
  } else if (row.m !== 'no_edc') {
    actions.append(h('button', { class: 'btn btn-sm', onclick: () => manualPick(app, row) }, 'Указать запись ЕДЦ вручную'));
    if (row.m !== 'none') actions.append(h('button', { class: 'btn btn-sm btn-ghost', onclick: () => app.setOverride(row.u, null, 'отмечено вручную: нет соответствия') }, 'Нет соответствия'));
  }
  if (actions.childNodes.length) box.append(actions);
  return box;
}

function manualPick(app, row) {
  const input = h('input', { type: 'search', placeholder: 'UUID, УНОМ или адрес ЕДЦ', style: { width: '100%' } });
  const results = h('div', { class: 'stack', style: { gap: '6px' } });
  const run = async () => {
    clear(results);
    const res = (await app.worker.call('search', { q: input.value, limit: 20 })).result;
    if (!res.items.length) results.append(h('div', { class: 'muted' }, 'Ничего не найдено'));
    for (const c of res.items) {
      results.append(h('div', { class: 'entr', style: { gridTemplateColumns: '1fr auto' } },
        h('div', null, h('b', null, c.a || '(без адреса)'), h('div', { class: 'meta mono' }, `${c.r}, УНОМ ${c.ur || NA}`), h('div', { class: 'meta' }, `${c.ht || NA}, actual=${c.ac}, подъездов ${c.et}`)),
        h('button', { class: 'btn btn-sm', onclick: () => { dlg.close(); app.setOverride(row.u, c.r, 'выбрано вручную через поиск'); } }, 'Выбрать')));
    }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  const dlg = modal({
    title: `Соответствие для UNOM ${row.ur}`,
    body: h('div', { class: 'stack' }, h('p', { class: 'ink2' }, `Дом МЖИ: ${row.address}`), input, results),
    actions: [{ label: 'Найти', kind: 'primary', close: false, onClick: run }, { label: 'Закрыть' }],
  });
  input.value = row.ur || '';
  setTimeout(() => input.focus(), 50);
}

// ---------- ЕДЦ ----------
function edcSection(e) {
  return sect('Признаки ЕДЦ', h('span', { class: 'chip' }, 'по данным привязок, не подтверждённое подключение'),
    kv('Адрес (ЕДЦ)', e.a),
    kv('Корневой ID адреса', e.ro, { mono: true, copy: true }),
    kv('ID записи адреса', e.i, { mono: true, copy: true }),
    kv('УНОМ (ЕДЦ)', e.ur, { mono: true }),
    kv('ФИАС (ЕДЦ)', e.fr, { mono: true }),
    kv('Тип дома (house_type)', e.ht),
    kv('Актуальность объекта (actual)', yn(e.ac)),
    kv('Последняя версия записи (is_last)', yn(e.il)),
    kv('Настройки обслуживания', `${fmt.int(e.rel)}, организаций ${fmt.int(e.org)}, полномочий ${fmt.int(e.au)}`),
    kv('Платных дефектов (из 30)', e.pd ? `${e.pd}: ${e.pids}` : '0'),
    kv('Признак «все подъезды»', e.allf),
    kv('Покрытие подъездов (ЕДЦ)', e.ct),
    kv('Подъезды actual true/false/нет', `${e.eat} / ${e.eaf} / ${e.eau}`),
    kv('Дата изменения записи', e.ed));
}

function entrancesSection(app, row, det) {
  const box = sect('Подъезды (ЕДЦ)', null);
  const ents = (det.entrances || []).filter((x) => x.e);
  if (!ents.length) {
    box.append(h('div', { class: 'note' }, icon('info'), h('div', null, 'В ЕДЦ нет записей о подъездах этого дома. Это не значит, что подъездов нет: дом просто не оценивается.')));
    return box;
  }
  const zones = app.state.zones.filter((z) => z.u === row.u);
  const idOnly = ents.filter((x) => isIdLabel(x.lb)).length;
  if (idOnly) box.append(h('div', { class: 'note warn' }, icon('warn'), h('div', null, `У ${idOnly} ${plural(idOnly, 'подъезда', 'подъездов', 'подъездов')} нет номера в ЕДЦ, вместо него показан UUID.`)));
  box.append(h('div', { class: 'small muted' }, 'Заявки по подъезду учитываются только при совпадении UUID подъезда. Заявки без подъезда (UNKNOWN), по резервному ID или номеру не распределяются. Не складывайте их с заявками дома.'));
  const list = h('div', { class: 'entr-list' });
  ents.sort((a, b) => String(a.lb).localeCompare(String(b.lb), 'ru', { numeric: true }));
  for (const x of ents) {
    const z = zones.find((zz) => zz.entrance_root_id === x.e);
    const linked = x.rel > 0;
    list.append(h('div', { class: 'entr' },
      h('div', { class: `no ${isIdLabel(x.lb) ? 'id' : ''}`, title: x.e }, isIdLabel(x.lb) ? x.e.slice(0, 8) + '...' : x.lb),
      h('div', null,
        h('div', null, linked ? h('span', { class: 'badge st-full' }, icon('checkCircle', 13), 'есть привязка') : h('span', { class: 'badge st-none' }, icon('xCircle', 13), 'нет найденной привязки'),
          x.bs ? h('span', { class: 'chip', style: { marginLeft: '6px' } }, x.bs) : null),
        h('div', { class: 'meta' }, x.st),
        h('div', { class: 'meta' }, `Организаций ${x.org}, платных дефектов ${x.pd}, заявок 2026 по UUID подъезда: ${x.q ? fmt.int(x.q[Q.total]) : NA}`),
        h('div', { class: 'meta mono' }, x.e)),
      row.u ? h('div', { class: 'stack', style: { gap: '4px', justifyItems: 'end' } },
        z ? h('span', { class: 'chip accent' }, z.accuracy === 'verified' ? 'зона проверена' : 'условная зона') : null,
        h('button', { class: 'btn btn-sm', title: 'Нарисовать условную зону подъезда на карте', onclick: () => app.drawZone(row, x) }, icon('polygon', 14), z ? 'Перерисовать' : 'Зона'),
        z && z.accuracy !== 'verified' ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => app.saveZone({ ...z, accuracy: 'verified' }) }, 'Подтвердить зону') : null,
        z ? h('button', { class: 'btn btn-sm btn-ghost', onclick: () => app.deleteZone(z.id) }, 'Удалить зону') : null) : h('span')));
  }
  box.append(list);
  return box;
}

// ---------- заявки ----------
function requestsSection(e, app) {
  const q = e.q;
  const quarters = [q[Q.q1], q[Q.q2], q[Q.q3], q[Q.q4]];
  const max = Math.max(1, ...quarters);
  const qbars = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', alignItems: 'end', height: '90px', marginTop: '6px' } },
    quarters.map((v, i) => h('div', { style: { display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%', gap: '3px' } },
      h('div', { class: 'small num', style: { textAlign: 'center' } }, fmt.int(v)),
      h('div', { style: { height: `${(v / max) * 56}px`, minHeight: v ? '2px' : '0', background: 'var(--accent)', borderRadius: '4px 4px 0 0', opacity: i === 3 ? 0.55 : 1 } }),
      h('div', { class: 'small muted', style: { textAlign: 'center' } }, ['I', 'II', 'III', 'IV*'][i]))));
  const snap = app.state.snapEdc;
  return sect('Заявки 2026, уровень дома', h('span', { class: 'chip' }, snap && snap.dataDate ? `срез ${fmt.date(snap.dataDate)}` : 'дата среза не указана'),
    kv('Всего', h('b', null, fmt.int(q[Q.total]))),
    kv('С датой закрытия / без', `${fmt.int(q[Q.closed])} / ${fmt.int(q[Q.open])}`),
    kv('Критических', fmt.int(q[Q.critical])),
    kv('Без корневого ID адреса / подъезда', `${fmt.int(q[Q.noRootAddr])} / ${fmt.int(q[Q.noRootEntr])}`),
    kv('Последняя заявка', e.qd),
    kv('Сопоставление агрегатов', `${e.qm || NA}${e.qg ? `, групп: ${e.qg}` : ''}`),
    kv('УНОМ из заявок', e.qu ? h('span', null, e.qu, e.qx ? h('span', { class: 'chip warn', style: { marginLeft: '6px' } }, 'расходится с УНОМ адреса') : null) : ''),
    qbars,
    h('div', { class: 'small muted' }, '* IV квартал 2026 частичный. «Без даты закрытия» считается по close_date (9999-12-31 означает «не закрыта»), это не статус заявки.'));
}

// ---------- геопривязка ----------
const GEO_STATUS = { manual: 'указано вручную', verified: 'проверено', auto: 'геокодер, требует проверки', imported: 'импорт из файла' };

function geoSection(app, row) {
  const g = app.state.geo.get(row.u);
  const box = sect('Геопривязка', null);
  if (g) {
    box.append(
      kv('Координаты', `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`, { mono: true, copy: `${g.lat},${g.lon}` }),
      kv('Статус', h('span', null, GEO_STATUS[g.status] || g.status, g.review ? h('span', { class: 'chip warn', style: { marginLeft: '6px' } }, g.reviewNote || 'требует проверки') : null)),
      kv('Источник', g.source), kv('Точность', g.accuracy), kv('Контур здания', g.building ? 'есть' : 'нет'),
      kv('Проверено', g.verified_at ? fmt.dateTime(g.verified_at) : ''));
  } else {
    box.append(h('div', { class: 'note' }, icon('info'), h('div', null, 'Координат нет. Дом виден в таблицах и рейтингах, но не на карте.')));
  }
  const a = h('div', { class: 'actions-row' });
  if (g) a.append(h('button', { class: 'btn btn-sm', onclick: () => app.showOnMap(row.u) }, icon('map', 14), 'Показать на карте'));
  a.append(h('button', { class: 'btn btn-sm', onclick: () => geocodeDialog(app, row) }, icon('search', 14), 'Найти координаты (OSM)'));
  a.append(h('button', { class: 'btn btn-sm', onclick: () => app.pickPoint(row) }, icon('pin', 14), 'Указать на карте'));
  a.append(h('button', { class: 'btn btn-sm', onclick: () => app.drawBuilding(row) }, icon('polygon', 14), 'Нарисовать контур'));
  if (g && g.status !== 'verified' && g.status !== 'manual') a.append(h('button', { class: 'btn btn-sm', onclick: () => app.saveGeo({ ...g, status: 'verified', verified_at: new Date().toISOString(), review: '' }) }, icon('check', 14), 'Подтвердить'));
  if (g) a.append(h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { if (await confirmDialog('Удалить геопозицию?', 'Точка и контур этого дома будут удалены. Зоны подъездов сохранятся.', 'Удалить', 'danger')) app.deleteGeo(row.u); } }, icon('trash', 14), 'Удалить'));
  box.append(a);
  return box;
}

export async function nominatimConsent() {
  let ok = false;
  try { ok = localStorage.getItem('mca-nominatim-consent') === 'yes'; } catch (_) { /* приватный режим */ }
  if (ok) return true;
  const yes = await confirmDialog('Отправка адреса в OSM Nominatim',
    'Для поиска координат текст адреса из МЖИ будет отправлен во внешний сервис nominatim.openstreetmap.org (OpenStreetMap Foundation). УНОМ, ФИАС, сведения ЕДЦ и заявки не отправляются. Запросы идут не чаще 1 в секунду, массовое геокодирование не выполняется. Продолжить?',
    'Разрешаю', 'primary');
  if (yes) { try { localStorage.setItem('mca-nominatim-consent', 'yes'); } catch (_) { /* приватный режим */ } }
  return yes;
}

async function geocodeDialog(app, row) {
  if (!(await nominatimConsent())) return;
  const body = h('div', { class: 'stack' }, h('div', { class: 'muted' }, `Поиск: ${row.address}...`));
  const dlg = modal({ title: 'Координаты из OpenStreetMap', body, wide: true, actions: [{ label: 'Закрыть' }] });
  let cands;
  try {
    cands = await nominatimSearch(row.address, { email: app.settings.nominatimEmail });
  } catch (e) {
    dlg.setBody(h('div', { class: 'note error' }, icon('warn'), h('div', null, e.message, h('div', { class: 'small' }, 'Нужен доступ в интернет. Можно указать точку вручную на карте.'))));
    return;
  }
  if (!cands.length) {
    dlg.setBody(h('div', { class: 'note warn' }, icon('warn'), h('div', null, 'OSM не нашёл адрес в пределах Москвы. Укажите точку вручную или нарисуйте контур.')));
    return;
  }
  app.showMapView();
  app.map.previewCandidates(cands);
  let pick = cands.findIndex((c) => c.exact);
  if (pick < 0) pick = 0;
  const list = h('div', { class: 'stack', style: { gap: '6px' } }, cands.map((c, i) => h('label', { class: 'entr', style: { gridTemplateColumns: '28px 1fr auto', cursor: 'pointer' } },
    h('input', { type: 'radio', name: 'cand', checked: i === pick, onchange: () => { pick = i; } }),
    h('div', null, h('b', null, `${i + 1}. ${c.display}`), h('div', { class: 'meta' }, `${c.cls}/${c.type}${c.osm ? `, ${c.osm}` : ''}`), h('div', { class: 'meta' }, accuracyOf(c))),
    c.exact ? h('span', { class: 'badge st-full' }, icon('check', 13), 'номер совпал') : h('span', { class: 'badge st-na' }, 'проверить'))));
  dlg.setBody(h('div', { class: 'stack' }, h('p', { class: 'ink2' }, `Дом МЖИ: ${row.address}. Кандидаты отмечены на карте цифрами, выберите правильный.`), list,
    h('div', { class: 'small muted' }, 'Данные © участники OpenStreetMap (ODbL). Результат сохраняется со статусом «требует проверки», подтвердите его после визуальной проверки.')));
  dlg.setActions([
    { label: 'Отмена' },
    {
      label: 'Сохранить выбранный', kind: 'primary', onClick: () => {
        const c = cands[pick];
        const center = c.geometry ? centroidOf(c.geometry) : null;
        app.saveGeo({
          u: row.u, ur: row.ur, lat: center ? center.lat : c.lat, lon: center ? center.lon : c.lon, building: c.geometry || null,
          source: `OSM Nominatim${c.osm ? ` (${c.osm})` : ''}`, accuracy: accuracyOf(c), status: 'auto', verified_at: '',
          address_at_geocode: row.address, updated_at: new Date().toISOString(),
        });
        toast('Координаты сохранены (статус: требует проверки)', 'ok');
      },
    },
  ]);
}

// ---------- исчезнувшие из снимка ----------
async function openGoneCard(app, u) {
  const d = drawer();
  clear(d);
  d.append(h('div', { class: 'drawer-head' }, h('div', { class: 'grow' }, h('h2', null, `UNOM ${u}`)), h('button', { class: 'icon-btn', onclick: closeCard }, icon('close'))),
    h('div', { class: 'drawer-body' }, h('div', { class: 'note warn' }, icon('warn'), h('div', null, 'Дом отсутствует в текущем снимке МЖИ (not_in_latest_snapshot). История и геометрия сохранены.'))));
  d.classList.add('open');
}

/** Карточка записи ЕДЦ, не сопоставленной с МЖИ (из поиска по ЕДЦ). */
export async function openEdcCard(app, r) {
  const d = drawer();
  clear(d);
  const body = h('div', { class: 'drawer-body' }, h('div', { class: 'muted' }, 'Загрузка...'));
  d.append(h('div', { class: 'drawer-head' }, h('div', { class: 'grow' }, h('h2', null, 'Запись ЕДЦ'), h('div', { class: 'crumbs mono' }, r)),
    h('button', { class: 'icon-btn', 'aria-label': 'Закрыть карточку', onclick: closeCard }, icon('close'))), body);
  d.classList.add('open');
  const det = (await app.worker.call('houseDetail', { r })).result;
  clear(body);
  const mji = app.state.rows.find((x) => x.e && x.e.r === r);
  if (mji) {
    body.append(h('div', { class: 'note ok' }, icon('checkCircle'), h('div', null, 'Запись сопоставлена с домом МЖИ: ', h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); openCard(app, mji.u); } }, mji.address))));
  } else {
    body.append(h('div', { class: 'note' }, icon('info'), h('div', null, 'Запись ЕДЦ не сопоставлена с реестром МЖИ и не входит в рейтинги округов (в ЕДЦ нет поля округа).')));
  }
  if (!det.house) {
    if (det.gone) body.append(h('div', { class: 'note warn' }, icon('warn'), h('div', null, `Нет в текущем снимке ЕДЦ (пропала в снимке от ${fmt.date(det.gone.missingSinceDate)}). Последняя известная запись: ${det.gone.a || ''}`)));
    return;
  }
  const e = det.house;
  body.append(edcSection(e));
  if (e.q) body.append(requestsSection(e, app));
  body.append(entrancesSection(app, { u: '' }, det));
}
