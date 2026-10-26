# -*- coding: utf-8 -*-
"""Границы округов и районов Москвы из OpenStreetMap для заливки карты.

Порядок, рассчитанный на перегруженные публичные серверы:
1. Overpass API (с зеркалами): лёгкий запрос только списка границ (номер, название, уровень);
2. Nominatim: полигоны этих границ пачками по 40 штук (несколько запросов, полигоны уже упрощены);
3. если Nominatim недоступен, полигоны берутся из Overpass и собираются из линий здесь;
4. если недоступен Overpass, границы ищутся в Nominatim по названиям округов и районов.
Результат: data/local/osm/boundaries_okrug.geojson и boundaries_area.geojson.
Данные © участники OpenStreetMap, лицензия ODbL.
"""
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import osm_addresses  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "local" / "osm"
NOMINATIM = "https://nominatim.openstreetmap.org"
USER_AGENT = "coverage-analytics/1.0 (local boundary lookup)"
LEVELS = {"okrug": "5", "area": "8"}
TOLERANCE = 0.0002  # упрощение контура, градусы (около 15 м)
OKRUG_NAMES = ["Центральный", "Северный", "Северо-Восточный", "Восточный", "Юго-Восточный", "Южный", "Юго-Западный",
               "Западный", "Северо-Западный", "Зеленоградский", "Новомосковский", "Троицкий"]
# Районы и поселения Москвы (как в реестре МЖИ) для поиска по названиям, если реестр ещё не загружен
DEFAULT_AREAS = [
    "Академический", "Алексеевский", "Алтуфьевский", "Арбат", "Аэропорт", "Бабушкинский", "Басманный",
    "Беговой", "Бекасово", "Бескудниковский", "Бибирево", "Бирюлево Восточное", "Бирюлево Западное",
    "Богородское", "Братеево", "Бутырский", "Вешняки", "Внуково", "Внуковское", "Войковский", "Вороново",
    "Восточное Дегунино", "Восточное Измайлово", "Восточный", "Выхино-Жулебино", "Гагаринский", "Головинский",
    "Гольяново", "Даниловский", "Десеновское", "Дмитровский", "Донской", "Дорогомилово", "Замоскворечье",
    "Западное Дегунино", "Зюзино", "Зябликово", "Ивановское", "Измайлово", "Капотня", "Киевский", "Кокошкино",
    "Коммунарка", "Коньково", "Коптево", "Косино-Ухтомский", "Котловка", "Краснопахорский", "Красносельский",
    "Крылатское", "Крюково", "Кузьминки", "Кунцево", "Куркино", "Левобережный", "Лефортово", "Лианозово",
    "Ломоносовский", "Лосиноостровский", "Люблино", "Марушкинское", "Марфино", "Марьина Роща", "Марьино",
    "Матушкино", "Метрогородок", "Мещанский", "Митино", "Можайский", "Молжаниновский", "Москворечье-Сабурово",
    "Московский", "Мосрентген", "Нагатино-Садовники", "Нагатинский Затон", "Нагорный", "Некрасовка",
    "Нижегородский", "Ново-Переделкино", "Новогиреево", "Новокосино", "Новофедоровское", "Обручевский",
    "Орехово-Борисово Северное", "Орехово-Борисово Южное", "Останкинский", "Отрадное", "Очаково-Матвеевское",
    "Первомайское", "Перово", "Печатники", "Покровское-Стрешнево", "Преображенское", "Пресненский",
    "Проспект Вернадского", "Раменки", "Ростокино", "Рязановское", "Рязанский", "Савелки", "Савеловский",
    "Свиблово", "Северное Бутово", "Северное Измайлово", "Северное Медведково", "Северное Тушино", "Северный",
    "Силино", "Сокол", "Соколиная Гора", "Сокольники", "Солнцево", "Сосенское", "Старое Крюково", "Строгино",
    "Таганский", "Тверской", "Текстильщики", "Теплый Стан", "Тимирязевский", "Троицк", "Тропарево-Никулино",
    "Филевский Парк", "Фили-Давыдково", "Филимонковский", "Хамовники", "Ховрино", "Хорошево-Мневники",
    "Хорошевский", "Царицыно", "Черемушки", "Чертаново Северное", "Чертаново Центральное", "Чертаново Южное",
    "Щаповское", "Щербинка", "Щукино", "Южное Бутово", "Южное Медведково", "Южное Тушино", "Южнопортовый",
    "Якиманка", "Ярославский", "Ясенево"
]


class BoundaryError(Exception):
    pass


def out_file(kind, out_dir=OUT_DIR):
    return Path(out_dir) / ("boundaries_%s.geojson" % kind)


def http_json(url, data=None, timeout=120):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def overpass(query, endpoints, progress=None):
    last = None
    for attempt in range(3):
        for url in list(endpoints):
            if progress:
                progress.check()
            try:
                data = http_json(url, urllib.parse.urlencode({"data": query}).encode("utf-8"), timeout=200)
                remark = str(data.get("remark") or "")
                if "error" in remark.lower():
                    raise BoundaryError(remark[:200])
                endpoints.remove(url)
                endpoints.insert(0, url)
                return data
            except urllib.error.HTTPError as e:
                last = "%s: HTTP %d" % (url, e.code)
            except (OSError, ValueError, BoundaryError) as e:
                last = "%s: %s" % (url, e)
        time.sleep(5 * (attempt + 1))
    raise BoundaryError("Overpass API недоступен (%s)" % last)


def list_query(level):
    return ('[out:json][timeout:90];area["ISO3166-2"="RU-MOW"]["admin_level"="4"]->.a;'
            'relation(area.a)["boundary"="administrative"]["admin_level"="%s"];out tags;' % level)


def geom_query(level):
    return ('[out:json][timeout:240][maxsize:536870912];area["ISO3166-2"="RU-MOW"]["admin_level"="4"]->.a;'
            'relation(area.a)["boundary"="administrative"]["admin_level"="%s"];out geom;' % level)


# ---------------------------------------------------------------- геометрия

def _sq_seg(p, a, b):
    x, y = a
    dx, dy = b[0] - x, b[1] - y
    if dx or dy:
        t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy)
        if t > 1:
            x, y = b
        elif t > 0:
            x, y = x + dx * t, y + dy * t
    return (p[0] - x) ** 2 + (p[1] - y) ** 2


def simplify(ring, tol=TOLERANCE):
    """Дуглас - Пекер для замкнутого контура; не меньше 4 точек."""
    if len(ring) <= 5:
        return ring
    keep = [False] * len(ring)
    keep[0] = keep[-1] = True
    stack = [(0, len(ring) - 1)]
    sq = tol * tol
    while stack:
        f, l = stack.pop()
        best, idx = 0.0, 0
        for i in range(f + 1, l):
            d = _sq_seg(ring[i], ring[f], ring[l])
            if d > best:
                best, idx = d, i
        if best > sq:
            keep[idx] = True
            stack += [(f, idx), (idx, l)]
    out = [p for p, k in zip(ring, keep) if k]
    return out if len(out) >= 4 else ring


def join_rings(lines):
    """Линии (общие концы) → замкнутые контуры."""
    pool = [list(w) for w in lines if len(w) > 1]
    rings = []
    while pool:
        cur = pool.pop()
        while cur[0] != cur[-1]:
            for i, w in enumerate(pool):
                if w[0] == cur[-1]:
                    cur += w[1:]
                elif w[-1] == cur[-1]:
                    cur += w[-2::-1]
                elif w[-1] == cur[0]:
                    cur = w[:-1] + cur
                elif w[0] == cur[0]:
                    cur = w[::-1][:-1] + cur
                else:
                    continue
                pool.pop(i)
                break
            else:
                break  # контур не замыкается: данные неполные
        if len(cur) >= 4 and cur[0] == cur[-1]:
            rings.append(cur)
    return rings


def point_in_ring(p, ring):
    x, y = p
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def relation_to_geometry(rel):
    outer, inner = [], []
    for m in rel.get("members", []):
        if m.get("type") != "way" or not m.get("geometry"):
            continue
        line = [(round(g["lon"], 6), round(g["lat"], 6)) for g in m["geometry"]]
        (inner if m.get("role") == "inner" else outer).append(line)
    polys = [[simplify(r)] for r in join_rings(outer)]
    for hole in join_rings(inner):
        for poly in polys:
            if point_in_ring(hole[0], poly[0]):
                poly.append(simplify(hole))
                break
    if not polys:
        return None
    coords = [[[list(p) for p in ring] for ring in poly] for poly in polys]
    return {"type": "Polygon", "coordinates": coords[0]} if len(coords) == 1 else {"type": "MultiPolygon", "coordinates": coords}


def feature(name, geometry, osm_id="", level="", source=""):
    return {"type": "Feature", "properties": {"name": name, "osm_id": osm_id, "admin_level": level, "source": source},
            "geometry": geometry}


# ---------------------------------------------------------------- источники полигонов

def _count(progress, kind, **kw):
    """Ход загрузки для приложения: сколько границ в списке, сколько полигонов уже получено и откуда."""
    if progress is not None and kind:
        with progress.lock:
            progress.extra[kind] = {**progress.extra.get(kind, {}), **kw}


def nominatim_lookup(rels, base, email="", progress=None, pause=1.1, kind=""):
    """rels: [{id, name, admin_level}] → признаки с полигонами (пачками по 40 номеров)."""
    out = []
    for i in range(0, len(rels), 40):
        if progress:
            progress.check()
        chunk = rels[i:i + 40]
        q = {"osm_ids": ",".join("R%d" % r["id"] for r in chunk), "format": "geojson", "polygon_geojson": 1,
             "polygon_threshold": TOLERANCE, "accept-language": "ru"}
        if email:
            q["email"] = email
        data = http_json("%s/lookup?%s" % (base, urllib.parse.urlencode(q)), timeout=120)
        names = {r["id"]: r for r in chunk}
        for f in data.get("features", []):
            p = f.get("properties") or {}
            g = f.get("geometry") or {}
            rid = int(p.get("osm_id") or 0)
            if rid in names and g.get("type") in ("Polygon", "MultiPolygon"):
                r = names[rid]
                out.append(feature(r["name"], g, rid, r["admin_level"], "OSM, Nominatim"))
        _count(progress, kind, got=len(out))
        if pause and i + 40 < len(rels):
            time.sleep(pause)
    return out


def nominatim_search(names, prefixes, base, email="", progress=None, pause=1.1, kind=""):
    """Запасной путь без Overpass: граница по названию («район Арбат, Москва» и т. п.)."""
    out, missing = [], []
    for n, name in enumerate(names):
        found = None
        for prefix in prefixes:
            if progress:
                progress.check()
                progress.set(stage="Границы по названиям: %d из %d" % (n + 1, len(names)))
            q = {"q": ("%s %s, Москва" % (prefix, name)).strip(), "format": "geojson", "polygon_geojson": 1,
                 "polygon_threshold": TOLERANCE, "limit": 3, "countrycodes": "ru", "accept-language": "ru",
                 "viewbox": "36.80,56.03,37.97,55.13", "bounded": 1}
            if email:
                q["email"] = email
            data = http_json("%s/search?%s" % (base, urllib.parse.urlencode(q)), timeout=60)
            if pause:
                time.sleep(pause)
            for f in data.get("features", []):
                p = f.get("properties") or {}
                g = f.get("geometry") or {}
                if p.get("category") == "boundary" and p.get("type") == "administrative" and g.get("type") in ("Polygon", "MultiPolygon"):
                    found = feature(name, g, p.get("osm_id", ""), "", "OSM, Nominatim (по названию)")
                    break
            if found:
                break
        if found:
            out.append(found)
        else:
            missing.append(name)
        _count(progress, kind, got=len(out), checked=n + 1)
    return out, missing


def fetch_kind(kind, endpoints, base, names, email, progress, pause):
    level = LEVELS[kind]
    label = "округов" if kind == "okrug" else "районов"
    _count(progress, kind, listed=0, got=0, via="список границ (Overpass)", state="run")
    try:
        progress.set(stage="Список границ %s (Overpass)" % label)
        data = overpass(list_query(level), endpoints, progress)
        rels = [{"id": int(e["id"]), "name": (e.get("tags") or {}).get("name", ""), "admin_level": level}
                for e in data.get("elements", []) if e.get("type") == "relation"]
        if not rels:
            raise BoundaryError("Overpass не вернул границ %s" % label)
    except BoundaryError:
        progress.set(stage="Overpass недоступен, поиск границ %s по названиям (Nominatim)" % label)
        src = ["%s административный округ" % n for n in OKRUG_NAMES] if kind == "okrug" else (names or DEFAULT_AREAS)
        _count(progress, kind, listed=len(src), got=0, via="поиск по названиям (Nominatim)")
        prefixes = [""] if kind == "okrug" else ["район", "поселение", "городской округ", ""]
        feats, _ = nominatim_search(src, prefixes, base, email, progress, pause, kind)
        return feats
    _count(progress, kind, listed=len(rels), got=0, via="полигоны (Nominatim)")
    try:
        progress.set(stage="Полигоны %s (Nominatim)" % label)
        feats = nominatim_lookup(rels, base, email, progress, pause, kind)
        if len(feats) >= len(rels) * 0.8:
            return feats
    except (OSError, ValueError):
        pass
    progress.set(stage="Полигоны %s (Overpass)" % label)
    _count(progress, kind, got=0, via="полигоны (Overpass)")
    data = overpass(geom_query(level), endpoints, progress)
    feats = []
    for e in data.get("elements", []):
        if e.get("type") == "relation":
            g = relation_to_geometry(e)
            if g:
                feats.append(feature((e.get("tags") or {}).get("name", ""), g, e.get("id"), level, "OSM, Overpass"))
    return feats


def download(progress, out_dir=OUT_DIR, areas=None, email="", endpoints=None, nominatim=None, pause=1.1):
    """Фоновая задача для serve.py: границы округов и районов, оба файла."""
    now = lambda: dt.datetime.now().astimezone().isoformat(timespec="seconds")  # noqa: E731
    progress.cancel.clear()
    progress.set(state="running", stage="Подготовка", done=0, total=2, message="", started=now(), finished=None)
    eps = list(endpoints or osm_addresses.ENDPOINTS)
    base = (nominatim or os.environ.get("MCA_NOMINATIM_URL") or NOMINATIM).rstrip("/")
    counts = {}
    try:
        for i, kind in enumerate(("okrug", "area")):
            feats = fetch_kind(kind, eps, base, [a for a in (areas or []) if a], email, progress, pause)
            _count(progress, kind, got=len(feats), state="ok")
            if not feats:
                raise BoundaryError("Не удалось получить границы %s" % ("округов" if kind == "okrug" else "районов"))
            doc = {"type": "FeatureCollection", "features": feats,
                   "properties": {"kind": kind, "downloadedAt": now(), "source": "© участники OpenStreetMap (ODbL)"}}
            path = out_file(kind, out_dir)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name(path.name + ".tmp")
            tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            os.replace(str(tmp), str(path))
            counts[kind] = len(feats)
            progress.set(done=i + 1)
        progress.set(state="done", stage="Готово", message="Округов: %d, районов: %d" % (counts["okrug"], counts["area"]), finished=now())
    except Exception as e:  # noqa: BLE001 - сообщение показывается в приложении
        cancelled = progress.cancel.is_set()
        progress.set(state="cancelled" if cancelled else "error", stage="",
                     message="Загрузка отменена." if cancelled else str(e), finished=now())


def status(out_dir=OUT_DIR):
    st = {}
    for kind in ("okrug", "area"):
        p = out_file(kind, out_dir)
        st[kind] = {"exists": p.is_file(), "url": "data/local/osm/" + p.name}
        if p.is_file():
            st[kind]["mtime"] = int(p.stat().st_mtime * 1000)
    return st
