#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Офлайн-подложка Москвы: вырезка из ежедневной сборки OpenStreetMap (Protomaps, формат PMTiles).

Почему так, а не «скачать тайлы Яндекса/2ГИС/OSM»:
  * условия Яндекс.Карт и 2ГИС запрещают выгрузку и хранение их тайлов вне их API;
  * политика tile.openstreetmap.org запрещает массовое скачивание тайлов;
  * Protomaps публикует сборки из данных OSM (лицензия ODbL) специально для вырезки и самостоятельного хостинга.

Результат: data/local/moscow.pmtiles (один файл, обычно 100–400 МБ при maxzoom 15).
Приложение подключает его автоматически, если запущено через `py -3 serve.py` (нужна поддержка HTTP Range).

Нужна утилита pmtiles (go-pmtiles): https://github.com/protomaps/go-pmtiles/releases
  Windows: скачайте go-pmtiles_*_Windows_x86_64.zip и положите pmtiles.exe в tools\\bin\\ (или в PATH).

    py -3 tools/get_basemap.py                 # последняя доступная сборка, zoom до 15
    py -3 tools/get_basemap.py --maxzoom 14    # меньше файл
    py -3 tools/get_basemap.py --dry-run       # только показать команду
"""
import argparse
import datetime as dt
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILDS = "https://build.protomaps.com/{date}.pmtiles"
# Москва в границах 2012 г. с ТиНАО и Зеленоградом, с небольшим запасом
MOSCOW_BBOX = (36.80, 55.13, 37.97, 56.03)


def find_cli(explicit=None):
    cands = [explicit] if explicit else []
    cands += [str(ROOT / "tools" / "bin" / "pmtiles.exe"), str(ROOT / "tools" / "bin" / "pmtiles")]
    for c in cands:
        if c and Path(c).is_file():
            return c
    return shutil.which("pmtiles")


def build_exists(date, timeout=20):
    req = urllib.request.Request(BUILDS.format(date=date), method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def latest_build(today=None, days=10, probe=build_exists):
    today = today or dt.date.today()
    for i in range(1, days + 1):
        d = (today - dt.timedelta(days=i)).strftime("%Y%m%d")
        if probe(d):
            return d
    return None


def extract_command(cli, date, out, maxzoom, bbox=MOSCOW_BBOX):
    return [cli, "extract", BUILDS.format(date=date), str(out),
            "--bbox=%s" % ",".join("%.2f" % v for v in bbox), "--maxzoom=%d" % maxzoom]


def main():
    ap = argparse.ArgumentParser(description="Скачать офлайн-подложку Москвы (OSM → PMTiles)")
    ap.add_argument("--build", help="дата сборки Protomaps ГГГГММДД (по умолчанию — последняя доступная)")
    ap.add_argument("--maxzoom", type=int, default=15, help="максимальный zoom (15 — уровень зданий; 14 — меньше файл)")
    ap.add_argument("--pmtiles", help="путь к утилите pmtiles / pmtiles.exe")
    ap.add_argument("--output", default=str(ROOT / "data" / "local" / "moscow.pmtiles"))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cli = find_cli(args.pmtiles)
    if not cli and not args.dry_run:
        print("Не найдена утилита pmtiles.\n"
              "  1) Скачайте архив для вашей ОС: https://github.com/protomaps/go-pmtiles/releases\n"
              "  2) Положите pmtiles.exe в папку tools\\bin\\ приложения (или укажите --pmtiles ПУТЬ).\n"
              "  3) Повторите: py -3 tools/get_basemap.py", file=sys.stderr)
        return 2
    date = args.build or (None if args.dry_run else latest_build())
    if not date:
        if args.dry_run:
            date = "ГГГГММДД"
        else:
            print("Не удалось найти сборку на build.protomaps.com за последние 10 дней (нет интернета?). "
                  "Укажите --build ГГГГММДД вручную.", file=sys.stderr)
            return 3
    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    cmd = extract_command(cli or "pmtiles", date, out, args.maxzoom)
    print("Команда:", " ".join(cmd))
    if args.dry_run:
        return 0
    print("Скачивание вырезки Москвы… (несколько минут; загружаются только нужные участки сборки)")
    res = subprocess.run(cmd)
    if res.returncode != 0:
        print("pmtiles завершилась с ошибкой %d" % res.returncode, file=sys.stderr)
        return res.returncode
    size = out.stat().st_size if out.exists() else 0
    print("Готово: %s (%.1f МБ). Данные © участники OpenStreetMap (ODbL), сборка Protomaps." % (out, size / 1e6))
    print("Запускайте приложение через: py -3 serve.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
