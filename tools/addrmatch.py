# -*- coding: utf-8 -*-
"""Сопоставление адресов МЖИ с адресами зданий OpenStreetMap (те же правила, что core/addrmatch.js).

Улица сравнивается как набор слов без учёта порядка и сокращений («Бочвара Академика ул.» =
«улица Академика Бочвара», «Митинский 3-й пер.» = «3-й Митинский переулок»), номер дома точно
(дом, корпус, строение). Если подходят несколько зданий в разных местах, дом не привязывается.
"""
import math
import re

TYPE = {
    "ул": "улица", "улица": "улица",
    "пер": "переулок", "переулок": "переулок",
    "просп": "проспект", "пр-т": "проспект", "пр-кт": "проспект", "проспект": "проспект",
    "пр": "проезд", "пр-д": "проезд", "проезд": "проезд",
    "б-р": "бульвар", "бульв": "бульвар", "бульвар": "бульвар",
    "ш": "шоссе", "шоссе": "шоссе",
    "наб": "набережная", "набережная": "набережная",
    "пл": "площадь", "площадь": "площадь",
    "туп": "тупик", "тупик": "тупик",
    "ал": "аллея", "аллея": "аллея",
    "мкр": "микрорайон", "мкрн": "микрорайон", "микрорайон": "микрорайон",
    "кв-л": "квартал", "квартал": "квартал",
    "лин": "линия", "линия": "линия",
}
TYPE_WORDS = set(TYPE.values())
# Слова, которые обозначают населённый пункт или регион и не входят в название улицы
SETTLEMENT = {"г", "город", "гор", "пос", "поселок", "п", "рп", "дп", "кп", "дер", "деревня", "сел", "село",
              "снт", "днп", "тер", "территория", "поселение", "москва", "российская", "федерация"}
ORDINAL = re.compile(r"^([0-9]+)-?(?:й|я|е|ой|ая|ое|ый|ий|го|му)$")
SAME_PLACE_M = 150


def lower_yo(s):
    return str(s or "").lower().replace("ё", "е")


def tokens(s):
    out = []
    for t in re.split(r"[\s,]+", re.sub(r"[«»\"'“”„()]", " ", lower_yo(s))):
        t = t.strip(".")
        if not t:
            continue
        m = ORDINAL.match(t)
        out.append(str(int(m.group(1))) if m else TYPE.get(t, t))
    return out


def street_bag(s, drop_type=False):
    """Название улицы или населённого пункта → ключ: слова по алфавиту, без сокращений и слов-типов поселений."""
    return " ".join(sorted({x for x in tokens(s) if x not in SETTLEMENT and (not drop_type or x not in TYPE_WORDS)}))


def place_tokens(s):
    return [x for x in tokens(s) if x not in SETTLEMENT and x not in TYPE_WORDS]


def norm_hn(v):
    """Номер дома в одном виде: «76 к4», «76, корп. 4», «76к4» → «76к4»; «5/20 стр. 1» → «5/20с1»."""
    s = re.sub(r"\s+", "", lower_yo(v))
    s = re.sub(r"корпус|корп\.?", "к", s)
    s = re.sub(r"строение|стр\.?", "с", s)
    s = re.sub(r"литера|лит\.?", "", s)
    return re.sub(r"[.,]", "", s)


def parse_address(address):
    """Адрес МЖИ → (улица, уточнение в скобках, варианты номера дома)."""
    s = re.sub(r"\s+", " ", str(address or "")).strip()
    s = re.sub(r"^Российская Федерация,\s*", "", s, flags=re.I)
    s = re.sub(r"^(?:город|г\.)\s*Москва,\s*", "", s, flags=re.I)
    s = re.sub(r"внутригородская территория[^,]*,\s*", "", s, flags=re.I)
    s = re.sub(r"\s+(?:д\.|дом)\s*(?=[0-9])", ", д.", s, count=1, flags=re.I)  # «Ватутинская 3-я ул. д. 6»
    house = korp = stroy = ""
    rest = []
    for raw in s.split(","):
        p = raw.strip()
        if not p:
            continue
        m = re.match(r"^(?:дом|д\.)\s*([0-9]\S*)$", p, re.I) or re.match(r"^д([0-9]\S*)$", p, re.I)
        if m:
            house = m.group(1)
            continue
        m = re.match(r"^(?:владение|влд\.?|вл\.)\s*([0-9]\S*)$", p, re.I)
        if m:
            house = m.group(1)
            continue
        m = re.match(r"^(?:корпус|корп\.?|к\.)\s*([0-9а-яёa-z][0-9а-яёa-z/-]{0,7})$", p, re.I) or re.match(r"^к([0-9]\S{0,6})$", p, re.I)
        if m:
            korp = m.group(1)
            continue
        m = re.match(r"^(?:строение|стр\.?|с\.)\s*([0-9]\S*)$", p, re.I)
        if m:
            stroy = m.group(1)
            continue
        rest.append(p)
    street = " ".join(rest)
    qualifier = " ".join(re.findall(r"\(([^)]*)\)", street))
    street = re.sub(r"\s+", " ", re.sub(r"\([^)]*\)", " ", street)).strip()
    h, k, c = norm_hn(house), norm_hn(korp), norm_hn(stroy)
    keys = []
    if h:
        keys.append(h + ("к" + k if k else "") + ("с" + c if c else ""))
        if k and re.fullmatch(r"[а-яa-z]", k):
            keys.append(h + k + ("с" + c if c else ""))  # «д.5, к.А» = «5А»
    elif k:
        keys += [k, "к" + k]  # Зеленоград: корпус и есть номер дома
    return street, qualifier, keys


def _dist(a, b):
    dx = (a["lon"] - b["lon"]) * math.cos(math.radians(a["lat"])) * 111320
    dy = (a["lat"] - b["lat"]) * 110540
    return math.hypot(dx, dy)


def build_index(rows):
    """Индекс адресов OSM. rows: [type, street, housenumber, place, city, lat, lon]."""
    strict, loose = {}, {}
    for r in rows:
        t, street, hn, place, city, lat, lon = r[:7]
        where = street or place or ("" if lower_yo(city) == "москва" else city)
        if not where or not hn:
            continue
        e = {"t": t, "lat": float(lat), "lon": float(lon),
             "city": place_tokens("%s %s" % (city or "", (place or "") if street else ""))}
        bag = street_bag(where)
        bag_loose = street_bag(where, drop_type=True)
        if not bag:
            continue
        for part in str(hn).split(";"):
            n = norm_hn(part)
            if not n:
                continue
            variants = [n]
            if not street and re.match(r"^к[0-9]", n):
                variants.append(n[1:])  # Зеленоград: «к418» и «418»
            for v in variants:
                strict.setdefault("%s|%s" % (bag, v), []).append(e)
                if bag_loose and bag_loose != bag:
                    loose.setdefault("%s|%s" % (bag_loose, v), []).append(e)
    return {"strict": strict, "loose": loose, "size": len(rows)}


def _clustered(lst):
    return all(_dist(c, lst[0]) <= SAME_PLACE_M for c in lst)


def _best(lst):
    return next((c for c in lst if c["t"] in ("w", "r")), lst[0])


def _choose(cands, qualifier):
    uniq = list({id(c): c for c in cands}.values())
    if _clustered(uniq):
        return _best(uniq)
    q = set(place_tokens(qualifier))
    if q:
        by_q = [c for c in uniq if any(x in q for x in c["city"])]
        if by_q and _clustered(by_q):
            return _best(by_q)
    proper = [c for c in uniq if not c["city"]]
    if proper and _clustered(proper):
        return _best(proper)
    return None


def match_address(index, address):
    """→ {"status": "ok"|"ambiguous"|"notfound"|"unparsed", "lat", "lon", "exact", "type"}."""
    street, qualifier, keys = parse_address(address)
    bag = street_bag(street)
    if not bag or not keys:
        return {"status": "unparsed"}
    bag_loose = street_bag(street, drop_type=True)
    # Без типа улицы ищем, только если тип в адресе был: «Щапово пос.» не должен совпасть с «улицей Щапово»
    for mp, b, exact in ((index["strict"], bag, True), (index["loose"], bag_loose if bag_loose != bag else "", False)):
        if not b:
            continue
        cands = [c for k in keys for c in mp.get("%s|%s" % (b, k), [])]
        if not cands:
            continue
        c = _choose(cands, qualifier)
        if c:
            return {"status": "ok", "lat": c["lat"], "lon": c["lon"], "exact": exact, "type": c["t"]}
        return {"status": "ambiguous", "n": len(cands)}
    return {"status": "notfound"}
