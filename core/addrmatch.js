// Поиск координат домов МЖИ по адресам зданий OpenStreetMap (файл data/local/osm/moscow_addresses.json).
// Улица сравнивается как набор слов без учёта порядка и сокращений («Бочвара Академика ул.» =
// «улица Академика Бочвара», «Митинский 3-й пер.» = «3-й Митинский переулок»), номер дома — точно
// (дом, корпус, строение). Если подходят несколько зданий в разных местах, дом не привязывается.

const TYPE = new Map(Object.entries({
  ул: 'улица', улица: 'улица',
  пер: 'переулок', переулок: 'переулок',
  просп: 'проспект', 'пр-т': 'проспект', 'пр-кт': 'проспект', проспект: 'проспект',
  пр: 'проезд', 'пр-д': 'проезд', проезд: 'проезд',
  'б-р': 'бульвар', бульв: 'бульвар', бульвар: 'бульвар',
  ш: 'шоссе', шоссе: 'шоссе',
  наб: 'набережная', набережная: 'набережная',
  пл: 'площадь', площадь: 'площадь',
  туп: 'тупик', тупик: 'тупик',
  ал: 'аллея', аллея: 'аллея',
  мкр: 'микрорайон', мкрн: 'микрорайон', микрорайон: 'микрорайон',
  'кв-л': 'квартал', квартал: 'квартал',
  лин: 'линия', линия: 'линия',
}));
const TYPE_WORDS = new Set(TYPE.values());
// Слова, которые обозначают населённый пункт или регион и не входят в название улицы
const SETTLEMENT = new Set(['г', 'город', 'гор', 'пос', 'поселок', 'п', 'рп', 'дп', 'кп', 'дер', 'деревня', 'сел', 'село',
  'снт', 'днп', 'тер', 'территория', 'поселение', 'москва', 'российская', 'федерация']);
const ORDINAL = /^(\d+)-?(?:й|я|е|ой|ая|ое|ый|ий|го|му)$/;

const lowerYo = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

function tokens(s) {
  return lowerYo(s).replace(/[«»"'“”„()]/g, ' ').split(/[\s,]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .map((t) => {
      const m = t.match(ORDINAL);
      if (m) return String(Number(m[1]));
      return TYPE.get(t) || t;
    });
}

/** Название улицы или населённого пункта → ключ: слова по алфавиту, без сокращений и слов-типов поселений. */
export function streetBag(s, { dropType = false } = {}) {
  const t = tokens(s).filter((x) => !SETTLEMENT.has(x) && (!dropType || !TYPE_WORDS.has(x)));
  return [...new Set(t)].sort().join(' ');
}

export function placeTokens(s) {
  return tokens(s).filter((x) => !SETTLEMENT.has(x) && !TYPE_WORDS.has(x));
}

/** Номер дома в одном виде: «76 к4», «76, корп. 4», «76к4» → «76к4»; «5/20 стр. 1» → «5/20с1». */
export function normHn(v) {
  return lowerYo(v).replace(/\s+/g, '')
    .replace(/корпус|корп\.?/g, 'к').replace(/строение|стр\.?/g, 'с').replace(/литера|лит\.?/g, '')
    .replace(/[.,]/g, '');
}

/**
 * Адрес МЖИ → { street, qualifier, keys } — улица, уточнение в скобках и варианты номера дома.
 * Поддерживаются формы БТИ («Лескова ул., д.5, к.2»), ГАР («Российская Федерация, город Москва, …, дом 4,
 * корпус 1») и Зеленоград («Зеленоград, к.418»).
 */
export function parseAddress(address) {
  let s = String(address || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^Российская Федерация,\s*/i, '').replace(/^(?:город|г\.)\s*Москва,\s*/i, '')
    .replace(/внутригородская территория[^,]*,\s*/gi, '')
    .replace(/\s+(?:д\.|дом)\s*(?=\d)/i, ', д.'); // «Ватутинская 3-я ул. д. 6»
  let house = '';
  let korp = '';
  let stroy = '';
  const rest = [];
  for (const raw of s.split(',')) {
    const p = raw.trim();
    if (!p) continue;
    let m;
    if ((m = p.match(/^(?:дом|д\.)\s*(\d\S*)$/i) || p.match(/^д(\d\S*)$/i))) house = m[1];
    else if ((m = p.match(/^(?:владение|влд\.?|вл\.)\s*(\d\S*)$/i))) house = m[1];
    else if ((m = p.match(/^(?:корпус|корп\.?|к\.)\s*([\dа-яёa-z][\dа-яёa-z/-]{0,7})$/i) || p.match(/^к(\d\S{0,6})$/i))) korp = m[1];
    else if ((m = p.match(/^(?:строение|стр\.?|с\.)\s*(\d\S*)$/i))) stroy = m[1];
    else rest.push(p);
  }
  let street = rest.join(' ');
  const qualifier = [...street.matchAll(/\(([^)]*)\)/g)].map((x) => x[1]).join(' ');
  street = street.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const h = normHn(house);
  const k = normHn(korp);
  const c = normHn(stroy);
  const keys = [];
  if (h) {
    keys.push(`${h}${k ? `к${k}` : ''}${c ? `с${c}` : ''}`);
    if (k && /^[а-яa-z]$/.test(k)) keys.push(`${h}${k}${c ? `с${c}` : ''}`); // «д.5, к.А» = «5А»
  } else if (k) {
    keys.push(k, `к${k}`); // Зеленоград: корпус и есть номер дома
  }
  return { street, qualifier, keys };
}

const dist = (a, b) => {
  const dx = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180) * 111320;
  const dy = (a.lat - b.lat) * 110540;
  return Math.hypot(dx, dy);
};
const SAME_PLACE_M = 150;

/** Индекс адресов OSM. rows: [type, street, housenumber, place, city, lat, lon]. */
export function buildIndex(rows) {
  return addRows({ strict: new Map(), loose: new Map(), size: 0 }, rows);
}

/** Добавить адреса в индекс (части справочника приходят по мере скачивания). */
export function addRows(index, rows) {
  const { strict, loose } = index;
  const add = (map, key, e) => {
    const list = map.get(key);
    if (list) list.push(e); else map.set(key, [e]);
  };
  for (const r of rows) {
    const [t, street, hn, place, city, lat, lon] = r;
    const where = street || place || (lowerYo(city) === 'москва' ? '' : city);
    if (!where || !hn) continue;
    const e = { t, lat: Number(lat), lon: Number(lon), city: placeTokens(`${city || ''} ${street ? place || '' : ''}`) };
    const bag = streetBag(where);
    const bagLoose = streetBag(where, { dropType: true });
    if (!bag) continue;
    for (const part of String(hn).split(';')) {
      const n = normHn(part);
      if (!n) continue;
      const variants = [n];
      if (!street && /^к\d/.test(n)) variants.push(n.slice(1)); // Зеленоград: «к418» и «418»
      for (const v of variants) {
        add(strict, `${bag}|${v}`, e);
        if (bagLoose && bagLoose !== bag) add(loose, `${bagLoose}|${v}`, e);
      }
    }
  }
  index.size += rows.length;
  return index;
}

function clustered(list) {
  return list.every((c) => dist(c, list[0]) <= SAME_PLACE_M);
}

function best(list) {
  return list.find((c) => c.t === 'w' || c.t === 'r') || list[0];
}

function choose(cands, qualifier) {
  const uniq = [...new Set(cands)];
  if (clustered(uniq)) return best(uniq);
  const q = new Set(placeTokens(qualifier));
  if (q.size) {
    const byQ = uniq.filter((c) => c.city.some((x) => q.has(x)));
    if (byQ.length && clustered(byQ)) return best(byQ);
  }
  const proper = uniq.filter((c) => !c.city.length);
  if (proper.length && clustered(proper)) return best(proper);
  return null;
}

/**
 * Найти координаты адреса МЖИ.
 * @returns {{status: 'ok'|'ambiguous'|'notfound'|'unparsed', lat?, lon?, exact?, type?, n?}}
 */
export function matchAddress(index, address) {
  return matchPrepared(index, prepareAddress(address));
}

/** Разобранный адрес для многократного поиска (справочник приходит частями, адрес разбирается один раз). */
export function prepareAddress(address) {
  const p = parseAddress(address);
  return { bag: streetBag(p.street), bagLoose: streetBag(p.street, { dropType: true }), keys: p.keys, qualifier: p.qualifier };
}

export function matchPrepared(index, p) {
  const { bag, bagLoose } = p;
  if (!bag || !p.keys.length) return { status: 'unparsed' };
  // Без типа улицы ищем, только если тип в адресе был: «Щапово пос.» не должен совпасть с «улицей Щапово»
  const tiers = [[index.strict, bag, true], [index.loose, bagLoose !== bag ? bagLoose : '', false]];
  for (const [map, b, exact] of tiers) {
    if (!b) continue;
    const cands = p.keys.flatMap((k) => map.get(`${b}|${k}`) || []);
    if (!cands.length) continue;
    const c = choose(cands, p.qualifier);
    if (c) return { status: 'ok', lat: c.lat, lon: c.lon, exact, type: c.t };
    return { status: 'ambiguous', n: cands.length };
  }
  return { status: 'notfound' };
}
