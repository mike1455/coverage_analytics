// Справочник 12 административных округов Москвы и нормализация названий округов/районов.
// Схема `grid` - раскладка плиток ровной сеткой 4 x 3 (не в масштабе): девять «старых» округов стоят как на карте,
// Зеленоградский, Новомосковский и Троицкий - отдельным столбцом слева.

export const OKRUGS = [
  { code: 'ЦАО', name: 'Центральный', full: 'Центральный административный округ', grid: [2, 1] },
  { code: 'САО', name: 'Северный', full: 'Северный административный округ', grid: [2, 0] },
  { code: 'СВАО', name: 'Северо-Восточный', full: 'Северо-Восточный административный округ', grid: [3, 0] },
  { code: 'ВАО', name: 'Восточный', full: 'Восточный административный округ', grid: [3, 1] },
  { code: 'ЮВАО', name: 'Юго-Восточный', full: 'Юго-Восточный административный округ', grid: [3, 2] },
  { code: 'ЮАО', name: 'Южный', full: 'Южный административный округ', grid: [2, 2] },
  { code: 'ЮЗАО', name: 'Юго-Западный', full: 'Юго-Западный административный округ', grid: [1, 2] },
  { code: 'ЗАО', name: 'Западный', full: 'Западный административный округ', grid: [1, 1] },
  { code: 'СЗАО', name: 'Северо-Западный', full: 'Северо-Западный административный округ', grid: [1, 0] },
  { code: 'ЗелАО', name: 'Зеленоградский', full: 'Зеленоградский административный округ', grid: [0, 0] },
  { code: 'НАО', name: 'Новомосковский', full: 'Новомосковский административный округ', grid: [0, 1] },
  { code: 'ТАО', name: 'Троицкий', full: 'Троицкий административный округ', grid: [0, 2] },
];

export const OKRUG_CODES = OKRUGS.map((o) => o.code);
export const NO_OKRUG = 'Без округа';

const okrugIndex = new Map();
for (const o of OKRUGS) {
  for (const v of [o.code, o.name, o.full, o.full.replace('административный ', '')]) {
    okrugIndex.set(simplify(v), o.code);
  }
}
// Частые варианты написания
okrugIndex.set(simplify('ЗЕЛАО'), 'ЗелАО');
okrugIndex.set(simplify('Зеленоград'), 'ЗелАО');
okrugIndex.set(simplify('Новомосковский и Троицкий'), '');

function simplify(s) {
  return String(s || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[«»"'.]/g, '').replace(/\s+/g, ' ');
}

/** Код округа по любому написанию; '' - если округ не распознан. */
export function normOkrug(v) {
  const s = simplify(v);
  if (!s) return '';
  if (okrugIndex.has(s)) return okrugIndex.get(s);
  const noWord = removePhrases(s, ['административный', 'округ']);
  if (okrugIndex.has(noWord)) return okrugIndex.get(noWord);
  return '';
}

/** Ключ района/поселения для сопоставления с внешними границами (OSM и др.). */
const AREA_NOISE = [
  'внутригородское муниципальное образование', 'внутригородская территория', 'города федерального значения',
  'муниципальный округ', 'городской округ', 'города москвы', 'поселение', 'район', 'город', 'г',
];

export function areaKey(v) {
  return removePhrases(simplify(v).replace(/[()]/g, ' ').replace(/-/g, ' '), AREA_NOISE);
}

// \b в JS не работает с кириллицей, поэтому удаляем фразы по границам пробелов.
function removePhrases(s, phrases) {
  let out = ` ${s.replace(/\s+/g, ' ')} `;
  for (const p of phrases) {
    const needle = ` ${p} `;
    while (out.includes(needle)) out = out.replace(needle, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function okrugByCode(code) {
  return OKRUGS.find((o) => o.code === code) || null;
}
