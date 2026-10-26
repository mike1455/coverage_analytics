#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Локальный сервер приложения: http://localhost:8000 (только стандартная библиотека Python 3.8+).

Отличия от `python -m http.server 8000`:
  * поддерживает HTTP Range, нужно для офлайн-карты data/local/moscow.pmtiles;
  * скачивает и обновляет офлайн-карту Москвы по кнопке в приложении (tools/basemap.py);
  * скачивает адреса зданий Москвы из OpenStreetMap для поиска координат домов (tools/osm_addresses.py)
    и сохраняет найденные координаты в data/local/geocoded_houses.csv;
  * ищет оставшиеся дома через Яндекс Геокодер, если указан ключ API (tools/yandex_geocoder.py);
  * скачивает границы округов и районов Москвы для заливки карты (tools/osm_boundaries.py);
  * слушает только 127.0.0.1 (данные не видны в локальной сети);
  * правильные MIME-типы для .js/.mjs/.pmtiles/.geojson и отключённый кэш для файлов приложения;
  * локальный API «Папка с выгрузками»: приложение читает ваши файлы прямо с диска по путям из
    config/sources.local.json (путь к папке и имена файлов задаются в интерфейсе приложения).

Запуск (Windows):  py -3 serve.py            (порт по умолчанию 8000), или двойной щелчок по start.bat
                   py -3 serve.py --port 8080
"""
import argparse
import email.utils
import http.server
import json
import os
import re
import shutil
import socketserver
import sys
import threading
import urllib.parse
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "tools"))
import basemap  # noqa: E402
import osm_addresses  # noqa: E402
import yandex_geocoder  # noqa: E402
import osm_boundaries  # noqa: E402

DEFAULT_CONFIG = ROOT / "config" / "sources.default.json"
LOCAL_CONFIG = Path(os.environ.get("MCA_SOURCES_CONFIG") or (ROOT / "config" / "sources.local.json"))

# Роли файлов, которые приложение умеет загружать из папки. Остальные выгрузки (№ 1, № 5, № 6, .md) не нужны.
ROLES = {
    "mji": "реестр МКД, .xlsx или .csv",
    "houses": "все адреса, одна строка на дом, .csv",
    "entrances": "адреса и подъезды, одна строка на подъезд, .csv",
    "requests": "заявки 2026 по дому и подъезду, .csv",
    "geo": "unom, lat, lon в .csv или .geojson, необязательно",
}
ALLOWED_EXT = {".csv", ".xlsx", ".txt", ".json", ".geojson"}
LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
BASEMAP_FILE = Path(os.environ.get("MCA_BASEMAP_FILE") or basemap.OUTPUT)
ADDRESSES_FILE = osm_addresses.OUTPUT
GEOCODED_FILE = ROOT / "data" / "local" / "geocoded_houses.csv"
YANDEX_SETTINGS = Path(os.environ.get("MCA_GEOCODER_CONFIG") or yandex_geocoder.SETTINGS)
YANDEX_CACHE = yandex_geocoder.CACHE
BOUNDARIES_DIR = osm_boundaries.OUT_DIR


# ---------------------------------------------------------------- настройки источников

def expand_path(p, base=None):
    """%USERPROFILE%, %ONEDRIVE%, ~ и $HOME раскрываются на любой ОС; кавычки по краям убираются.
    Относительный путь (например, data/input) считается от папки приложения."""
    s = str(p or "").strip().strip('"').strip("'").strip()
    s = re.sub(r"%([^%]+)%", lambda m: os.environ.get(m.group(1), os.environ.get(m.group(1).upper(), m.group(0))), s)
    s = os.path.expandvars(os.path.expanduser(s))
    if s and not os.path.isabs(s) and "%" not in s:
        s = os.path.normpath(os.path.join(str(base or ROOT), s))
    return s


def folder_candidates(raw):
    """Папка из настроек + запасные варианты для Рабочего стола в OneDrive."""
    first = expand_path(raw)
    cands = [first]
    low = raw.replace("/", "\\").lower() if raw else ""
    if "%userprofile%\\desktop" in low:
        tail = raw[low.index("%userprofile%\\desktop") + len("%userprofile%\\desktop"):]
        for base in (os.environ.get("OneDrive"), os.environ.get("ONEDRIVE"),
                     os.path.join(os.environ.get("USERPROFILE", ""), "OneDrive")):
            if base:
                cands.append(os.path.join(base, "Desktop") + tail)
                cands.append(os.path.join(base, "Рабочий стол") + tail)
    seen = []
    for c in cands:
        if c and c not in seen:
            seen.append(c)
    return seen


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def load_config():
    base = read_json(DEFAULT_CONFIG) or {"folder": "", "files": {}}
    local = read_json(LOCAL_CONFIG)
    cfg = {"folder": base.get("folder", ""), "files": dict(base.get("files", {})),
           "fallbackFolders": list(base.get("fallbackFolders", []))}
    if local:
        if "folder" in local:
            cfg["folder"] = local["folder"]
            cfg["fallbackFolders"] = []  # папку задал пользователь - запасные варианты не нужны
        cfg["files"].update(local.get("files", {}))
    cfg["files"] = {r: str(cfg["files"].get(r, "") or "") for r in ROLES}
    return cfg, bool(local)


def resolve_folder(raw, fallbacks=(), names=()):
    """Основная папка, затем запасные. Берётся первая, где лежит хотя бы один из нужных файлов;
    если файлов нет нигде - первая существующая папка."""
    cands = []
    for r in [raw, *fallbacks]:
        for c in folder_candidates(r):
            if c and c not in cands:
                cands.append(c)
    existing = [c for c in cands if os.path.isdir(c)]
    for c in existing:
        if any(n and os.path.isfile(resolve_file(c, n) or "") for n in names):
            return c, True
    if existing:
        return existing[0], True
    return (cands[0] if cands else ""), False


def resolve_file(folder, name):
    name = str(name or "").strip().strip('"').strip()
    if not name:
        return None
    # Относительное имя - внутри папки с выгрузками (а не папки приложения)
    return os.path.normpath(expand_path(name, base=folder))


def file_info(path):
    if not path:
        return {"path": "", "exists": False, "reason": "имя не задано"}
    ext = os.path.splitext(path)[1].lower()
    info = {"path": path, "exists": False}
    if ext not in ALLOWED_EXT:
        info["reason"] = "недопустимое расширение (нужно .csv, .xlsx, .geojson, .json или .txt)"
        return info
    if not os.path.isfile(path):
        info["reason"] = "файл не найден"
        return info
    st = os.stat(path)
    info.update(exists=True, size=st.st_size, mtime=int(st.st_mtime * 1000))
    return info


def sources_state():
    cfg, has_local = load_config()
    folder, folder_ok = resolve_folder(cfg["folder"], cfg["fallbackFolders"], [cfg["files"][r] for r in ROLES])
    listing = []
    if folder_ok:
        try:
            for n in sorted(os.listdir(folder)):
                if os.path.splitext(n)[1].lower() in ALLOWED_EXT and os.path.isfile(os.path.join(folder, n)):
                    listing.append(n)
        except OSError:
            pass
    files = {}
    for role, label in ROLES.items():
        name = cfg["files"][role]
        info = file_info(resolve_file(folder, name))
        files[role] = {"label": label, "name": name, **info}
    return {
        "folder": cfg["folder"], "folderResolved": folder, "folderExists": folder_ok,
        "folderFiles": listing[:500], "files": files, "roles": ROLES, "customized": has_local,
        "configFile": str(LOCAL_CONFIG), "inputFolder": str(ROOT / "data" / "input"),
    }


def save_config(data):
    if not isinstance(data, dict):
        raise ValueError("Ожидается JSON-объект")
    folder = str(data.get("folder", "") or "")[:1000]
    files_in = data.get("files") or {}
    if not isinstance(files_in, dict):
        raise ValueError("files должен быть объектом")
    files = {}
    for role in ROLES:
        v = str(files_in.get(role, "") or "")[:1000]
        files[role] = v
    LOCAL_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    tmp = LOCAL_CONFIG.with_suffix(".tmp")
    tmp.write_text(json.dumps({"folder": folder, "files": files}, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, LOCAL_CONFIG)


# ---------------------------------------------------------------- офлайн-карта

BASEMAP_JOB = basemap.Progress()
_basemap_thread = None
_basemap_lock = threading.Lock()


def basemap_state():
    st = basemap.status(BASEMAP_FILE)
    st["job"] = BASEMAP_JOB.snapshot()
    return st


def start_basemap(data):
    """Скачать или обновить карту в фоне. Прежний файл заменяется только после успешной загрузки."""
    global _basemap_thread
    if not isinstance(data, dict):
        raise ValueError("Ожидается JSON-объект")
    maxzoom = max(10, min(15, int(data.get("maxzoom") or basemap.DEFAULT_MAXZOOM)))
    source = data.get("source") or os.environ.get("MCA_BASEMAP_SOURCE") or None
    if source and not str(source).startswith(("http://", "https://")):
        raise ValueError("Источник карты должен быть адресом http(s)")
    with _basemap_lock:
        if _basemap_thread and _basemap_thread.is_alive():
            return False
        BASEMAP_JOB.reset()
        BASEMAP_JOB.set(state="running", stage="Подготовка")
        _basemap_thread = threading.Thread(target=basemap.download, args=(BASEMAP_JOB,), daemon=True,
                                           kwargs={"out": BASEMAP_FILE, "maxzoom": maxzoom, "source": source})
        _basemap_thread.start()
    return True


# ---------------------------------------------------------------- адреса OSM и найденные координаты

ADDR_JOB = basemap.Progress()
_addr_thread = None


def addresses_state():
    st = osm_addresses.status(ADDRESSES_FILE)
    st["job"] = ADDR_JOB.snapshot()
    st["geocodedFile"] = {"path": str(GEOCODED_FILE), "exists": GEOCODED_FILE.is_file()}
    return st


def start_addresses(data):
    global _addr_thread
    endpoints = None
    env = os.environ.get("MCA_OVERPASS_URL")
    if env:
        endpoints = [u for u in env.split(",") if u.startswith(("http://", "https://"))]
    with _basemap_lock:
        if _addr_thread and _addr_thread.is_alive():
            return False
        ADDR_JOB.reset()
        ADDR_JOB.set(state="running", stage="Подготовка")
        kwargs = {"out": ADDRESSES_FILE, "endpoints": endpoints}
        if env:  # свой сервер Overpass (или тестовый): без пауз и проверки объёма
            kwargs.update(pause=0, min_count=1)
        _addr_thread = threading.Thread(target=osm_addresses.download, args=(ADDR_JOB,), daemon=True, kwargs=kwargs)
        _addr_thread.start()
    return True


def save_geocoded(data):
    """Копия найденных координат на диске: data/local/geocoded_houses.csv (её можно снова импортировать)."""
    csv_text = data.get("csv") if isinstance(data, dict) else None
    if not isinstance(csv_text, str) or not csv_text.startswith("unom,"):
        raise ValueError("Ожидается CSV с колонками unom, lat, lon")
    GEOCODED_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = GEOCODED_FILE.with_name(GEOCODED_FILE.name + ".tmp")
    with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
        f.write(csv_text)
    basemap._replace(tmp, GEOCODED_FILE)
    return {"saved": str(GEOCODED_FILE), "size": GEOCODED_FILE.stat().st_size}


YA_JOB = basemap.Progress()
YA_JOB.results = {}
_ya_thread = None


def yandex_state():
    st = yandex_geocoder.public_state(YANDEX_SETTINGS, YANDEX_CACHE)
    st["job"] = YA_JOB.snapshot()
    return st


def start_yandex(data):
    global _ya_thread
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list) or not all(isinstance(x, dict) for x in items):
        raise ValueError("Ожидается список адресов items")
    items = [{"id": str(x.get("id", ""))[:100], "address": str(x.get("address", ""))[:500]} for x in items[:200000]]
    with _basemap_lock:
        if _ya_thread and _ya_thread.is_alive():
            return False
        YA_JOB.reset()
        YA_JOB.results = {}
        YA_JOB.set(state="running", stage="Подготовка", total=len(items))
        kwargs = {"settings_path": YANDEX_SETTINGS, "cache_path": YANDEX_CACHE}
        if os.environ.get("MCA_YANDEX_URL"):
            kwargs["rate"] = 0
        _ya_thread = threading.Thread(target=yandex_geocoder.run, args=(YA_JOB, items), kwargs=kwargs, daemon=True)
        _ya_thread.start()
    return True


BND_JOB = basemap.Progress()
_bnd_thread = None


def boundaries_state():
    st = osm_boundaries.status(BOUNDARIES_DIR)
    st["job"] = BND_JOB.snapshot()
    return st


def start_boundaries(data):
    global _bnd_thread
    data = data if isinstance(data, dict) else {}
    areas = [str(a)[:200] for a in (data.get("areas") or []) if isinstance(a, str)][:1000]
    email = str(data.get("email") or "")[:200]
    env = os.environ.get("MCA_OVERPASS_URL")
    with _basemap_lock:
        if _bnd_thread and _bnd_thread.is_alive():
            return False
        BND_JOB.reset()
        BND_JOB.set(state="running", stage="Подготовка")
        kwargs = {"out_dir": BOUNDARIES_DIR, "areas": areas, "email": email}
        if env:  # свои или тестовые серверы: без пауз
            kwargs.update(endpoints=[u for u in env.split(",") if u.startswith(("http://", "https://"))], pause=0)
        _bnd_thread = threading.Thread(target=osm_boundaries.download, args=(BND_JOB,), kwargs=kwargs, daemon=True)
        _bnd_thread.start()
    return True


# ---------------------------------------------------------------- HTTP

class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".html": "text/html; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".geojson": "application/geo+json; charset=utf-8",
        ".csv": "text/csv; charset=utf-8",
        ".pmtiles": "application/octet-stream",
        ".svg": "image/svg+xml",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):  # тише в консоли: только ошибки
        if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Accept-Ranges", "bytes")
        if not self.path.startswith("/data/local/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---- API «Папка с выгрузками» ----

    def _local_request(self):
        """Защита от чужих сайтов (DNS rebinding): API отвечает только на Host = localhost/127.0.0.1."""
        host = (self.headers.get("Host") or "").strip().lower()
        if host.startswith("["):
            hostname = host.split("]")[0] + "]"
        else:
            hostname = host.rsplit(":", 1)[0] if ":" in host else host
        return hostname in LOCAL_HOSTS

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api_get()
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith("/api/"):
            return self._json(405, {"error": "Метод не поддерживается"})
        if not self._local_request():
            return self._json(403, {"error": "Доступ только с localhost"})
        route = urllib.parse.urlsplit(self.path).path
        if route not in ("/api/sources", "/api/open-folder", "/api/basemap/download", "/api/basemap/cancel",
                         "/api/addresses/download", "/api/addresses/cancel", "/api/geocoded",
                         "/api/yandex/settings", "/api/yandex/start", "/api/yandex/cancel",
                         "/api/boundaries/download", "/api/boundaries/cancel"):
            return self._json(404, {"error": "Нет такого метода"})
        if not (self.headers.get("Content-Type") or "").lower().startswith("application/json"):
            return self._json(415, {"error": "Нужен Content-Type: application/json"})
        if route == "/api/open-folder":
            return self._open_folder()
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > (64 * 1024 * 1024 if route in ("/api/geocoded", "/api/yandex/start") else 65536):
                return self._json(413, {"error": "Слишком большой запрос"})
            data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            if route == "/api/geocoded":
                return self._json(200, save_geocoded(data))
            if route == "/api/boundaries/cancel":
                BND_JOB.cancel.set()
                return self._json(200, boundaries_state())
            if route == "/api/boundaries/download":
                if not start_boundaries(data):
                    return self._json(409, {"error": "Загрузка границ уже идёт", **boundaries_state()})
                return self._json(202, boundaries_state())
            if route == "/api/yandex/settings":
                yandex_geocoder.save_settings(data if isinstance(data, dict) else {}, YANDEX_SETTINGS)
                return self._json(200, yandex_state())
            if route == "/api/yandex/cancel":
                YA_JOB.cancel.set()
                return self._json(200, yandex_state())
            if route == "/api/yandex/start":
                if not start_yandex(data):
                    return self._json(409, {"error": "Поиск через Яндекс уже идёт", **yandex_state()})
                return self._json(202, yandex_state())
            if route == "/api/addresses/cancel":
                ADDR_JOB.cancel.set()
                return self._json(200, addresses_state())
            if route == "/api/addresses/download":
                if not start_addresses(data):
                    return self._json(409, {"error": "Загрузка адресов уже идёт", **addresses_state()})
                return self._json(202, addresses_state())
            if route == "/api/basemap/cancel":
                BASEMAP_JOB.cancel.set()
                return self._json(200, basemap_state())
            if route == "/api/basemap/download":
                if not start_basemap(data):
                    return self._json(409, {"error": "Загрузка карты уже идёт", **basemap_state()})
                return self._json(202, basemap_state())
            save_config(data)
        except (ValueError, OSError) as e:
            return self._json(400, {"error": str(e)})
        return self._json(200, sources_state())

    def _open_folder(self):
        """Открыть текущую папку с выгрузками в проводнике (только её, путь берётся из настроек)."""
        st = sources_state()
        folder = st["folderResolved"]
        if not os.path.isdir(folder):
            if os.path.normcase(os.path.normpath(folder)) != os.path.normcase(st["inputFolder"]):
                return self._json(404, {"error": "Папка не найдена: %s" % folder})
            os.makedirs(folder, exist_ok=True)  # data/input создаём по требованию
        try:
            if sys.platform.startswith("win"):
                os.startfile(folder)  # проводник Windows
            elif sys.platform == "darwin":
                import subprocess
                subprocess.Popen(["open", folder])
            else:
                import subprocess
                subprocess.Popen(["xdg-open", folder], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except OSError as e:
            return self._json(500, {"error": "Не удалось открыть папку: %s" % e, "folder": folder})
        return self._json(200, {"opened": folder})

    def _api_get(self):
        if not self._local_request():
            return self._json(403, {"error": "Доступ только с localhost"})
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/sources":
            return self._json(200, sources_state())
        if path == "/api/basemap":
            return self._json(200, basemap_state())
        if path == "/api/addresses":
            return self._json(200, addresses_state())
        if path == "/api/yandex":
            return self._json(200, yandex_state())
        if path == "/api/boundaries":
            return self._json(200, boundaries_state())
        if path == "/api/yandex/results":
            return self._json(200, {"results": dict(getattr(YA_JOB, "results", {}) or {})})
        m = re.fullmatch(r"/api/source/([a-z]+)", path)
        if not m:
            return self._json(404, {"error": "Нет такого метода"})
        role = m.group(1)
        if role not in ROLES:
            return self._json(404, {"error": "Неизвестная роль файла"})
        state = sources_state()
        info = state["files"][role]
        if not info.get("exists"):
            return self._json(404, {"error": "%s: %s" % (info.get("path") or info.get("name"), info.get("reason", "не найден"))})
        p = info["path"]
        try:
            f = open(p, "rb")
        except OSError as e:
            return self._json(500, {"error": str(e)})
        with f:
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(info["size"]))
            self.send_header("Last-Modified", email.utils.formatdate(info["mtime"] / 1000, usegmt=True))
            self.send_header("X-File-Name", urllib.parse.quote(os.path.basename(p)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                shutil.copyfileobj(f, self.wfile, 1024 * 1024)
            except (BrokenPipeError, ConnectionResetError):
                pass

    # ---- статические файлы с поддержкой Range ----

    def send_head(self):
        rng = self.headers.get("Range")
        path = self.translate_path(self.path)
        if not rng or os.path.isdir(path):
            return super().send_head()
        m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start_s, end_s = m.groups()
        if start_s == "" and end_s == "":
            return super().send_head()
        if start_s == "":  # суффикс: последние N байт
            length = int(end_s)
            start, end = max(0, size - length), size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", "bytes */%d" % size)
            self.end_headers()
            return None
        end = min(end, size - 1)
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._range_left = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        left = getattr(self, "_range_left", None)
        if left is None:
            return super().copyfile(source, outputfile)
        self._range_left = None
        while left > 0:
            chunk = source.read(min(65536, left))
            if not chunk:
                break
            outputfile.write(chunk)
            left -= len(chunk)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser(description="Локальный сервер «Аналитики покрытия»")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true", help="не открывать браузер автоматически")
    args = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # консоль Windows со старой кодовой страницей
        except (AttributeError, ValueError):
            pass
    url = "http://localhost:%d/" % args.port
    try:
        httpd = Server((args.host, args.port), Handler)
    except OSError as e:
        print("Не удалось занять порт %d: %s. Попробуйте --port 8080." % (args.port, e), file=sys.stderr)
        return 1
    st = sources_state()
    bm = basemap.status(BASEMAP_FILE)
    print("Аналитика покрытия: %s" % url)
    if bm["exists"]:
        build = (bm.get("meta") or {}).get("build") or ""
        print("Офлайн-карта: %s (%.0f МБ%s)" % (BASEMAP_FILE, bm["size"] / 1e6, ", сборка %s" % build if build else ""))
    else:
        print("Офлайн-карта: не скачана. Скачать можно в приложении: Карта, кнопка «Скачать карту Москвы».")
    print("Папка с выгрузками: %s (%s)" % (st["folderResolved"] or "(не задана)", "найдена" if st["folderExists"] else "НЕ найдена"))
    for role, info in st["files"].items():
        if info["name"]:
            print("  %-9s %s %s" % (role, "найден   " if info["exists"] else "не найден", info["name"]))
    print("Путь и имена файлов меняются в приложении: «Импорт и данные», кнопка «Папка с выгрузками».")
    print("Остановить: Ctrl+C")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
