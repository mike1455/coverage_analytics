# -*- coding: utf-8 -*-
"""Адресный реестр объектов недвижимости города Москвы (портал открытых данных data.mos.ru).

Координаты домов берутся точно по UNOM, без разбора адреса: у каждого здания в реестре есть
UNOM, центр (geodata_center) и контур (geoData). Записи читаются через API apidata.mos.ru
страницами по 1000; нужен бесплатный ключ API портала (личный кабинет на data.mos.ru).
Ключ хранится только на этом компьютере в config/geocoder.local.json.
Результат: data/local/mos_registry.json (UNOM, широта, долгота; контуры для домов реестра МЖИ).
"""
import datetime as dt
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETTINGS = ROOT / "config" / "geocoder.local.json"
OUTPUT = ROOT / "data" / "local" / "mos_registry.json"
API = "https://apidata.mos.ru/v1"
DATASET = 60562  # «Адресный реестр объектов недвижимости города Москвы»
PAGE = 1000
USER_AGENT = "coverage-analytics/1.0"


class RegistryError(Exception):
    pass


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(str(tmp), str(path))


def load_settings(path=SETTINGS):
    s = read_json(path, {})
    return {"mosKey": str(s.get("mosKey") or ""), "mosDataset": int(s.get("mosDataset") or DATASET)}


def save_settings(data, path=SETTINGS):
    cur = read_json(path, {})  # там же ключ Яндекса, его не трогаем
    if "mosKey" in data:
        key = str(data.get("mosKey") or "").strip()
        if key and not re.fullmatch(r"[A-Za-z0-9-]{8,64}", key):
            raise ValueError("Ключ API data.mos.ru выглядит неверно: ожидаются латинские буквы, цифры и дефисы")
        cur["mosKey"] = key
    if data.get("mosDataset"):
        cur["mosDataset"] = int(data["mosDataset"])
    write_json(path, cur)
    return load_settings(path)


def public_state(settings_path=SETTINGS, out=OUTPUT):
    s = load_settings(settings_path)
    st = {"hasKey": bool(s["mosKey"]), "keyTail": s["mosKey"][-4:] if s["mosKey"] else "", "dataset": s["mosDataset"],
          "exists": Path(out).is_file(), "url": "data/local/" + Path(out).name}
    if st["exists"]:
        p = Path(out)
        st["mtime"] = int(p.stat().st_mtime * 1000)
        st["size"] = p.stat().st_size
        try:
            with open(p, "r", encoding="utf-8") as f:
                head = f.read(300)
            for key in ("downloadedAt", "count"):
                i = head.find('"%s":' % key)
                if i >= 0:
                    st[key] = json.loads(head[i + len(key) + 3:].split(",", 1)[0])
        except (OSError, ValueError):
            pass
    return st


def norm_unom(v):
    s = re.sub(r"\D", "", str(v if v is not None else ""))
    return s.lstrip("0") or ("0" if s else "")


def centroid(geom):
    """Центр контура (площадной, по внешнему кольцу самого большого полигона)."""
    if not geom:
        return None
    t, c = geom.get("type"), geom.get("coordinates")
    if t == "Point":
        return c[1], c[0]
    polys = [c] if t == "Polygon" else c if t == "MultiPolygon" else []
    best, area_best = None, 0.0
    for poly in polys:
        ring = poly[0]
        x0, y0 = ring[0][0], ring[0][1]
        a = cx = cy = 0.0
        for (x1, y1), (x2, y2) in zip(ring, ring[1:]):
            x1, y1, x2, y2 = x1 - x0, y1 - y0, x2 - x0, y2 - y0
            f = x1 * y2 - x2 * y1
            a += f
            cx += (x1 + x2) * f
            cy += (y1 + y2) * f
        if abs(a) > area_best:
            area_best = abs(a)
            best = (cy / (3 * a) + y0, cx / (3 * a) + x0) if a else (y0, x0)
    return best


def parse_geo(v):
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except ValueError:
            return None
    return v if isinstance(v, dict) and v.get("type") else None


def parse_item(item):
    """Запись API (features: {properties: {Attributes}, geometry} или rows: {Cells}) → (unom, lat, lon, контур)."""
    props = item.get("properties") or {}
    attrs = props.get("Attributes") or item.get("Cells") or props or item
    unom = norm_unom(attrs.get("UNOM") or attrs.get("unom"))
    if not unom:
        return None
    shape = parse_geo(attrs.get("geoData")) or parse_geo(item.get("geometry"))
    center = parse_geo(attrs.get("geodata_center"))
    ll = centroid(center) if center else centroid(shape)
    if not ll:
        return None
    lat, lon = ll
    if not (55.0 <= lat <= 56.2 and 36.6 <= lon <= 38.2):
        return None
    building = shape if shape and shape.get("type") in ("Polygon", "MultiPolygon") else None
    return unom, round(lat, 7), round(lon, 7), building


def api_get(url, timeout=120):
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise RegistryError("Портал data.mos.ru отклонил ключ API (HTTP %d). Проверьте ключ." % e.code)
            if e.code == 404:
                raise RegistryError("Набор данных не найден (HTTP 404). Проверьте номер набора в настройках.")
            last = "HTTP %d" % e.code
        except (OSError, ValueError) as e:
            last = str(e)
        time.sleep(3 * (attempt + 1))
    raise RegistryError("Нет связи с apidata.mos.ru: %s" % last)


def download(progress, unoms=(), settings_path=SETTINGS, out=OUTPUT, base=None, pause=0.3):
    """Прочитать реестр целиком: точки всех зданий, контуры только для UNOM из реестра МЖИ."""
    now = lambda: dt.datetime.now().astimezone().isoformat(timespec="seconds")  # noqa: E731
    progress.cancel.clear()
    s = load_settings(settings_path)
    want = {norm_unom(u) for u in unoms if norm_unom(u)}
    base = (base or os.environ.get("MCA_MOSDATA_URL") or API).rstrip("/")
    progress.set(state="running", stage="Адресный реестр Москвы", done=0, total=0, message="", started=now(), finished=None)
    progress.extra.update(records=0, found=0, wanted=len(want))
    try:
        if not s["mosKey"]:
            raise RegistryError("Не указан ключ API портала data.mos.ru.")
        q = lambda extra: "%s/datasets/%d/%s?%s" % (base, s["mosDataset"], extra[0], urllib.parse.urlencode({"api_key": s["mosKey"], **extra[1]}))  # noqa: E731
        total = int(api_get(q(("count", {}))))
        progress.set(total=total)
        points, shapes = {}, {}
        skip = 0
        while skip < total:
            progress.check()
            page = api_get(q(("features", {"$top": PAGE, "$skip": skip})))
            items = page.get("features") if isinstance(page, dict) else page
            if not items:
                break
            for it in items:
                r = parse_item(it)
                if not r:
                    continue
                unom, lat, lon, building = r
                points[unom] = [lat, lon]
                if unom in want and building:
                    shapes[unom] = building
            skip += len(items)
            progress.extra.update(records=skip, found=len(want & points.keys()) if want else len(points))
            progress.set(done=min(skip, total), stage="Адресный реестр Москвы: %d из %d записей" % (min(skip, total), total))
            if pause:
                time.sleep(pause)
        if not points:
            raise RegistryError("В ответе портала нет записей с UNOM и координатами.")
        write_json(out, {"format": "mos-registry", "downloadedAt": now(), "count": len(points), "dataset": s["mosDataset"],
                         "source": "Адресный реестр объектов недвижимости города Москвы, data.mos.ru",
                         "points": points, "shapes": shapes})
        progress.set(state="done", stage="Готово", finished=now())
    except Exception as e:  # noqa: BLE001 - сообщение показывается в приложении
        cancelled = progress.cancel.is_set()
        progress.set(state="cancelled" if cancelled else "error", stage="",
                     message="Загрузка отменена, прежние данные не изменились." if cancelled else str(e), finished=now())
