#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Координаты домов для файла с адресами: XLSX или CSV на входе, новый файл с широтой и долготой на выходе.

Запуск на Windows: двойной щелчок по geocode.bat в папке приложения (скрипт спросит путь к файлу)
или из командной строки:

    py -3 tools/geocode_file.py                                  # спросит всё по шагам
    py -3 tools/geocode_file.py "C:\\путь\\реестр.xlsx"
    py -3 tools/geocode_file.py реестр.xlsx --sources osm,yandex --yandex-key КЛЮЧ

Источники (выполняются по порядку, каждый ищет только строки, которые ещё без координат):
  mos        Адресный реестр Москвы (data.mos.ru): точно по UNOM; нужен ключ API портала
             или JSON-выгрузка набора «Адресный реестр объектов недвижимости города Москвы»
  osm        OpenStreetMap: адреса зданий Москвы скачиваются один раз, сопоставление по адресу
  yandex     Яндекс Геокодер: по адресу; нужен ключ API, есть суточный лимит
  nominatim  Nominatim (OpenStreetMap): по одному адресу в секунду, без ключа; для небольшого остатка

Результат рядом с исходным файлом:
  <имя>_с_координатами.xlsx (или .csv)  исходные колонки + Широта, Долгота, Источник координат, Точность
  <имя>_без_координат.csv               строки, для которых координаты не найдены
  <имя>_для_приложения.csv              UNOM, lat, lon для загрузки в приложение (если в файле есть UNOM)
Нужен только Python 3.8+, сторонние библиотеки не используются.
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

TOOLS = Path(__file__).resolve().parent
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS))
import addrmatch  # noqa: E402
import basemap  # noqa: E402
import mos_registry  # noqa: E402
import osm_addresses  # noqa: E402
import yandex_geocoder  # noqa: E402
from prepare_mji import read_xlsx  # noqa: E402

SOURCES = {
    "mos": "Адресный реестр Москвы (data.mos.ru), точно по UNOM, нужен ключ API или JSON-выгрузка",
    "osm": "OpenStreetMap, по адресу, без ключа",
    "yandex": "Яндекс Геокодер, по адресу, нужен ключ API",
    "nominatim": "Nominatim, по одному адресу в секунду, без ключа",
}
ORDER = ["mos", "osm", "yandex", "nominatim"]
NOMINATIM = "https://nominatim.openstreetmap.org"
MOSCOW = (55.13, 36.80, 56.03, 37.97)
NEW_COLUMNS = ["Широта", "Долгота", "Источник координат", "Точность"]


def in_moscow(lat, lon):
    return MOSCOW[0] <= lat <= MOSCOW[2] and MOSCOW[1] <= lon <= MOSCOW[3]


def say(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- чтение и запись таблиц

def read_table(path):
    """→ (заголовок, строки, разделитель CSV или None для XLSX)."""
    path = Path(path)
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        _, rows = read_xlsx(path)
        if not rows:
            raise ValueError("В файле нет данных")
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        return rows[0], rows[1:], None
    raw = path.read_bytes()
    for enc in ("utf-8-sig", "cp1251"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    first = text.split("\n", 1)[0]
    delim = max([",", ";", "\t"], key=first.count)
    rows = list(csv.reader(io.StringIO(text), delimiter=delim))
    rows = [r for r in rows if any(c.strip() for c in r)]
    if not rows:
        raise ValueError("В файле нет данных")
    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    return rows[0], rows[1:], delim


_BAD_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f]")


def write_xlsx(path, header, rows, numeric_cols=()):
    """Простой XLSX без стилей: текст как есть (UNOM и ФИАС не превращаются в числа), координаты числами."""
    def col(i):
        s = ""
        i += 1
        while i:
            i, r = divmod(i - 1, 26)
            s = chr(65 + r) + s
        return s

    def cell(ri, ci, v):
        ref = "%s%d" % (col(ci), ri)
        if ci in numeric_cols and v != "" and v is not None:
            return '<c r="%s"><v>%s</v></c>' % (ref, v)
        t = escape(_BAD_XML.sub("", str(v if v is not None else "")))
        return '<c r="%s" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>' % (ref, t)

    parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
             '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
             '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
             '<sheetData>']
    for ri, r in enumerate([header] + rows, 1):
        parts.append('<row r="%d">%s</row>' % (ri, "".join(cell(ri, ci, v) for ci, v in enumerate(r) if v != "" or ri == 1)))
    parts.append("</sheetData></worksheet>")
    files = {
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>",
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>",
        "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Координаты" sheetId="1" r:id="rId1"/></sheets></workbook>',
        "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        "</Relationships>",
        "xl/worksheets/sheet1.xml": "".join(parts),
    }
    tmp = Path(str(path) + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)
    os.replace(str(tmp), str(path))


def write_csv(path, header, rows, delim=","):
    tmp = Path(str(path) + ".tmp")
    with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f, delimiter=delim)
        w.writerow(header)
        w.writerows(rows)
    os.replace(str(tmp), str(path))


def find_column(header, patterns):
    low = [str(h).strip().lower() for h in header]
    for p in patterns:
        for i, h in enumerate(low):
            if re.fullmatch(p, h):
                return i
    for p in patterns:
        for i, h in enumerate(low):
            if re.search(p.strip("^$"), h):
                return i
    return -1


# ---------------------------------------------------------------- фоновые задачи с ходом в консоли

def run_job(target, progress, line, *args, **kw):
    th = threading.Thread(target=target, args=(progress,) + args, kwargs=kw, daemon=True)
    th.start()
    last = ""
    try:
        while th.is_alive():
            text = line(progress.snapshot())
            if text != last:
                print("\r  " + text.ljust(100)[:110], end="", flush=True)
                last = text
            time.sleep(0.5)
    except KeyboardInterrupt:
        progress.cancel.set()
        th.join()
    print("\r  " + line(progress.snapshot()).ljust(100)[:110], flush=True)
    return progress.snapshot()


def pct(a, b):
    return "%d%%" % (100 * a // b) if b else ""


def num(n):
    return "{:,}".format(int(n)).replace(",", " ")


# ---------------------------------------------------------------- источники

def source_mos(todo, unom_of, opts):
    """Реестр Москвы: по UNOM из JSON-выгрузки data.mos.ru или через API с ключом."""
    points = {}
    if opts.mos_file:
        say("  Чтение выгрузки реестра: %s" % opts.mos_file)
        data = json.loads(Path(opts.mos_file).read_text(encoding="utf-8-sig"))
        items = data if isinstance(data, list) else data.get("features") or []
        for it in items:
            r = mos_registry.parse_item(it)
            if r:
                points[r[0]] = (r[1], r[2])
        say("  В выгрузке зданий с координатами: %s" % num(len(points)))
    else:
        cache = Path(opts.data_dir) / "mos_registry.json"
        if opts.refresh or not cache.is_file():
            if not mos_registry.load_settings(opts.config)["mosKey"]:
                say("  Нет ключа API data.mos.ru и JSON-выгрузки: источник пропущен.")
                return {}
            prog = basemap.Progress()
            unoms = [unom_of(i) for i in todo]
            st = run_job(mos_registry.download, prog, lambda s: (
                "Реестр Москвы: прочитано %s из %s записей (%s), найдено домов: %s из %s" % (
                    num(s.get("records", 0)), num(s.get("total", 0)), pct(s.get("records", 0), s.get("total", 0)),
                    num(s.get("found", 0)), num(len(unoms))) if s.get("total") else (s.get("stage") or "Подключение к data.mos.ru")),
                unoms=unoms, settings_path=opts.config, out=cache)
            if st["state"] != "done":
                say("  Реестр Москвы недоступен: %s" % st["message"])
                return {}
        doc = json.loads(cache.read_text(encoding="utf-8"))
        points = {u: tuple(p) for u, p in (doc.get("points") or {}).items()}
        say("  Реестр от %s: %s зданий" % (str(doc.get("downloadedAt", ""))[:10], num(len(points))))
    out = {}
    for i in todo:
        p = points.get(mos_registry.norm_unom(unom_of(i)))
        if p and in_moscow(*p):
            out[i] = (p[0], p[1], "Адресный реестр Москвы (data.mos.ru)", "UNOM совпал")
    return out


def source_osm(todo, address_of, opts):
    cache = Path(opts.data_dir) / "osm" / "moscow_addresses.json"
    if opts.refresh or not cache.is_file():
        prog = basemap.Progress()
        env = os.environ.get("MCA_OVERPASS_URL")
        kw = {"out": cache}
        if env:
            kw.update(endpoints=env.split(","), pause=0, min_count=1)
        st = run_job(osm_addresses.download, prog, lambda s: "OpenStreetMap: получено %s адресов зданий, загружено %s" % (
            num(s.get("addresses", 0)), pct(s.get("done", 0), s.get("total", 0) or 1)), **kw)
        if st["state"] != "done":
            say("  OpenStreetMap недоступен: %s" % st["message"])
            return {}
    doc = json.loads(cache.read_text(encoding="utf-8"))
    rows = doc.get("rows") or []
    say("  Справочник OpenStreetMap от %s: %s адресов зданий" % (str(doc.get("downloadedAt", ""))[:10], num(len(rows))))
    index = addrmatch.build_index(rows)
    out = {}
    for n, i in enumerate(todo, 1):
        m = addrmatch.match_address(index, address_of(i))
        if m["status"] == "ok":
            acc = ("здание OSM" if m["type"] != "n" else "адресная точка OSM") + (", адрес совпал" if m["exact"] else ", совпал адрес без типа улицы")
            out[i] = (m["lat"], m["lon"], "OpenStreetMap", acc)
        if n % 2000 == 0 or n == len(todo):
            print("\r  Сопоставление: проверено %s из %s (%s), найдено %s   " % (num(n), num(len(todo)), pct(n, len(todo)), num(len(out))), end="", flush=True)
    print(flush=True)
    return out


def source_yandex(todo, address_of, opts):
    if not yandex_geocoder.load_settings(opts.config)["apiKey"]:
        say("  Нет ключа API Яндекс Геокодера: источник пропущен.")
        return {}
    items = [{"id": str(i), "address": address_of(i)} for i in todo]
    prog = basemap.Progress()
    prog.results = {}
    cache = Path(opts.data_dir) / "yandex_geocoder_cache.json"
    kw = {"settings_path": opts.config, "cache_path": cache}
    if os.environ.get("MCA_YANDEX_URL"):
        kw["rate"] = 0
    st = run_job(yandex_geocoder.run, prog, lambda s: "Яндекс: проверено %s из %s (%s), найдено %s" % (
        num(s.get("done", 0)), num(len(items)), pct(s.get("done", 0), len(items)), num(s.get("found", 0))), items, **kw)
    if st["message"]:
        say("  " + st["message"])
    out = {}
    for sid, hit in (prog.results or {}).items():
        if not hit or hit.get("none") or hit.get("kind") != "house" or hit.get("precision") not in ("exact", "number", "near"):
            continue
        if not in_moscow(hit["lat"], hit["lon"]):
            continue
        acc = {"exact": "Яндекс, адрес совпал", "number": "Яндекс, номер дома без корпуса, проверить", "near": "Яндекс, ближайший дом, проверить"}[hit["precision"]]
        out[int(sid)] = (hit["lat"], hit["lon"], "Яндекс Геокодер", acc)
    return out


def nominatim_search(query, keys, base, email=""):
    q = {"q": query, "format": "jsonv2", "addressdetails": 1, "limit": 5, "countrycodes": "ru", "accept-language": "ru",
         "viewbox": "%s,%s,%s,%s" % (MOSCOW[1], MOSCOW[2], MOSCOW[3], MOSCOW[0]), "bounded": 1}
    if email:
        q["email"] = email
    req = urllib.request.Request("%s/search?%s" % (base, urllib.parse.urlencode(q)), headers={"User-Agent": "coverage-analytics/1.0 (geocode_file)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        res = json.loads(r.read().decode("utf-8"))
    for x in res:
        hn = (x.get("address") or {}).get("house_number") or ""
        if hn and addrmatch.norm_hn(hn) in keys:
            lat, lon = float(x["lat"]), float(x["lon"])
            if in_moscow(lat, lon):
                return {"lat": lat, "lon": lon}
    return {"none": True}


def source_nominatim(todo, address_of, opts):
    base = (os.environ.get("MCA_NOMINATIM_URL") or NOMINATIM).rstrip("/")
    cache_path = Path(opts.data_dir) / "nominatim_cache.json"
    cache = yandex_geocoder.read_json(cache_path, {})
    todo = list(todo)[:opts.nominatim_limit]
    out = {}
    asked = 0
    try:
        for n, i in enumerate(todo, 1):
            _, _, keys = addrmatch.parse_address(address_of(i))
            query = yandex_geocoder.query_for(address_of(i))
            hit = cache.get(query)
            if hit is None and keys:
                try:
                    hit = nominatim_search(query, keys, base, opts.email)
                except (OSError, ValueError) as e:
                    say("\n  Nominatim недоступен: %s" % e)
                    break
                cache[query] = hit
                asked += 1
                if not os.environ.get("MCA_NOMINATIM_URL"):
                    time.sleep(1.1)  # политика Nominatim: не чаще одного запроса в секунду
            if hit and not hit.get("none"):
                out[i] = (hit["lat"], hit["lon"], "Nominatim (OpenStreetMap)", "номер дома совпал")
            print("\r  Nominatim: проверено %s из %s (%s), найдено %s   " % (num(n), num(len(todo)), pct(n, len(todo)), num(len(out))), end="", flush=True)
    except KeyboardInterrupt:
        say("\n  Остановлено, найденное сохранено.")
    print(flush=True)
    yandex_geocoder.write_json(cache_path, cache)
    return out


# ---------------------------------------------------------------- диалог

def ask(prompt, default=""):
    try:
        v = input("%s%s: " % (prompt, " [%s]" % default if default else "")).strip()
    except EOFError:
        v = ""
    return v or default


def clean_path(s):
    return s.strip().strip('"').strip("'").strip()


def interactive(opts):
    say("Координаты домов для файла с адресами (XLSX или CSV).")
    say("Результат будет записан в новый файл рядом с исходным, исходный файл не меняется.\n")
    while not opts.input:
        p = clean_path(ask("Путь к файлу (можно перетащить файл в это окно)"))
        if p and Path(p).is_file():
            opts.input = p
        elif p:
            say("Файл не найден: %s" % p)
    return opts


def choose_sources(opts, has_unom):
    if opts.sources:
        return [s.strip() for s in opts.sources.split(",") if s.strip() in SOURCES]
    ya = yandex_geocoder.load_settings(opts.config)
    mos = mos_registry.load_settings(opts.config)
    say("\nИсточники координат (выполняются по порядку, каждый ищет только оставшиеся строки):")
    for n, sid in enumerate(ORDER, 1):
        extra = ""
        if sid == "mos":
            extra = " [ключ сохранён]" if mos["mosKey"] else ("" if has_unom else " [в файле нет UNOM]")
        if sid == "yandex" and ya["apiKey"]:
            extra = " [ключ сохранён, лимит %s в сутки]" % num(ya["dailyLimit"])
        say("  %d) %s%s" % (n, SOURCES[sid], extra))
    default = ",".join(str(ORDER.index(s) + 1) for s in ORDER if (s == "osm") or (s == "mos" and mos["mosKey"] and has_unom) or (s == "yandex" and ya["apiKey"]))
    picked = ask("Номера через запятую", default)
    out = []
    for part in re.split(r"[,\s]+", picked):
        if part.isdigit() and 1 <= int(part) <= len(ORDER):
            out.append(ORDER[int(part) - 1])
        elif part in SOURCES:
            out.append(part)
    return [s for s in ORDER if s in out]


def ensure_keys(opts, sources, interactive_mode):
    if opts.yandex_key:
        yandex_geocoder.save_settings({"apiKey": opts.yandex_key}, opts.config)
    if opts.yandex_limit:
        yandex_geocoder.save_settings({"dailyLimit": opts.yandex_limit}, opts.config)
    if opts.mos_key:
        mos_registry.save_settings({"mosKey": opts.mos_key}, opts.config)
    if not interactive_mode:
        return
    if "mos" in sources and not opts.mos_file and not mos_registry.load_settings(opts.config)["mosKey"]:
        v = clean_path(ask("Ключ API data.mos.ru или путь к JSON-выгрузке реестра (Enter, чтобы пропустить)"))
        if v and Path(v).is_file():
            opts.mos_file = v
        elif v:
            mos_registry.save_settings({"mosKey": v}, opts.config)
    if "yandex" in sources and not yandex_geocoder.load_settings(opts.config)["apiKey"]:
        v = ask("Ключ API Яндекс Геокодера (Enter, чтобы пропустить)")
        if v:
            yandex_geocoder.save_settings({"apiKey": v}, opts.config)
            lim = ask("Лимит запросов в сутки", str(yandex_geocoder.DEFAULT_LIMIT))
            if lim.isdigit():
                yandex_geocoder.save_settings({"dailyLimit": int(lim)}, opts.config)
    if "nominatim" in sources and not opts.nominatim_limit_set:
        lim = ask("Nominatim: сколько адресов проверить за этот запуск (1 адрес в секунду)", str(opts.nominatim_limit))
        if lim.isdigit():
            opts.nominatim_limit = int(lim)


def pick_column(header, idx, what, interactive_mode, required=True):
    if idx >= 0 or not interactive_mode:
        return idx
    say("\nНе удалось определить колонку «%s». Колонки файла:" % what)
    for n, h in enumerate(header, 1):
        say("  %d) %s" % (n, h))
    while True:
        v = ask("Номер колонки «%s»%s" % (what, "" if required else " (Enter, если её нет)"))
        if not v and not required:
            return -1
        if v.isdigit() and 1 <= int(v) <= len(header):
            return int(v) - 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="Координаты домов для файла с адресами (XLSX или CSV)")
    ap.add_argument("input", nargs="?", help="путь к файлу XLSX или CSV")
    ap.add_argument("--output", help="куда записать результат (по умолчанию <имя>_с_координатами рядом с исходным)")
    ap.add_argument("--sources", help="источники через запятую: mos, osm, yandex, nominatim (по умолчанию спросит)")
    ap.add_argument("--address-column", help="название колонки с адресом")
    ap.add_argument("--unom-column", help="название колонки с UNOM")
    ap.add_argument("--yandex-key", help="ключ API Яндекс Геокодера (сохранится в config/geocoder.local.json)")
    ap.add_argument("--yandex-limit", type=int, help="суточный лимит запросов к Яндексу")
    ap.add_argument("--mos-key", help="ключ API портала data.mos.ru (сохранится в config/geocoder.local.json)")
    ap.add_argument("--mos-file", help="JSON-выгрузка адресного реестра с data.mos.ru вместо API")
    ap.add_argument("--nominatim-limit", type=int, help="сколько адресов проверить через Nominatim (по умолчанию 300)")
    ap.add_argument("--email", default="", help="e-mail для Nominatim (рекомендуется его политикой)")
    ap.add_argument("--refresh", action="store_true", help="скачать адреса OSM и реестр Москвы заново")
    ap.add_argument("--yes", action="store_true", help="ничего не спрашивать")
    ap.add_argument("--data-dir", default=str(ROOT / "data" / "local"), help=argparse.SUPPRESS)
    ap.add_argument("--config", default=str(ROOT / "config" / "geocoder.local.json"), help=argparse.SUPPRESS)
    opts = ap.parse_args(argv)
    opts.nominatim_limit_set = opts.nominatim_limit is not None
    opts.nominatim_limit = opts.nominatim_limit or 300
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    interactive_mode = not opts.yes and sys.stdin.isatty()
    if interactive_mode:
        interactive(opts)
    if not opts.input:
        ap.error("укажите путь к файлу")
    src = Path(clean_path(opts.input))
    if not src.is_file():
        say("Файл не найден: %s" % src)
        return 2

    header, rows, delim = read_table(src)
    say("\nФайл: %s, строк: %s" % (src.name, num(len(rows))))
    ia = header.index(opts.address_column) if opts.address_column in header else find_column(
        header, [r"^наименование/адрес$", r"^адрес$", r"^address$", r"адрес", r"address"])
    iu = header.index(opts.unom_column) if opts.unom_column in header else find_column(header, [r"^unom$", r"^уном$", r"unom", r"уном"])
    ia = pick_column(header, ia, "адрес", interactive_mode)
    iu = pick_column(header, iu, "UNOM", interactive_mode, required=False)
    if ia < 0:
        say("В файле не найдена колонка с адресом. Укажите её: --address-column \"Название\"")
        return 2
    say("Колонка с адресом: «%s»%s" % (header[ia], "; колонка UNOM: «%s»" % header[iu] if iu >= 0 else "; колонки UNOM нет"))

    sources = choose_sources(opts, iu >= 0)
    if not sources:
        say("Не выбран ни один источник.")
        return 2
    ensure_keys(opts, sources, interactive_mode)

    address_of = lambda i: rows[i][ia]  # noqa: E731
    unom_of = lambda i: rows[i][iu] if iu >= 0 else ""  # noqa: E731
    found = {}
    by_source = {}
    for sid in sources:
        todo = [i for i in range(len(rows)) if i not in found and str(address_of(i)).strip()]
        if not todo:
            break
        if sid == "mos" and iu < 0:
            say("\n%s: в файле нет колонки UNOM, источник пропущен." % SOURCES[sid])
            continue
        say("\n%s. Осталось без координат: %s" % (SOURCES[sid], num(len(todo))))
        if sid == "mos":
            res = source_mos(todo, unom_of, opts)
        elif sid == "osm":
            res = source_osm(todo, address_of, opts)
        elif sid == "yandex":
            res = source_yandex(todo, address_of, opts)
        else:
            res = source_nominatim(todo, address_of, opts)
        found.update(res)
        by_source[sid] = len(res)
        say("  Найдено: %s" % num(len(res)))

    # ---- запись результата
    out = Path(opts.output) if opts.output else src.with_name("%s_с_координатами%s" % (src.stem, ".xlsx" if delim is None else src.suffix))
    new_header = header + NEW_COLUMNS
    out_rows = []
    for i, r in enumerate(rows):
        f = found.get(i)
        out_rows.append(r + ([round(f[0], 7), round(f[1], 7), f[2], f[3]] if f else ["", "", "", ""]))
    if out.suffix.lower() == ".xlsx":
        write_xlsx(out, new_header, out_rows, numeric_cols={len(header), len(header) + 1})
    else:
        write_csv(out, new_header, out_rows, delim or ",")
    missing = src.with_name("%s_без_координат.csv" % src.stem)
    write_csv(missing, header, [r for i, r in enumerate(rows) if i not in found], ";")
    app_csv = None
    if iu >= 0:
        app_csv = src.with_name("%s_для_приложения.csv" % src.stem)
        write_csv(app_csv, ["unom", "lat", "lon", "source", "accuracy"],
                  [[rows[i][iu], round(f[0], 7), round(f[1], 7), f[2], f[3]] for i, f in sorted(found.items())])

    total = len(rows)
    say("\nГотово: координаты найдены для %s из %s строк (%s)." % (num(len(found)), num(total), pct(len(found), total)))
    if by_source:
        names = {"mos": "реестр Москвы", "osm": "OpenStreetMap", "yandex": "Яндекс", "nominatim": "Nominatim"}
        say("  По источникам: " + ", ".join("%s %s" % (names[k], num(v)) for k, v in by_source.items()))
    say("  Файл с координатами: %s" % out)
    say("  Без координат (%s): %s" % (num(total - len(found)), missing))
    if app_csv:
        say("  Для приложения: %s (раздел «Импорт и качество данных», «Импорт CSV/GeoJSON»)" % app_csv)
    if interactive_mode:
        ask("\nНажмите Enter, чтобы закрыть окно")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("\nОстановлено.")
        sys.exit(130)
    except Exception as e:  # noqa: BLE001 - понятное сообщение вместо трассировки
        say("\nОшибка: %s" % e)
        say("Если не понятно, в чём дело, пришлите этот текст.")
        if sys.stdin.isatty():
            ask("Нажмите Enter, чтобы закрыть окно")
        sys.exit(1)
