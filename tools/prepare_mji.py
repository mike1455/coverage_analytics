#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Однократное преобразование реестра МЖИ из XLSX в CSV (UTF-8 с BOM) без сторонних библиотек.

Приложение читает XLSX и само, этот скрипт нужен, если удобнее хранить реестр в CSV.
Все значения выгружаются как текст: UNOM и ФИАС не превращаются в числа, ведущие нули сохраняются.

    py -3 tools/prepare_mji.py "C:\\EDC_2026\\19.10.26_МКД_....xlsx" --output data\\local\\mji.csv
"""
import argparse
import csv
import re
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def col_index(ref):
    n = 0
    for ch in ref:
        if not ch.isalpha():
            break
        n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1


def text_of(el):
    """Текст <si>/<is>: прямой <t> и форматированные фрагменты <r><t>; фонетика <rPh> пропускается."""
    if el is None:
        return ""
    parts = []
    for child in el:
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "t":
            parts.append(child.text or "")
        elif tag == "r":
            t = child.find("m:t", NS)
            parts.append((t.text or "") if t is not None else "")
    return "".join(parts)


def first_sheet(z):
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    sheet = wb.find("m:sheets/m:sheet", NS)
    rid = sheet.get("{%s}id" % REL_NS)
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    for r in rels:
        if r.get("Id") == rid:
            target = r.get("Target").lstrip("/")
            return sheet.get("name"), target if target.startswith("xl/") else "xl/" + target
    raise ValueError("Не найден первый лист")


def read_xlsx(path):
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
                shared.append(text_of(si))
        name, sheet_path = first_sheet(z)
        rows = []
        with z.open(sheet_path) as f:
            for _, el in ET.iterparse(f, events=("end",)):
                if el.tag != "{%s}row" % NS["m"]:
                    continue
                row = []
                for c in el.findall("m:c", NS):
                    ci = col_index(c.get("r", "")) if c.get("r") else len(row)
                    t = c.get("t", "n")
                    v = c.find("m:v", NS)
                    if t == "inlineStr":
                        val = text_of(c.find("m:is", NS))
                    elif t == "s":
                        val = shared[int(v.text)] if v is not None and v.text else ""
                    elif t == "b":
                        val = "true" if v is not None and v.text == "1" else "false"
                    else:
                        val = v.text if v is not None and v.text is not None else ""
                        if re.fullmatch(r"-?\d+\.0+", val):
                            val = val.split(".")[0]
                    while len(row) < ci:
                        row.append("")
                    row.append(val)
                rows.append(row)
                el.clear()
    while rows and all(x == "" for x in rows[-1]):
        rows.pop()
    return name, rows


def main():
    ap = argparse.ArgumentParser(description="МЖИ: XLSX → CSV (текстовые значения, UTF-8 с BOM)")
    ap.add_argument("xlsx")
    ap.add_argument("--output", help="CSV; по умолчанию рядом с XLSX")
    args = ap.parse_args()
    src = Path(args.xlsx)
    out = Path(args.output) if args.output else src.with_suffix(".csv")
    if out.resolve() == src.resolve():
        print("ОШИБКА: нельзя перезаписать исходный файл", file=sys.stderr)
        return 1
    name, rows = read_xlsx(src)
    if not rows:
        print("ОШИБКА: лист пуст", file=sys.stderr)
        return 1
    header = [h.strip() for h in rows[0]]
    width = len(header)
    data = [r + [""] * (width - len(r)) for r in rows[1:]]
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(r[:width] for r in data)
    # Короткая сводка качества
    idx = {h: i for i, h in enumerate(header)}
    unom = idx.get("UNOM", idx.get("УНОМ"))
    fias = idx.get("ФИАС")
    okrug = idx.get("Округ")
    print(f"Лист «{name}»: {len(data)} строк → {out}")
    if unom is not None:
        c = Counter(r[unom].strip().lstrip("0") for r in data if r[unom].strip())
        print(f"  уникальных UNOM: {len(c)}; повторов: {sum(1 for v in c.values() if v > 1)}; пустых: {sum(1 for r in data if not r[unom].strip())}")
    if fias is not None:
        vals = [r[fias].strip() for r in data]
        print(f"  без ФИАС: {sum(1 for v in vals if not v)}; некорректных (не UUID): {sum(1 for v in vals if v and not UUID_RE.match(v))}")
    if okrug is not None:
        c = Counter(r[okrug].strip() or "(без округа)" for r in data)
        print("  по округам: " + ", ".join(f"{k} {v}" for k, v in c.most_common()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
