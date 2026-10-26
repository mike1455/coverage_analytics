#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Локальный сервер приложения: http://localhost:8000 (только стандартная библиотека Python 3.8+).

Отличия от `python -m http.server 8000`:
  * поддерживает HTTP Range — нужно для офлайн-подложки data/local/moscow.pmtiles;
  * слушает только 127.0.0.1 (данные не видны в локальной сети);
  * правильные MIME-типы для .js/.mjs/.pmtiles/.geojson и отключённый кэш для файлов приложения.

Запуск (Windows):  py -3 serve.py            (порт по умолчанию 8000)
                   py -3 serve.py --port 8080
"""
import argparse
import http.server
import os
import re
import socketserver
import sys
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent


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
        self.send_header("Accept-Ranges", "bytes")
        if not self.path.startswith("/data/local/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

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
    ap = argparse.ArgumentParser(description="Локальный сервер Moscow Coverage Analytics")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--no-browser", action="store_true", help="не открывать браузер автоматически")
    args = ap.parse_args()
    url = "http://localhost:%d/" % args.port
    try:
        httpd = Server((args.host, args.port), Handler)
    except OSError as e:
        print("Не удалось занять порт %d: %s. Попробуйте --port 8080." % (args.port, e), file=sys.stderr)
        return 1
    pm = ROOT / "data" / "local" / "moscow.pmtiles"
    print("Moscow Coverage Analytics: %s" % url)
    print("Офлайн-подложка: %s" % ("найдена" if pm.exists() else "нет (data/local/moscow.pmtiles) — будет онлайн-подложка"))
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
