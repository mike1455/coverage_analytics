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
import shutil
import socket
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
GRID = (8, 8)  # мелкие части отвечают быстро даже в плотном центре
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
        '[out:json][timeout:60][maxsize:536870912];'
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
    def __init__(self, endpoints=None, timeout=90, pause=1.0):
        self.endpoints = list(endpoints or ENDPOINTS)
        self.timeout = timeout
        self.pause = pause
        self.used = ""

    def _first(self, url):
        self.endpoints.remove(url)
        self.endpoints.insert(0, url)  # рабочее зеркало первым: следующие части сразу туда

    def run(self, query, progress=None):
        """Один проход по зеркалам. Если все отвечают слишком долго, часть велика: её делят, а не ждут повторно."""
        last = None
        timeouts = 0
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
                self._first(url)
                return rows
            except TooBig:
                self._first(url)
                raise
            except urllib.error.HTTPError as e:
                last = "%s: HTTP %d" % (url, e.code)
                if e.code == 429 and self.pause:
                    time.sleep(15 * self.pause)  # сервер просит подождать
            except socket.timeout:
                timeouts += 1
                last = "%s: нет ответа за %d с" % (url, self.timeout)
            except urllib.error.URLError as e:
                if isinstance(e.reason, socket.timeout):
                    timeouts += 1
                last = "%s: %s" % (url, e.reason)
            except (AddressError, OSError, ValueError) as e:
                last = "%s: %s" % (url, e)
        if timeouts == len(self.endpoints):
            raise TooBig(last)
        raise AddressError("Overpass API недоступен (%s)" % last)


def cell_key(cell):
    return "_".join("%.4f" % v for v in cell)


def write_json_atomic(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(str(tmp), str(path))


def download(progress, out=OUTPUT, endpoints=None, bbox=MOSCOW_BBOX, grid=GRID, pause=1.0, min_count=None, fresh=False, timeout=90):
    """Фоновая задача для serve.py. Каждая полученная часть сразу пишется в osm/parts/<ключ>.json:
    приложение показывает найденные дома, не дожидаясь конца, а после обрыва докачиваются только
    недостающие части. В конце части собираются в moscow_addresses.json."""
    out = Path(out)
    parts_dir = out.parent / "parts"
    progress.cancel.clear()
    now = lambda: dt.datetime.now().astimezone().isoformat(timespec="seconds")  # noqa: E731
    if fresh and parts_dir.is_dir():
        shutil.rmtree(str(parts_dir), ignore_errors=True)
    parts_dir.mkdir(parents=True, exist_ok=True)
    have = {p.stem for p in parts_dir.glob("*.json")}
    split = {p.stem for p in parts_dir.glob("*.split")}
    rows = {}
    for k in sorted(have):  # части прошлого запуска
        try:
            rows.update(json.loads((parts_dir / (k + ".json")).read_text(encoding="utf-8"))["rows"])
        except (OSError, ValueError, KeyError):
            have.discard(k)
    queue = [(c, 0) for c in split_bbox(bbox, *grid)]
    done = 0
    ready = sorted(have)
    progress.extra.update(addresses=len(rows), parts=list(ready), failed=0)
    progress.set(state="running", stage="Запрос адресов OpenStreetMap", done=0, total=len(queue), message="",
                 started=now(), finished=None)
    api = Overpass(endpoints, timeout=timeout, pause=pause)
    failed = []
    try:
        while queue:
            progress.check()
            cell, depth = queue.pop(0)
            key = cell_key(cell)
            if key in split:  # в прошлый раз эту часть уже делили
                queue[0:0] = [(c, depth + 1) for c in split_bbox(cell, 2, 2)]
                progress.set(total=done + len(queue))
                continue
            if key in have:
                done += 1
                progress.set(done=done, total=done + len(queue))
                continue
            progress.set(stage="Адреса OpenStreetMap: часть %d из %d" % (done + 1, done + 1 + len(queue)))
            try:
                part = api.run(overpass_query(cell), progress)
            except TooBig:
                if depth < 2:
                    (parts_dir / (key + ".split")).write_text("", encoding="utf-8")
                    queue[0:0] = [(c, depth + 1) for c in split_bbox(cell, 2, 2)]
                    progress.set(total=done + len(queue))
                    continue
                failed.append(key)
                part = None
            except AddressError:
                failed.append(key)  # остальные части всё равно скачиваются
                part = None
            done += 1
            if part is not None:
                write_json_atomic(parts_dir / (key + ".json"), {"key": key, "rows": part})
                rows.update(part)
                ready.append(key)
            progress.extra.update(addresses=len(rows), parts=list(ready), failed=len(failed))
            progress.set(done=done, total=done + len(queue))
            if pause and queue:
                time.sleep(pause)  # бережём общий сервер
        if len(rows) < (MIN_COUNT if min_count is None else min_count):
            raise AddressError("Overpass вернул слишком мало адресов (%d). Повторите позже." % len(rows))
        progress.set(stage="Сохранение")
        doc = {"format": "osm-addresses", "version": 1, "downloadedAt": now(), "endpoint": api.used,
               "source": "© участники OpenStreetMap (ODbL), Overpass API", "count": len(rows),
               "complete": not failed, "fields": FIELDS, "rows": list(rows.values())}
        write_json_atomic(out, doc)
        if not failed:
            shutil.rmtree(str(parts_dir), ignore_errors=True)
        msg = ("Не загрузились части: %d. Следующий запуск докачает только их." % len(failed)) if failed else ""
        progress.set(state="done", stage="Готово", message=msg, finished=now())
        return doc
    except Exception as e:  # noqa: BLE001 - сообщение показывается в приложении
        cancelled = progress.cancel.is_set()
        progress.set(state="cancelled" if cancelled else "error", stage="",
                     message=("Остановлено. Полученные части сохранены, следующий запуск продолжит с них." if cancelled else
                              "%s. Полученные части сохранены, следующий запуск продолжит с них." % e), finished=now())
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
            # count, дата и полнота лежат в начале файла, весь файл не читаем
            for key in ("downloadedAt", "count", "complete"):
                i = head.find('"%s":' % key)
                if i >= 0:
                    v = head[i + len(key) + 3:].split(",", 1)[0]
                    st[key] = json.loads(v)
        except (OSError, ValueError):
            pass
    return st
