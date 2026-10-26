# -*- coding: utf-8 -*-
"""Тесты Python-инструментов (стандартная библиотека): py -3 -m unittest discover -s tests -p "test_*.py" """
import csv
import datetime as dt
import filecmp
import http.server
import importlib.util
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures" / "synthetic"
PY = sys.executable


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class SyntheticFixtures(unittest.TestCase):
    def test_generator_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([PY, str(ROOT / "tools" / "make_synthetic_data.py"), "--houses", "400", "--seed", "7", "--out", tmp],
                           check=True, capture_output=True)
            for name in ("01_дома.csv", "02_подъезды.csv", "03_заявки_2026.csv", "mji_synthetic.csv"):
                self.assertTrue(filecmp.cmp(Path(tmp) / name, FIX / name, shallow=False), name)


class MergeScriptsS2(unittest.TestCase):
    """Скрипты из инструкции S2 дают ровно эталонные файлы, по которым проверяется JS-ядро (tests/parity.test.mjs)."""

    def run_tool(self, script, *args):
        return subprocess.run([PY, str(ROOT / "tools" / script), *args], capture_output=True, text=True, encoding="utf-8")

    def test_houses(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "houses.csv"
            r = self.run_tool("merge_edc_houses.py", "--houses", str(FIX / "01_дома.csv"), "--requests", str(FIX / "03_заявки_2026.csv"), "--output", str(out))
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertTrue(filecmp.cmp(out, FIX / "expected_houses_merged.csv", shallow=False))
            self.assertEqual(Path(str(out) + ".control.txt").read_text(encoding="utf-8"),
                             (FIX / "expected_houses_merged.csv.control.txt").read_text(encoding="utf-8"))

    def test_entrances_both_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            for extra, expected in (([], "expected_entrances_merged.csv"), (["--match-by-number"], "expected_entrances_merged_by_number.csv")):
                out = Path(tmp) / expected
                r = self.run_tool("merge_edc_entrances.py", "--entrances", str(FIX / "02_подъезды.csv"), "--requests", str(FIX / "03_заявки_2026.csv"), "--output", str(out), *extra)
                self.assertEqual(r.returncode, 0, r.stderr)
                self.assertTrue(filecmp.cmp(out, FIX / expected, shallow=False), expected)

    def test_rows_preserved(self):
        with open(FIX / "expected_houses_merged.csv", encoding="utf-8-sig", newline="") as f:
            self.assertEqual(sum(1 for _ in csv.reader(f)) - 1, 400)


class PrepareMji(unittest.TestCase):
    def test_xlsx_to_csv_keeps_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "mji.csv"
            r = subprocess.run([PY, str(ROOT / "tools" / "prepare_mji.py"), str(ROOT / "tests" / "fixtures" / "mji_small.xlsx"), "--output", str(out)],
                               capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(r.returncode, 0, r.stderr)
            with open(out, encoding="utf-8-sig", newline="") as f:
                rows = list(csv.reader(f))
            self.assertEqual(rows[0], ["Код", "Округ", "Район", "Наименование/адрес", "ФИАС", "UNOM", "Управляющая организация"])
            self.assertEqual(len(rows), 6)
            self.assertEqual(rows[1][5], "15425")
            self.assertEqual(rows[1][6], 'ТСЖ "ТЕСТ" & <партнёры>')
            self.assertEqual(rows[5][5], "0004400873")
            self.assertEqual(rows[5][6], "ООО «УК»\nвторая строка")
            self.assertIn("некорректных (не UUID): 2", r.stdout)


class ServeRange(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        serve = load("serve", ROOT / "serve.py")
        cls.httpd = serve.Server(("127.0.0.1", 0), serve.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.body = (ROOT / "index.html").read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def get(self, headers=None):
        req = urllib.request.Request("http://127.0.0.1:%d/index.html" % self.port, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, dict(r.headers), r.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), b""

    def test_full(self):
        st, h, b = self.get()
        self.assertEqual(st, 200)
        self.assertEqual(b, self.body)
        self.assertEqual(h.get("Accept-Ranges"), "bytes")

    def test_range(self):
        st, h, b = self.get({"Range": "bytes=2-11"})
        self.assertEqual(st, 206)
        self.assertEqual(b, self.body[2:12])
        self.assertEqual(h["Content-Range"], "bytes 2-11/%d" % len(self.body))

    def test_suffix_and_open_end(self):
        self.assertEqual(self.get({"Range": "bytes=-5"})[2], self.body[-5:])
        self.assertEqual(self.get({"Range": "bytes=%d-" % (len(self.body) - 3)})[2], self.body[-3:])

    def test_unsatisfiable(self):
        self.assertEqual(self.get({"Range": "bytes=%d-" % (len(self.body) + 10)})[0], 416)


class Basemap(unittest.TestCase):
    def setUp(self):
        self.gb = load("get_basemap", ROOT / "tools" / "get_basemap.py")

    def test_latest_build_probes_backwards(self):
        seen = []

        def probe(d):
            seen.append(d)
            return d == "20261023"
        self.assertEqual(self.gb.latest_build(dt.date(2026, 10, 26), probe=probe), "20261023")
        self.assertEqual(seen, ["20261025", "20261024", "20261023"])
        self.assertIsNone(self.gb.latest_build(dt.date(2026, 10, 26), probe=lambda d: False))

    def test_extract_command(self):
        cmd = self.gb.extract_command("pmtiles", "20261025", Path("out.pmtiles"), 15)
        self.assertEqual(cmd, ["pmtiles", "extract", "https://build.protomaps.com/20261025.pmtiles", "out.pmtiles",
                               "--bbox=36.80,55.13,37.97,56.03", "--maxzoom=15"])


if __name__ == "__main__":
    unittest.main()
