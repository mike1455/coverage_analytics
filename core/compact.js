// Компактное хранение записей ЕДЦ в IndexedDB.
// Полные выгрузки (~300 тыс. адресов + ~400 тыс. строк подъездов) должны помещаться в квоту браузера с запасом
// на второй снимок во время обновления. Поэтому:
//  • ASCII-строки (UUID, УНОМ, даты) хранятся в однобайтовом представлении V8 (вдвое меньше);
//  • поля, совпадающие с ключом или пустые, не записываются;
//  • повторяющиеся русские тексты статусов из SQL кодируются номером (неизвестный текст хранится как есть);
//  • подъезды одного дома — одна запись с массивом кортежей; строки-заглушки «нет подъездов» не хранятся.
// pack → unpack возвращает исходный объект без потерь (см. tests/compact.test.mjs).

export function ob(s) {
  if (typeof s !== 'string' || !s) return s;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 255) return s;
  const c = new Array(s.length);
  for (let i = 0; i < s.length; i++) c[i] = s.charCodeAt(i);
  return String.fromCharCode.apply(null, c);
}

// Тексты из SQL № 2/№ 3 и скриптов S2. Порядок менять нельзя (коды уже записаны в базе) — только дописывать.
const T_ALLF = ['Адрес неактуален; настройки показаны справочно', 'Актуальность адреса неизвестна; настройки показаны справочно',
  'Нет настроек обслуживания', 'Да, во всех настройках', 'Да, в части настроек', 'Нет подтверждения обслуживания всех подъездов'];
const T_CT = ['Адрес неактуален; сведения о подъездах справочно', 'Актуальность адреса неизвестна', 'Нет записей о подъездах',
  'Все найденные подъезды с привязкой', 'Нет найденных привязок по подъездам', 'Частичное покрытие подъездов'];
const T_QM = ['Совпало по UUID адреса', 'Не найдено агрегата по UUID адреса', 'Нет подъезда в реестре: статистика не распределяется',
  'Совпало по UUID подъезда', 'UUID подъезда + уникальный номер (номер проверять)', 'Только уникальный номер подъезда (условно)',
  'Нет UUID-агрегата; номер неизвестен', 'Нет агрегата по UUID подъезда'];
const T_ST = ['Нет данных о подъездах', 'Адрес неактуален; настройки подъезда справочно', 'Актуальность адреса неизвестна',
  'Не последняя версия подъезда (при наличии is_last)', 'Подъезд неактуален (при наличии actual)', 'Есть настройка обслуживания',
  'Нет найденной привязки обслуживания'];
const T_BS = ['Все подъезды; Конкретный подъезд', 'Все подъезды', 'Конкретный подъезд'];
const T_HT = ['Жилое', 'Нежилое', 'Категория не установлена'];

function enc(v, table) {
  if (v === '' || v === undefined || v === null) return undefined;
  const i = table.indexOf(v);
  return i === -1 ? v : i;
}
function dec(v, table) {
  if (v === undefined || v === null) return '';
  return typeof v === 'number' ? table[v] : v;
}

export function htNorm(v) {
  const s = String(v || '').trim().toLowerCase().replace(/ё/g, 'е');
  if (s === 'жилое') return 'жилое';
  if (s === 'нежилое') return 'нежилое';
  return s ? 'other' : '';
}

const ZERO_Q = () => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const isZero = (q) => !q || q.every((x) => x === 0);

/** Запись дома → объект для IndexedDB. Обязательные: s, r, hs. */
export function packHouse(x) {
  const p = { s: x.s, r: ob(x.r), un: ob(x.un), fi: ob(x.fi), hs: x.hs };
  if (x.ro !== x.r) p.ro = ob(x.ro);
  if (x.i !== x.r) p.i = ob(x.i);
  if (x.ur !== x.un) p.ur = ob(x.ur);
  if (x.fr !== x.fi) p.fr = ob(x.fr);
  if (x.a) p.a = x.a;
  const ht = enc(x.ht, T_HT); if (ht !== undefined) p.ht = ht;
  if (x.af) p.af = x.af;
  p.il = x.il; p.ac = x.ac;
  if (x.ed) p.ed = ob(x.ed);
  p.n = [x.rel, x.org, x.au, x.pd, x.et, x.eat, x.eaf, x.eau, x.el, x.eu];
  if (x.pids) p.pids = ob(x.pids);
  const af = enc(x.allf, T_ALLF); if (af !== undefined) p.allf = af;
  const ct = enc(x.ct, T_CT); if (ct !== undefined) p.ct = ct;
  if (x.q !== undefined) {
    if (!isZero(x.q)) p.q = x.q;
    p.qg = x.qg;
    const qm = enc(x.qm, T_QM); if (qm !== undefined) p.qm = qm;
    if (x.qd) p.qd = ob(x.qd);
    if (x.qu) { if (x.qu === x.ur) p.quSame = 1; else p.qu = ob(x.qu); }
    if (x.qx) p.qx = 1;
  }
  return p;
}

export function unpackHouse(p) {
  if (!p) return p;
  const n = p.n || [];
  const ur = p.ur !== undefined ? p.ur : p.un;
  const x = {
    s: p.s, r: p.r, ro: p.ro !== undefined ? p.ro : p.r, i: p.i !== undefined ? p.i : p.r,
    un: p.un, ur, fi: p.fi, fr: p.fr !== undefined ? p.fr : p.fi, a: p.a || '',
    ht: dec(p.ht, T_HT), htn: htNorm(dec(p.ht, T_HT)), af: p.af || '', il: p.il, ac: p.ac, ed: p.ed || '',
    rel: n[0], org: n[1], au: n[2], pd: n[3], pids: p.pids || '', allf: dec(p.allf, T_ALLF),
    et: n[4], eat: n[5], eaf: n[6], eau: n[7], el: n[8], eu: n[9], ct: dec(p.ct, T_CT),
  };
  if (p.qg !== undefined) {
    x.q = p.q || ZERO_Q();
    x.qd = p.qd || '';
    x.qm = dec(p.qm, T_QM);
    x.qg = p.qg;
    x.qu = p.qu !== undefined ? p.qu : p.quSame ? ur : '';
    x.qx = !!p.qx;
  }
  x.hs = p.hs;
  return x;
}

/** Без служебных полей — для хэша изменений (совпадает до и после pack/unpack). */
export function houseForHash(x) {
  const { s, hs, htn, ...rest } = x;
  return rest;
}

/** Подъезды одного дома → одна запись. list — объекты из entranceReader/mergeEntrance (без заглушек). */
export function packEntrances(s, h, list) {
  return {
    s, h: ob(h),
    L: list.map((e) => [ob(e.e), e.lb, ob(e.eil), ob(e.eac), enc(e.st, T_ST) ?? '', e.rel, e.org, e.pd, ob(e.pids) || '',
      enc(e.bs, T_BS) ?? '', isZero(e.q) ? 0 : e.q, ob(e.qd) || '', enc(e.qm, T_QM) ?? '', e.qg || 0, e.qx ? 1 : 0]),
  };
}

export function unpackEntrances(p) {
  if (!p) return [];
  return p.L.map((t) => ({
    h: p.h, e: t[0], lb: t[1], num: !(!t[1] || String(t[1]).startsWith('[ID подъезда:')), eil: t[2], eac: t[3],
    st: dec(t[4] === '' ? undefined : t[4], T_ST), rel: t[5], org: t[6], pd: t[7], pids: t[8], bs: dec(t[9] === '' ? undefined : t[9], T_BS),
    q: t[10] === 0 ? ZERO_Q() : t[10], qd: t[11], qm: dec(t[12] === '' ? undefined : t[12], T_QM), qg: t[13], qx: !!t[14],
  }));
}
