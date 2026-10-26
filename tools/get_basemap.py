#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Скачать или обновить офлайн-карту Москвы из командной строки.

То же самое делает кнопка «Скачать карту Москвы» в приложении (раздел «Импорт и качество данных»).
Результат: data/local/moscow.pmtiles, данные OpenStreetMap (ODbL) из сборки Protomaps.
Внешние утилиты не нужны, только Python 3.8+ и доступ к build.protomaps.com.

    py -3 tools/get_basemap.py                  # последняя сборка, детализация до zoom 15
    py -3 tools/get_basemap.py --maxzoom 14     # файл меньше, без самых крупных масштабов
    py -3 tools/get_basemap.py --build 20261020 # конкретная дата сборки
"""
import argparse
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import basemap  # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="Офлайн-карта Москвы (OpenStreetMap, PMTiles)")
    ap.add_argument("--build", help="дата сборки Protomaps ГГГГММДД (по умолчанию последняя доступная)")
    ap.add_argument("--source", help="другой источник: адрес или путь к файлу .pmtiles")
    ap.add_argument("--maxzoom", type=int, default=basemap.DEFAULT_MAXZOOM,
                    help="максимальный масштаб: 15 с домами, 14 файл меньше")
    ap.add_argument("--output", default=str(basemap.OUTPUT))
    args = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass

    progress = basemap.Progress()
    worker = threading.Thread(target=basemap.download, args=(progress,), daemon=True, kwargs={
        "out": Path(args.output), "maxzoom": args.maxzoom, "source": args.source, "build": args.build})
    worker.start()
    last = ""
    try:
        while worker.is_alive():
            s = progress.snapshot()
            line = s["stage"]
            if s["total"]:
                line += ": %.0f из %.0f МБ" % (s["done"] / 1e6, s["total"] / 1e6)
            if line != last:
                print("\r" + line.ljust(70), end="", flush=True)
                last = line
            time.sleep(0.5)
    except KeyboardInterrupt:
        progress.cancel.set()
        worker.join()
    print()
    s = progress.snapshot()
    if s["state"] != "done":
        print(s["message"] or "Карта не скачана", file=sys.stderr)
        return 1
    st = basemap.status(args.output)
    print("Готово: %s (%.0f МБ). Данные © участники OpenStreetMap (ODbL), сборка Protomaps." % (args.output, st["size"] / 1e6))
    return 0


if __name__ == "__main__":
    sys.exit(main())
