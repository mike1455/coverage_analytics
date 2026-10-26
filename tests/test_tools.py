# -*- coding: utf-8 -*-
"""Тесты Python-инструментов (стандартная библиотека): py -3 -m unittest discover -s tests -p "test_*.py" """
import csv
import datetime as dt
import filecmp
import http.server
import importlib.util
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
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


class SourcesApi(unittest.TestCase):
    """API «Папка с выгрузками»: настройки, статусы, отдача файлов, защита от чужих сайтов."""

    NAMES = {
        "houses": "Запрос № 2. Выгрузка № 1 — ВСЕ адреса, одна строка на дом.csv",
        "requests": "Запрос № 4. Выгрузка № 3 — заявки 2026 по дому И по подъезду в ОДНОМ файле.csv",
    }

    @classmethod
    def setUpClass(cls):
        cls.serve = load("serve_sources", ROOT / "serve.py")
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        cls.folder = base / "ФАЙЛЫ ИТОГ"
        cls.folder.mkdir()
        (cls.folder / cls.NAMES["houses"]).write_bytes((FIX / "01_дома.csv").read_bytes())
        (cls.folder / "секрет.exe").write_bytes(b"x")
        cls.serve.DEFAULT_CONFIG = base / "default.json"
        cls.serve.LOCAL_CONFIG = base / "local.json"
        cls.serve.DEFAULT_CONFIG.write_text(json.dumps({"folder": "%MCA_TEST_DIR%", "files": {"houses": cls.NAMES["houses"], "requests": cls.NAMES["requests"]}}), encoding="utf-8")
        os.environ["MCA_TEST_DIR"] = str(cls.folder)
        cls.httpd = cls.serve.Server(("127.0.0.1", 0), cls.serve.Handler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def req(self, path, data=None, headers=None, method=None):
        h = {"Host": "localhost:%d" % self.port, **(headers or {})}
        body = json.dumps(data).encode("utf-8") if data is not None else None
        if body is not None and "Content-Type" not in h:
            h["Content-Type"] = "application/json"
        r = urllib.request.Request("http://127.0.0.1:%d%s" % (self.port, path), data=body, headers=h, method=method)
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_state_and_env_expansion(self):
        st, _, b = self.req("/api/sources")
        self.assertEqual(st, 200)
        d = json.loads(b)
        self.assertTrue(d["folderExists"])
        self.assertTrue(d["files"]["houses"]["exists"])
        self.assertFalse(d["files"]["requests"]["exists"])
        self.assertEqual(d["files"]["geo"]["reason"], "имя не задано")
        self.assertIn(self.NAMES["houses"], d["folderFiles"])
        self.assertNotIn("секрет.exe", d["folderFiles"])

    def test_file_download_keeps_bytes_and_name(self):
        st, h, b = self.req("/api/source/houses")
        self.assertEqual(st, 200)
        self.assertEqual(b, (FIX / "01_дома.csv").read_bytes())
        self.assertEqual(urllib.parse.unquote(h["X-File-Name"]), self.NAMES["houses"])

    def test_save_names_and_full_path(self):
        (self.folder / "другое имя.csv").write_bytes(b"a,b\n")
        st, _, b = self.req("/api/sources", {"folder": str(self.folder), "files": {"houses": self.NAMES["houses"], "requests": "другое имя.csv", "mji": str(self.folder / "другое имя.csv")}})
        self.assertEqual(st, 200)
        d = json.loads(b)
        self.assertTrue(d["files"]["requests"]["exists"])
        self.assertTrue(d["files"]["mji"]["exists"], "полный путь вместо имени")
        self.assertEqual(json.loads(self.serve.LOCAL_CONFIG.read_text(encoding="utf-8"))["files"]["requests"], "другое имя.csv")
        self.req("/api/sources", {"folder": "%MCA_TEST_DIR%", "files": {"houses": self.NAMES["houses"], "requests": self.NAMES["requests"]}})

    def test_disallowed_extension_not_served(self):
        self.req("/api/sources", {"folder": str(self.folder), "files": {"geo": "секрет.exe"}})
        st, _, b = self.req("/api/sources")
        self.assertIn("недопустимое расширение", json.loads(b)["files"]["geo"]["reason"])
        self.assertEqual(self.req("/api/source/geo")[0], 404)
        self.req("/api/sources", {"folder": "%MCA_TEST_DIR%", "files": {"houses": self.NAMES["houses"], "requests": self.NAMES["requests"]}})

    def test_open_folder_guarded(self):
        self.assertEqual(self.req("/api/open-folder", data={}, headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.req("/api/open-folder", data={}, headers={"Content-Type": "text/plain"})[0], 415)

    def test_foreign_host_and_bad_requests(self):
        self.assertEqual(self.req("/api/sources", headers={"Host": "evil.example:80"})[0], 403)
        self.assertEqual(self.req("/api/source/houses", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.req("/api/source/unknown")[0], 404)
        st = self.req("/api/sources", data={"folder": "x"}, headers={"Content-Type": "text/plain"})[0]
        self.assertEqual(st, 415, "простые запросы с других сайтов не могут менять настройки")


class FolderResolution(unittest.TestCase):
    """Папка по умолчанию data/input внутри приложения, запасная - на рабочем столе."""

    def test_defaults_point_to_data_input_with_user_names(self):
        cfg = json.loads((ROOT / "config" / "sources.default.json").read_text(encoding="utf-8"))
        self.assertEqual(cfg["folder"], "data/input")
        self.assertIn("ФАЙЛЫ ИТОГ", cfg["fallbackFolders"][0])
        self.assertEqual(cfg["files"]["houses"], "Запрос № 2. Выгрузка № 1 — ВСЕ адреса, одна строка на дом.csv")
        self.assertTrue(cfg["files"]["mji"].endswith("202610191348.xlsx"))
        self.assertTrue((ROOT / "data" / "input" / "README.md").is_file())

    def test_relative_primary_and_fallback(self):
        serve = load("serve_folders", ROOT / "serve.py")
        with tempfile.TemporaryDirectory() as tmp:
            app = Path(tmp) / "app"
            (app / "data" / "input").mkdir(parents=True)
            desk = Path(tmp) / "Рабочий стол" / "ФАЙЛЫ ИТОГ"
            desk.mkdir(parents=True)
            (desk / "дома.csv").write_text("x", encoding="utf-8")
            serve.ROOT = app
            folder, ok = serve.resolve_folder("data/input", [str(desk)], ["дома.csv"])
            self.assertTrue(ok)
            self.assertEqual(Path(folder), desk, "в data/input пусто - берётся запасная папка с файлами")
            (app / "data" / "input" / "дома.csv").write_text("x", encoding="utf-8")
            folder, _ = serve.resolve_folder("data/input", [str(desk)], ["дома.csv"])
            self.assertEqual(Path(folder), app / "data" / "input", "файлы есть в data/input - она главнее")
            folder, _ = serve.resolve_folder("data/input", [str(desk)], ["нет-такого.csv"])
            self.assertEqual(Path(folder), app / "data" / "input")


BM = load("basemap_mod", ROOT / "tools" / "basemap.py")


def write_source(path, tiles, leaf_size=None, tile_compression=1):
    """Синтетический PMTiles v3 в стиле сборок Protomaps: кластеризованный, с дедупликацией и
    при leaf_size с листовыми каталогами (в т.ч. вложенными)."""
    data = bytearray()
    seen = {}
    entries = []
    for tid in sorted(tiles):
        body = tiles[tid]
        if body not in seen:
            seen[body] = len(data)
            data += body
        off = seen[body]
        last = entries[-1] if entries else None
        if last and last.offset == off and last.tile_id + last.run_length == tid:
            last.run_length += 1
        else:
            entries.append(BM.Entry(tid, off, len(body), 1))
    leaves = bytearray()
    level = entries
    if leaf_size:
        while len(level) > leaf_size:
            ptrs = []
            for i in range(0, len(level), leaf_size):
                chunk = level[i:i + leaf_size]
                ser = BM.compress(BM.serialize_dir(chunk), 2)
                ptrs.append(BM.Entry(chunk[0].tile_id, len(leaves), len(ser), 0))
                leaves += ser
            level = ptrs
    root = BM.compress(BM.serialize_dir(level), 2)
    meta = BM.compress(json.dumps({"name": "synthetic", "vector_layers": []}).encode(), 2)
    zs = sorted({z for z in range(0, 20) for t in tiles if ((1 << 2 * z) - 1) // 3 <= t < ((1 << 2 * (z + 1)) - 1) // 3})
    hd = {
        "root_offset": BM.HEADER_LEN, "root_length": len(root),
        "metadata_offset": BM.HEADER_LEN + len(root), "metadata_length": len(meta),
        "leaf_offset": BM.HEADER_LEN + len(root) + len(meta), "leaf_length": len(leaves),
        "data_offset": BM.HEADER_LEN + len(root) + len(meta) + len(leaves), "data_length": len(data),
        "addressed_tiles": len(tiles), "tile_entries": len(entries), "tile_contents": len(seen),
        "clustered": 1, "internal_compression": 2, "tile_compression": tile_compression, "tile_type": 1,
        "min_zoom": zs[0], "max_zoom": zs[-1], "min_lon": -1800000000, "min_lat": -850000000,
        "max_lon": 1800000000, "max_lat": 850000000, "center_zoom": 0, "center_lon": 0, "center_lat": 0,
    }
    Path(path).write_bytes(BM.pack_header(hd) + root + meta + bytes(leaves) + bytes(data))


def synthetic_tiles(maxzoom=12, bbox=(36.0, 54.6, 39.0, 56.6)):
    """Тайлы вокруг Москвы: уникальные, повторяющиеся («вода») и пропуски."""
    tiles = {}
    for z in range(0, maxzoom + 1):
        x0, y0 = BM.lonlat_to_tile(bbox[0], bbox[3], z)
        x1, y1 = BM.lonlat_to_tile(bbox[2], bbox[1], z)
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                if z >= 9 and (x + y) % 7 == 0:
                    continue  # тайла нет в сборке
                body = b"water" if z >= 10 and x % 5 == 0 else ("%d/%d/%d|" % (z, x, y)).encode() * (1 + (x * y) % 9)
                tiles[BM.zxy_to_tileid(z, x, y)] = body
    return tiles


def tiles_in(bbox, z):
    x0, y0 = BM.lonlat_to_tile(bbox[0], bbox[3], z)
    x1, y1 = BM.lonlat_to_tile(bbox[2], bbox[1], z)
    return [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]


def mvt(name):
    """Минимальный векторный тайл (MVT) с одним пустым слоем: его без ошибок читает protomaps-leaflet."""
    def varint(v):
        out = bytearray()
        BM.write_varint(out, v)
        return bytes(out)
    nb = name.encode()
    layer = b"\x78\x02" + b"\x0a" + varint(len(nb)) + nb + b"\x28" + varint(4096)
    return b"\x1a" + varint(len(layer)) + layer


def write_e2e_source(path):
    """Источник для сквозного теста: печатает контрольные тайлы для проверки читателем PMTiles в браузере."""
    import base64
    tiles = {}
    for z in range(0, 12):
        for x, y in tiles_in((36.0, 54.6, 39.0, 56.6), z):
            tiles[BM.zxy_to_tileid(z, x, y)] = mvt("t%d_%d_%d" % (z, x, y))
    write_source(path, tiles, leaf_size=64)
    samples = []
    for z in (0, 6, 9, 11):
        cand = tiles_in(BM.MOSCOW_BBOX, z)
        for x, y in cand[::max(1, len(cand) // 3)][:3]:
            samples.append([z, x, y, base64.b64encode(tiles[BM.zxy_to_tileid(z, x, y)]).decode()])
    x, y = BM.lonlat_to_tile(36.1, 56.5, 11)
    samples.append([11, x, y, None])  # вне Москвы: в вырезку не попадает
    print(json.dumps(samples))


class Basemap(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.tiles = synthetic_tiles()
        cls.src = cls.dir / "planet.pmtiles"
        write_source(cls.src, cls.tiles, leaf_size=40)  # корень → листья листьев → листья

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_tile_ids_match_spec(self):
        # Контрольные значения из спецификации PMTiles v3
        self.assertEqual([BM.zxy_to_tileid(*t) for t in [(0, 0, 0), (1, 0, 0), (1, 0, 1), (1, 1, 1), (1, 1, 0), (2, 0, 0)]],
                         [0, 1, 2, 3, 4, 5])
        self.assertEqual(BM.zxy_to_tileid(3, 7, 0), 84)
        self.assertEqual(BM.zxy_to_tileid(20, 0, 0), 366503875925)
        ids = {BM.zxy_to_tileid(4, x, y) for x in range(16) for y in range(16)}
        self.assertEqual(ids, set(range(85, 85 + 256)))  # биекция внутри уровня

    def test_directory_roundtrip(self):
        es = [BM.Entry(5, 0, 10, 1), BM.Entry(6, 10, 7, 3), BM.Entry(20, 0, 10, 1), BM.Entry(300000, 17, 1, 0)]
        back = BM.deserialize_dir(BM.serialize_dir(es))
        self.assertEqual([(e.tile_id, e.offset, e.length, e.run_length) for e in back],
                         [(e.tile_id, e.offset, e.length, e.run_length) for e in es])

    def check_extract(self, out, maxzoom):
        hd = BM.parse_header(out.read_bytes()[:BM.HEADER_LEN])
        self.assertEqual((hd["min_zoom"], hd["max_zoom"]), (0, maxzoom))
        n = 0
        for z in range(0, maxzoom + 1):
            for x, y in tiles_in(BM.MOSCOW_BBOX, z):
                want = self.tiles.get(BM.zxy_to_tileid(z, x, y))
                self.assertEqual(BM.read_tile(str(out), z, x, y), want, (z, x, y))
                n += want is not None
        self.assertEqual(hd["addressed_tiles"], n)
        # за пределами Москвы и глубже maxzoom тайлов нет
        x0, y0 = BM.lonlat_to_tile(36.1, 56.5, maxzoom)
        self.assertIsNone(BM.read_tile(str(out), maxzoom, x0, y0))
        x, y = BM.lonlat_to_tile(37.6, 55.75, maxzoom + 1)
        self.assertIsNone(BM.read_tile(str(out), maxzoom + 1, x, y))
        self.assertLess(out.stat().st_size, self.src.stat().st_size)

    def test_extract_from_file_with_nested_leaves(self):
        out = self.dir / "a" / "moscow.pmtiles"
        info = BM.extract(str(self.src), out=out, maxzoom=11)
        self.check_extract(out, 11)
        self.assertEqual(json.loads(BM.meta_path(out).read_text(encoding="utf-8"))["tiles"], info["tiles"])
        self.assertFalse(out.with_name(out.name + ".download").exists())

    def test_output_with_leaf_directories(self):
        out = self.dir / "b" / "moscow.pmtiles"
        old = BM.ROOT_LIMIT
        BM.ROOT_LIMIT = BM.HEADER_LEN + 200  # заставить писать листовые каталоги
        try:
            BM.extract(str(self.src), out=out, maxzoom=12)
        finally:
            BM.ROOT_LIMIT = old
        self.assertGreater(BM.parse_header(out.read_bytes()[:BM.HEADER_LEN])["leaf_length"], 0)
        self.check_extract(out, 12)

    def test_cancel_keeps_previous_map(self):
        out = self.dir / "c" / "moscow.pmtiles"
        out.parent.mkdir()
        out.write_bytes(b"old map")
        progress = BM.Progress()

        class Slow(BM.FileSource):
            calls = 0

            def read(s, offset, length):
                Slow.calls += 1
                if Slow.calls > 3:
                    progress.cancel.set()
                return super().read(offset, length)
        orig = BM.open_source
        BM.open_source = lambda src: Slow(src)
        try:
            with self.assertRaises(BM.Cancelled):
                BM.extract(str(self.src), out=out, maxzoom=12, progress=progress, workers=1)
        finally:
            BM.open_source = orig
        self.assertEqual(out.read_bytes(), b"old map")
        self.assertEqual(sorted(p.name for p in out.parent.iterdir()), ["moscow.pmtiles"])

    def test_latest_build_probes_backwards(self):
        seen = []

        def probe(d):
            seen.append(d)
            return d == "20261024"
        self.assertEqual(BM.latest_build(dt.date(2026, 10, 26), probe=probe), "20261024")
        self.assertEqual(seen, ["20261026", "20261025", "20261024"])
        self.assertIsNone(BM.latest_build(dt.date(2026, 10, 26), probe=lambda d: False))


class BasemapHttp(unittest.TestCase):
    """Загрузка по HTTP Range (как с build.protomaps.com) и API serve.py для кнопки в приложении."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.tiles = synthetic_tiles(maxzoom=11)
        write_source(cls.dir / "planet.pmtiles", cls.tiles, leaf_size=64)
        cls.serve = load("serve_basemap", ROOT / "serve.py")
        folder = str(cls.dir)

        class Files(cls.serve.Handler):
            def __init__(self, *a, **kw):
                http.server.SimpleHTTPRequestHandler.__init__(self, *a, directory=folder, **kw)

        class NoRange(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *a, **kw):
                super().__init__(*a, directory=folder, **kw)

            def send_head(self):  # отвечает 200 и целым файлом, Range игнорируется
                self.headers.replace_header("Range", "") if "Range" in self.headers else None
                return super().send_head()

            def log_message(self, *a):
                pass
        cls.files = cls.serve.Server(("127.0.0.1", 0), Files)
        cls.norange = cls.serve.Server(("127.0.0.1", 0), NoRange)
        cls.app = cls.serve.Server(("127.0.0.1", 0), cls.serve.Handler)
        cls.serve.BASEMAP_FILE = cls.dir / "local" / "moscow.pmtiles"
        for srv in (cls.files, cls.norange, cls.app):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        cls.src_url = "http://127.0.0.1:%d/planet.pmtiles" % cls.files.server_address[1]

    @classmethod
    def tearDownClass(cls):
        for srv in (cls.files, cls.norange, cls.app):
            srv.shutdown()
            srv.server_close()
        cls.tmp.cleanup()

    def api(self, path, data=None):
        port = self.app.server_address[1]
        body = json.dumps(data).encode() if data is not None else None
        r = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), data=body, headers={
            "Host": "localhost:%d" % port, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r, timeout=10) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_extract_over_http(self):
        out = self.dir / "http" / "moscow.pmtiles"
        BM.extract(self.src_url, out=out, maxzoom=11)
        for z in (5, 11):
            for x, y in tiles_in(BM.MOSCOW_BBOX, z):
                self.assertEqual(BM.read_tile(str(out), z, x, y), self.tiles.get(BM.zxy_to_tileid(z, x, y)))

    def test_server_without_range_is_rejected(self):
        url = "http://127.0.0.1:%d/planet.pmtiles" % self.norange.server_address[1]
        with self.assertRaises(BM.BasemapError) as cm:
            BM.extract(url, out=self.dir / "nr" / "moscow.pmtiles", maxzoom=11)
        self.assertIn("частичную загрузку", str(cm.exception))

    def test_api_download_and_update(self):
        st, body = self.api("/api/basemap")
        self.assertEqual(st, 200)
        self.assertFalse(body["exists"])
        self.assertEqual(body["job"]["state"], "idle")
        for attempt in range(2):  # первая загрузка и обновление поверх существующей карты
            st, body = self.api("/api/basemap/download", {"source": self.src_url, "maxzoom": 11})
            self.assertEqual(st, 202, body)
            for _ in range(200):
                st, body = self.api("/api/basemap")
                if body["job"]["state"] != "running":
                    break
                threading.Event().wait(0.05)
            self.assertEqual(body["job"]["state"], "done", body["job"])
            self.assertTrue(body["exists"])
            self.assertEqual(body["meta"]["maxzoom"], 11)
        self.assertEqual(BM.read_tile(str(self.serve.BASEMAP_FILE), 0, 0, 0), self.tiles[0])

    def test_api_rejects_non_http_source(self):
        st, body = self.api("/api/basemap/download", {"source": "C:/Windows/win.ini"})
        self.assertEqual(st, 400)
        st, body = self.api("/api/basemap/cancel", {})
        self.assertEqual(st, 200)


if __name__ == "__main__":
    unittest.main()
