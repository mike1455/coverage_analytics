# -*- coding: utf-8 -*-
"""Офлайн-карта Москвы: вырезка из ежедневной сборки OpenStreetMap (Protomaps, формат PMTiles v3).

Работает на стандартной библиотеке Python, внешние утилиты не нужны. Из сборки всего мира
(~120 ГБ) по HTTP Range читаются только каталоги и тайлы в границах Москвы, результат
сохраняется в data/local/moscow.pmtiles. Рядом пишется moscow.pmtiles.json с датой сборки.

Источник выбран по лицензии: условия Яндекс.Карт и 2ГИС запрещают сохранять их тайлы,
политика tile.openstreetmap.org запрещает массовое скачивание, а сборки Protomaps из данных
OSM (ODbL) публикуются как раз для вырезки и самостоятельного хостинга.

Используется из serve.py (кнопка «Скачать карту» в приложении) и из tools/get_basemap.py.
"""
import bisect
import datetime as dt
import gzip
import json
import math
import os
import shutil
import struct
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILDS = "https://build.protomaps.com/{date}.pmtiles"
# Москва в границах 2012 г. с ТиНАО и Зеленоградом, с небольшим запасом
MOSCOW_BBOX = (36.80, 55.13, 37.97, 56.03)
DEFAULT_MAXZOOM = 15
OUTPUT = ROOT / "data" / "local" / "moscow.pmtiles"
USER_AGENT = "coverage-analytics/1.0 (local basemap extract)"

HEADER_LEN = 127
ROOT_LIMIT = 16384  # заголовок + корневой каталог по спецификации укладываются в первые 16 КБ
GAP = 64 * 1024  # соседние тайлы с разрывом меньше этого читаются одним запросом
MAX_RANGE = 8 * 1024 * 1024
WORKERS = 4

COMPRESSION = {0: "unknown", 1: "none", 2: "gzip", 3: "brotli", 4: "zstd"}


class BasemapError(Exception):
    pass


class Cancelled(BasemapError):
    pass


def meta_path(out=OUTPUT):
    return Path(out).with_name(Path(out).name + ".json")


# ---------------------------------------------------------------- PMTiles v3: ID тайлов, varint, каталоги

def zxy_to_tileid(z, x, y):
    """ID тайла в PMTiles: число тайлов предыдущих уровней + позиция на кривой Гильберта."""
    acc = ((1 << (2 * z)) - 1) // 3
    n = 1 << z
    d = 0
    s = n >> 1
    while s > 0:
        rx = 1 if x & s else 0
        ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x = s - 1 - (x & (s - 1))
                y = s - 1 - (y & (s - 1))
            x, y = y, x
        s >>= 1
    return acc + d


def lonlat_to_tile(lon, lat, z):
    n = 1 << z
    lat = max(-85.0511, min(85.0511, lat))
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n)
    return min(max(x, 0), n - 1), min(max(y, 0), n - 1)


def bbox_tile_ids(bbox, minzoom, maxzoom):
    ids = []
    for z in range(minzoom, maxzoom + 1):
        x0, y0 = lonlat_to_tile(bbox[0], bbox[3], z)
        x1, y1 = lonlat_to_tile(bbox[2], bbox[1], z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                ids.append(zxy_to_tileid(z, x, y))
    ids.sort()
    return ids


def read_varint(buf, pos):
    result = 0
    shift = 0
    while True:
        if pos >= len(buf):
            raise BasemapError("Повреждённый каталог PMTiles")
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def write_varint(out, v):
    while v >= 0x80:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)


class Entry:
    __slots__ = ("tile_id", "offset", "length", "run_length")

    def __init__(self, tile_id, offset, length, run_length):
        self.tile_id, self.offset, self.length, self.run_length = tile_id, offset, length, run_length


def deserialize_dir(buf):
    n, pos = read_varint(buf, 0)
    entries = [Entry(0, 0, 0, 0) for _ in range(n)]
    last = 0
    for e in entries:
        d, pos = read_varint(buf, pos)
        last += d
        e.tile_id = last
    for e in entries:
        e.run_length, pos = read_varint(buf, pos)
    for e in entries:
        e.length, pos = read_varint(buf, pos)
    for i, e in enumerate(entries):
        v, pos = read_varint(buf, pos)
        if v == 0 and i > 0:
            e.offset = entries[i - 1].offset + entries[i - 1].length
        else:
            e.offset = v - 1
    return entries


def serialize_dir(entries):
    out = bytearray()
    write_varint(out, len(entries))
    last = 0
    for e in entries:
        write_varint(out, e.tile_id - last)
        last = e.tile_id
    for e in entries:
        write_varint(out, e.run_length)
    for e in entries:
        write_varint(out, e.length)
    for i, e in enumerate(entries):
        if i > 0 and e.offset == entries[i - 1].offset + entries[i - 1].length:
            write_varint(out, 0)
        else:
            write_varint(out, e.offset + 1)
    return bytes(out)


HEADER_FMT = "<7sB11Q6B4iB2i"


def parse_header(buf):
    if len(buf) < HEADER_LEN or buf[:7] != b"PMTiles":
        raise BasemapError("Источник не является файлом PMTiles")
    if buf[7] != 3:
        raise BasemapError("Поддерживается только PMTiles версии 3 (в файле версия %d)" % buf[7])
    v = struct.unpack_from(HEADER_FMT, buf, 0)
    keys = ("magic", "version", "root_offset", "root_length", "metadata_offset", "metadata_length",
            "leaf_offset", "leaf_length", "data_offset", "data_length", "addressed_tiles", "tile_entries",
            "tile_contents", "clustered", "internal_compression", "tile_compression", "tile_type",
            "min_zoom", "max_zoom", "min_lon", "min_lat", "max_lon", "max_lat", "center_zoom",
            "center_lon", "center_lat")
    return dict(zip(keys, v))


def pack_header(hd):
    return struct.pack(HEADER_FMT, b"PMTiles", 3, hd["root_offset"], hd["root_length"],
                       hd["metadata_offset"], hd["metadata_length"], hd["leaf_offset"], hd["leaf_length"],
                       hd["data_offset"], hd["data_length"], hd["addressed_tiles"], hd["tile_entries"],
                       hd["tile_contents"], hd["clustered"], hd["internal_compression"],
                       hd["tile_compression"], hd["tile_type"], hd["min_zoom"], hd["max_zoom"],
                       hd["min_lon"], hd["min_lat"], hd["max_lon"], hd["max_lat"], hd["center_zoom"],
                       hd["center_lon"], hd["center_lat"])


def decompress(data, kind):
    if kind in (0, 1):
        return data
    if kind == 2:
        return gzip.decompress(data)
    raise BasemapError("Сжатие каталогов %s не поддерживается" % COMPRESSION.get(kind, kind))


def compress(data, kind):
    if kind in (0, 1):
        return data
    return gzip.compress(data, compresslevel=9, mtime=0)


def build_directories(entries, kind):
    """Корневой каталог должен уместиться в первые 16 КБ, остальное уходит в листовые каталоги."""
    root = compress(serialize_dir(entries), kind)
    if len(root) <= ROOT_LIMIT - HEADER_LEN:
        return root, b""
    leaf_size = 4096
    while True:
        roots = []
        leaves = bytearray()
        for i in range(0, len(entries), leaf_size):
            chunk = entries[i:i + leaf_size]
            ser = compress(serialize_dir(chunk), kind)
            roots.append(Entry(chunk[0].tile_id, len(leaves), len(ser), 0))
            leaves += ser
        root = compress(serialize_dir(roots), kind)
        if len(root) <= ROOT_LIMIT - HEADER_LEN:
            return root, bytes(leaves)
        leaf_size *= 2


# ---------------------------------------------------------------- источники

class HttpSource:
    def __init__(self, url, timeout=60, retries=4):
        self.url, self.timeout, self.retries = url, timeout, retries

    def read(self, offset, length):
        last = None
        for attempt in range(self.retries):
            req = urllib.request.Request(self.url, headers={
                "Range": "bytes=%d-%d" % (offset, offset + length - 1), "User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    if r.status != 206:
                        # сервер проигнорировал Range: не качаем весь мир, а останавливаемся
                        raise BasemapError("Сервер источника не поддерживает частичную загрузку (HTTP %d)" % r.status)
                    data = r.read(length + 1)
                if len(data) != length:
                    raise OSError("получено %d байт вместо %d" % (len(data), length))
                return data
            except BasemapError:
                raise
            except urllib.error.HTTPError as e:
                if e.code in (403, 404, 410, 416):
                    raise BasemapError("Источник ответил HTTP %d: %s" % (e.code, self.url))
                last = e
            except (OSError, ValueError) as e:
                last = e
            time.sleep(min(8, 2 ** attempt))
        raise BasemapError("Нет связи с %s: %s" % (self.url, last))


class FileSource:
    def __init__(self, path):
        self.path = str(path)

    def read(self, offset, length):
        with open(self.path, "rb") as f:
            f.seek(offset)
            data = f.read(length)
        if len(data) != length:
            raise BasemapError("Файл источника короче ожидаемого")
        return data


def open_source(src):
    s = str(src)
    if s.startswith(("http://", "https://")):
        return HttpSource(s)
    return FileSource(s)


def build_available(date, timeout=20):
    try:
        hd = HttpSource(BUILDS.format(date=date), timeout=timeout, retries=1).read(0, HEADER_LEN)
        return hd[:7] == b"PMTiles"
    except BasemapError:
        return False


def latest_build(today=None, days=10, probe=build_available):
    today = today or dt.date.today()
    for i in range(0, days + 1):
        d = (today - dt.timedelta(days=i)).strftime("%Y%m%d")
        if probe(d):
            return d
    return None


# ---------------------------------------------------------------- вырезка

class Progress:
    """Состояние фоновой загрузки, которое читает serve.py."""

    def __init__(self):
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.reset()

    def reset(self):
        self.state = "idle"  # idle | running | done | error | cancelled
        self.stage = ""
        self.done = 0
        self.total = 0
        self.message = ""
        self.started = None
        self.finished = None
        self.extra = {}  # счётчики для показа: адреса, найденные дома и т. п.

    def set(self, **kw):
        with self.lock:
            for k, v in kw.items():
                setattr(self, k, v)

    def add(self, n):
        with self.lock:
            self.done += n

    def check(self):
        if self.cancel.is_set():
            raise Cancelled("Загрузка отменена")

    def snapshot(self):
        with self.lock:
            return {"state": self.state, "stage": self.stage, "done": self.done, "total": self.total,
                    "message": self.message, "started": self.started, "finished": self.finished, **self.extra}


def _collect(src, hd, wanted, progress):
    """Найти в каталогах источника записи для нужных тайлов: {tile_id: (offset, length)}."""
    kind = hd["internal_compression"]
    found = {}
    root = deserialize_dir(decompress(src.read(hd["root_offset"], hd["root_length"]), kind))
    pending = [(root, wanted)]
    leaves_read = 0
    while pending:
        entries, ids = pending.pop()
        keys = [e.tile_id for e in entries]
        groups = {}
        for tid in ids:
            i = bisect.bisect_right(keys, tid) - 1
            if i < 0:
                continue
            e = entries[i]
            if e.run_length == 0:
                groups.setdefault(i, []).append(tid)
            elif tid < e.tile_id + e.run_length:
                found[tid] = (e.offset, e.length)
        for i, sub in groups.items():
            progress.check()
            e = entries[i]
            leaf = deserialize_dir(decompress(src.read(hd["leaf_offset"] + e.offset, e.length), kind))
            leaves_read += 1
            progress.set(stage="Чтение каталога тайлов (%d)" % leaves_read)
            pending.append((leaf, sub))
    return found


def extract(source, out=OUTPUT, bbox=MOSCOW_BBOX, maxzoom=DEFAULT_MAXZOOM, progress=None, build=None,
            workers=WORKERS):
    """Вырезать bbox из PMTiles-источника в файл out. Старый файл заменяется только после успешной загрузки."""
    progress = progress or Progress()
    out = Path(out)
    src = open_source(source)
    progress.set(stage="Чтение заголовка сборки")
    hd = parse_header(src.read(0, HEADER_LEN))
    if hd["internal_compression"] not in (1, 2):
        raise BasemapError("Сжатие каталогов %s не поддерживается" % COMPRESSION.get(hd["internal_compression"]))
    minz = hd["min_zoom"]
    maxz = max(minz, min(int(maxzoom), hd["max_zoom"]))
    wanted = bbox_tile_ids(bbox, minz, maxz)

    progress.set(stage="Чтение каталога тайлов")
    found = _collect(src, hd, wanted, progress)
    if not found:
        raise BasemapError("В сборке нет тайлов для выбранной области")
    meta_raw = b"{}"
    if hd["metadata_length"]:
        meta_raw = decompress(src.read(hd["metadata_offset"], hd["metadata_length"]), hd["internal_compression"])

    # Уникальное содержимое в порядке источника (сохраняет кластеризацию), новые смещения подряд
    contents = sorted(set(found.values()))
    new_off = {}
    pos = 0
    for off, ln in contents:
        new_off[off] = pos
        pos += ln
    data_len = pos

    entries = []
    for tid in sorted(found):
        off, ln = found[tid]
        no = new_off[off]
        last = entries[-1] if entries else None
        if last and last.offset == no and last.tile_id + last.run_length == tid:
            last.run_length += 1
        else:
            entries.append(Entry(tid, no, ln, 1))

    kind = hd["internal_compression"]
    root, leaves = build_directories(entries, kind)
    meta = compress(meta_raw, kind)
    out_hd = dict(hd)
    out_hd.update(
        root_offset=HEADER_LEN, root_length=len(root),
        metadata_offset=HEADER_LEN + len(root), metadata_length=len(meta),
        leaf_offset=HEADER_LEN + len(root) + len(meta), leaf_length=len(leaves),
        addressed_tiles=len(found), tile_entries=len(entries), tile_contents=len(contents),
        min_zoom=minz, max_zoom=maxz,
        min_lon=int(round(bbox[0] * 1e7)), min_lat=int(round(bbox[1] * 1e7)),
        max_lon=int(round(bbox[2] * 1e7)), max_lat=int(round(bbox[3] * 1e7)),
        center_zoom=max(minz, min(10, maxz)),
        center_lon=int(round((bbox[0] + bbox[2]) / 2 * 1e7)), center_lat=int(round((bbox[1] + bbox[3]) / 2 * 1e7)),
    )
    out_hd["data_offset"] = out_hd["leaf_offset"] + len(leaves)
    out_hd["data_length"] = data_len
    total_size = out_hd["data_offset"] + data_len

    out.parent.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(str(out.parent)).free
    if free < total_size + 50 * 1024 * 1024:
        raise BasemapError("Недостаточно места на диске: нужно %.0f МБ, свободно %.0f МБ" % (total_size / 1e6, free / 1e6))

    # Соседние тайлы объединяются в один запрос
    ranges = []
    for off, ln in contents:
        if ranges and off - ranges[-1][1] <= GAP and off + ln - ranges[-1][0] <= MAX_RANGE:
            ranges[-1][1] = max(ranges[-1][1], off + ln)
            ranges[-1][2].append((off, ln))
        else:
            ranges.append([off, off + ln, [(off, ln)]])

    tmp = out.with_name(out.name + ".download")
    progress.set(stage="Загрузка тайлов", done=0, total=data_len)
    wlock = threading.Lock()
    try:
        with open(tmp, "wb") as f:
            f.write(pack_header(out_hd))
            f.write(root)
            f.write(meta)
            f.write(leaves)
            f.truncate(total_size)

            def fetch(rng):
                progress.check()
                start, end, items = rng
                data = src.read(hd["data_offset"] + start, end - start)
                with wlock:
                    for off, ln in items:
                        f.seek(out_hd["data_offset"] + new_off[off])
                        f.write(data[off - start:off - start + ln])
                progress.add(sum(ln for _, ln in items))

            with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
                futures = [pool.submit(fetch, r) for r in ranges]
                try:
                    for fu in as_completed(futures):
                        fu.result()
                except BaseException:
                    progress.cancel.set()
                    for other in futures:
                        other.cancel()
                    raise
            f.flush()
            os.fsync(f.fileno())
        progress.check()
        progress.set(stage="Сохранение")
        _replace(tmp, out)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise

    info = {
        "build": build or "", "source": str(source), "maxzoom": maxz, "bbox": list(bbox),
        "size": out.stat().st_size, "tiles": len(found), "downloadedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
    }
    meta_path(out).write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    return info


def _replace(tmp, out):
    """os.replace с повторами: на Windows файл может быть на мгновение открыт сервером карты."""
    for attempt in range(20):
        try:
            os.replace(str(tmp), str(out))
            return
        except PermissionError:
            if attempt == 19:
                raise BasemapError("Не удалось заменить %s: файл занят другим процессом" % out)
            time.sleep(0.25)


def download(progress, out=OUTPUT, maxzoom=DEFAULT_MAXZOOM, source=None, build=None):
    """Полный цикл для фоновой задачи: найти сборку, вырезать Москву, обновить метаданные."""
    progress.cancel.clear()
    progress.set(state="running", stage="Поиск свежей сборки OpenStreetMap", done=0, total=0, message="",
                 started=dt.datetime.now().astimezone().isoformat(timespec="seconds"), finished=None)
    try:
        if not source:
            build = build or latest_build()
            if not build:
                raise BasemapError("Не удалось связаться с build.protomaps.com. Проверьте доступ в интернет "
                                   "(или прокси) и повторите.")
            source = BUILDS.format(date=build)
        info = extract(source, out=out, maxzoom=maxzoom, progress=progress, build=build)
        progress.set(state="done", stage="Готово", message="", finished=dt.datetime.now().astimezone().isoformat(timespec="seconds"))
        return info
    except Cancelled:
        progress.set(state="cancelled", stage="", message="Загрузка отменена, прежняя карта не изменилась.")
    except BasemapError as e:
        progress.set(state="error", stage="", message=str(e))
    except Exception as e:  # noqa: BLE001 - ошибка показывается пользователю в приложении
        progress.set(state="error", stage="", message="%s: %s" % (type(e).__name__, e))
    progress.set(finished=dt.datetime.now().astimezone().isoformat(timespec="seconds"))
    return None


def read_tile(source, z, x, y):
    """Содержимое тайла или None. Для проверки скачанного файла и тестов."""
    src = open_source(source)
    hd = parse_header(src.read(0, HEADER_LEN))
    tid = zxy_to_tileid(z, x, y)
    off, ln = hd["root_offset"], hd["root_length"]
    for _ in range(4):
        entries = deserialize_dir(decompress(src.read(off, ln), hd["internal_compression"]))
        i = bisect.bisect_right([e.tile_id for e in entries], tid) - 1
        if i < 0:
            return None
        e = entries[i]
        if e.run_length == 0:
            off, ln = hd["leaf_offset"] + e.offset, e.length
            continue
        if tid < e.tile_id + e.run_length:
            return src.read(hd["data_offset"] + e.offset, e.length)
        return None
    return None


def status(out=OUTPUT):
    out = Path(out)
    st = {"exists": out.is_file(), "path": str(out)}
    if st["exists"]:
        s = out.stat()
        st.update(size=s.st_size, mtime=int(s.st_mtime * 1000))
        try:
            st["meta"] = json.loads(meta_path(out).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            st["meta"] = None
    return st
