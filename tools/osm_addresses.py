# -*- coding: utf-8 -*-
"""Адреса зданий Москвы из OpenStreetMap для геокодирования домов реестра МЖИ.

Через Overpass API скачиваются все здания и адресные точки Москвы с номером дома
(улица, номер, населённый пункт, координаты центра) и сохраняются одним файлом
data/local/osm/moscow_addresses.json. Дальше координаты домов находятся в приложении
по этому файлу, без запроса на каждый адрес. Москва делится на квадраты, чтобы
каждый запрос был небольшим; при ошибке сервера запрос повторяется на зеркалах.

Данные © участники OpenStreetMap, лицензия ODbL.
"""
import datetime as dt
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "local" / "osm" / "moscow_addresses.json"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
USER_AGENT = "coverage-analytics/1.0 (local address lookup)"
# Москва с ТиНАО и Зеленоградом: юг, запад, север, восток
MOSCOW_BBOX = (55.13, 36.80, 56.03, 37.97)
GRID = (4, 4)
FIELDS = ["type", "street", "housenumber", "place", "city", "lat", "lon"]
MIN_COUNT = 1000  # в Москве адресов на два порядка больше: меньше значит, что ответ неполный


class AddressError(Exception):
    pass


class TooBig(AddressError):
    """Сервер не успел обработать квадрат: его нужно разделить на части."""


def overpass_query(bbox):
    s, w, n, e = bbox
    b = "%.5f,%.5f,%.5f,%.5f" % (s, w, n, e)
    return (
        '[out:json][timeout:240][maxsize:536870912];'
        'area["ISO3166-2"="RU-MOW"]["admin_level"="4"]->.a;'
        '(way["building"]["addr:housenumber"](area.a)(%s);'
        'relation["building"]["addr:housenumber"](area.a)(%s););'
        'out tags center;'
        'node["addr:housenumber"](area.a)(%s);'
        'out body;' % (b, b, b)
    )


def split_bbox(bbox, nx, ny):
    s, w, n, e = bbox
    dy, dx = (n - s) / ny, (e - w) / nx
    return [(s + j * dy, w + i * dx, s + (j + 1) * dy, w + (i + 1) * dx) for j in range(ny) for i in range(nx)]


def parse_elements(data):
    """Ответ Overpass (JSON) → строки [type, street, housenumber, place, city, lat, lon]."""
    if not isinstance(data, dict) or "elements" not in data:
        raise AddressError("Overpass вернул ответ неизвестного формата")
    remark = str(data.get("remark") or "")
    if "error" in remark.lower():
        low = remark.lower()
        cls = TooBig if ("timed out" in low or "out of memory" in low or "maxsize" in low) else AddressError
        raise cls("Overpass: %s" % remark.strip()[:300])
    rows = {}
    for el in data["elements"]:
        tags = el.get("tags") or {}
        hn = (tags.get("addr:housenumber") or "").strip()
        if not hn:
            continue
        if el.get("type") == "node":
            lat, lon = el.get("lat"), el.get("lon")
        else:
            c = el.get("center") or {}
            lat, lon = c.get("lat"), c.get("lon")
        if lat is None or lon is None:
            continue
        key = "%s/%s" % (el.get("type"), el.get("id"))
        rows[key] = [(el.get("type") or "?")[0], (tags.get("addr:street") or "").strip(), hn,
                     (tags.get("addr:place") or tags.get("addr:suburb") or "").strip(),
                     (tags.get("addr:city") or "").strip(), round(float(lat), 7), round(float(lon), 7)]
    return rows


class Overpass:
    def __init__(self, endpoints=None, timeout=300, pause=1.0):
        self.endpoints = list(endpoints or ENDPOINTS)
        self.timeout = timeout
        self.pause = pause
        self.used = ""

    def run(self, query, progress=None):
        last = None
        # рабочее зеркало становится первым, чтобы следующие квадраты шли сразу туда
        for attempt in range(3):
            for url in list(self.endpoints):
                if progress:
                    progress.check()
                body = urllib.parse.urlencode({"data": query}).encode("utf-8")
                req = urllib.request.Request(url, data=body, headers={
                    "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"})
                try:
                    with urllib.request.urlopen(req, timeout=self.timeout) as r:
                        data = json.loads(r.read().decode("utf-8"))
                    rows = parse_elements(data)
                    self.used = url
                    self.endpoints.remove(url)
                    self.endpoints.insert(0, url)
                    return rows
                except TooBig:
                    self.endpoints.remove(url)
                    self.endpoints.insert(0, url)  # сервер рабочий, просто квадрат велик
                    raise
                except urllib.error.HTTPError as e:
                    last = "%s: HTTP %d" % (url, e.code)
                except AddressError as e:
                    last = "%s: %s" % (url, e)
                except (OSError, ValueError) as e:
                    last = "%s: %s" % (url, e)
            time.sleep(self.pause * (10 * (attempt + 1)))
        raise AddressError("Overpass API недоступен (%s). Проверьте доступ в интернет или повторите позже." % last)


def download(progress, out=OUTPUT, endpoints=None, bbox=MOSCOW_BBOX, grid=GRID, pause=1.0, min_count=None):
    """Фоновая задача для serve.py: скачать адреса по квадратам, записать файл целиком в конце."""
    out = Path(out)
    progress.cancel.clear()
    now = lambda: dt.datetime.now().astimezone().isoformat(timespec="seconds")  # noqa: E731
    queue = [(c, 0) for c in split_bbox(bbox, *grid)]
    progress.set(state="running", stage="Запрос адресов OpenStreetMap", done=0, total=len(queue), message="",
                 started=now(), finished=None)
    api = Overpass(endpoints, pause=pause)
    rows = {}
    done = 0
    try:
        while queue:
            progress.check()
            cell, depth = queue.pop(0)
            progress.set(stage="Адреса OpenStreetMap: часть %d из %d" % (done + 1, done + 1 + len(queue)))
            try:
                rows.update(api.run(overpass_query(cell), progress))
            except TooBig:
                if depth >= 2:
                    raise
                queue[0:0] = [(c, depth + 1) for c in split_bbox(cell, 2, 2)]
                progress.set(total=done + len(queue))
                continue
            done += 1
            progress.extra["addresses"] = len(rows)
            progress.set(done=done, total=done + len(queue))
            if pause and queue:
                time.sleep(pause)  # бережём общий сервер
        if len(rows) < (MIN_COUNT if min_count is None else min_count):
            raise AddressError("Overpass вернул слишком мало адресов (%d). Повторите позже." % len(rows))
        progress.set(stage="Сохранение")
        out.parent.mkdir(parents=True, exist_ok=True)
        doc = {"format": "osm-addresses", "version": 1, "downloadedAt": now(), "endpoint": api.used,
               "source": "© участники OpenStreetMap (ODbL), Overpass API", "count": len(rows),
               "fields": FIELDS, "rows": list(rows.values())}
        tmp = out.with_name(out.name + ".tmp")
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(str(tmp), str(out))
        progress.set(state="done", stage="Готово", finished=now())
        return doc
    except Exception as e:  # noqa: BLE001 - сообщение показывается в приложении
        cancelled = progress.cancel.is_set()
        progress.set(state="cancelled" if cancelled else "error", stage="",
                     message="Загрузка отменена, прежний справочник не изменился." if cancelled else str(e), finished=now())
        return None


def status(out=OUTPUT):
    out = Path(out)
    st = {"exists": out.is_file(), "url": "data/local/osm/" + out.name}
    if st["exists"]:
        s = out.stat()
        st.update(size=s.st_size, mtime=int(s.st_mtime * 1000))
        try:
            with open(out, "r", encoding="utf-8") as f:
                head = f.read(400)
            # count и дата лежат в начале файла, весь файл не читаем
            for key in ("downloadedAt", "count"):
                i = head.find('"%s":' % key)
                if i >= 0:
                    v = head[i + len(key) + 3:].split(",", 1)[0]
                    st[key] = json.loads(v)
        except (OSError, ValueError):
            pass
    return st
