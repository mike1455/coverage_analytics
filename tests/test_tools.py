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


OA = load("osm_addresses_mod", ROOT / "tools" / "osm_addresses.py")


class FakeOverpass:
    """Локальный «Overpass»: отвечает JSON по POST data=..., умеет имитировать сбои."""

    def __init__(self, elements, fail_first=0, too_big_for=None):
        self.elements, self.fail_first, self.too_big_for = elements, fail_first, too_big_for
        self.queries = []
        fake = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8")
                q = urllib.parse.parse_qs(body)["data"][0]
                fake.queries.append(q)
                if fake.fail_first > 0:
                    fake.fail_first -= 1
                    self.send_response(504)
                    self.end_headers()
                    return
                if fake.too_big_for and fake.too_big_for in q:
                    out = {"elements": [], "remark": "runtime error: Query timed out in \"query\" at line 1 after 240 seconds."}
                else:
                    out = {"version": 0.6, "elements": fake.elements}
                data = json.dumps(out).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass
        self.srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/api/interpreter" % self.srv.server_address[1]

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


ELEMENTS = [
    {"type": "way", "id": 1, "center": {"lat": 55.889, "lon": 37.593}, "tags": {"building": "yes", "addr:street": "улица Лескова", "addr:housenumber": "5"}},
    {"type": "relation", "id": 2, "center": {"lat": 55.776, "lon": 37.528}, "tags": {"building": "yes", "addr:street": "Хорошёвское шоссе", "addr:housenumber": "76к4"}},
    {"type": "node", "id": 3, "lat": 55.7461, "lon": 37.6182, "tags": {"addr:street": "Софийская набережная", "addr:housenumber": "24/2с2", "shop": "x"}},
    {"type": "way", "id": 4, "center": {"lat": 55.99, "lon": 37.215}, "tags": {"building": "yes", "addr:city": "Зеленоград", "addr:housenumber": "к418"}},
    {"type": "way", "id": 5, "tags": {"building": "yes", "addr:street": "без координат", "addr:housenumber": "1"}},
    {"type": "way", "id": 6, "center": {"lat": 55.7, "lon": 37.6}, "tags": {"building": "yes"}},
]


class OsmAddresses(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "osm" / "moscow_addresses.json"
        OA.MIN_COUNT = 1

    def tearDown(self):
        self.tmp.cleanup()

    def test_query_limits_area_and_square(self):
        q = OA.overpass_query((55.1, 36.8, 55.5, 37.2))
        self.assertIn('area["ISO3166-2"="RU-MOW"]', q)
        self.assertIn("(area.a)(55.10000,36.80000,55.50000,37.20000)", q)
        self.assertIn("out tags center;", q)
        self.assertEqual(len(OA.split_bbox(OA.MOSCOW_BBOX, 4, 4)), 16)

    def test_parse_elements(self):
        rows = OA.parse_elements({"elements": ELEMENTS})
        self.assertEqual(rows["way/1"], ["w", "улица Лескова", "5", "", "", 55.889, 37.593])
        self.assertEqual(rows["node/3"][0], "n")
        self.assertEqual(rows["way/4"][4], "Зеленоград")
        self.assertNotIn("way/5", rows)  # без координат
        self.assertNotIn("way/6", rows)  # без номера дома
        with self.assertRaises(OA.TooBig):
            OA.parse_elements({"elements": [], "remark": "runtime error: Query timed out"})

    def test_download_with_mirror_and_split(self):
        bad = FakeOverpass(ELEMENTS, fail_first=10**6)  # первое зеркало всегда отвечает 504
        first = "(area.a)(%.5f,%.5f,%.5f,%.5f)" % OA.split_bbox(OA.MOSCOW_BBOX, 2, 2)[0]
        good = FakeOverpass(ELEMENTS * 30, too_big_for=first)  # первый квадрат «слишком большой»
        try:
            prog = BM.Progress()
            doc = OA.download(prog, out=self.out, endpoints=[bad.url, good.url], grid=(2, 2), pause=0)
            st = prog.snapshot()
            self.assertEqual(st["state"], "done", st)
            self.assertEqual(doc["count"], 4)  # дубли из разных квадратов схлопнуты
            self.assertEqual(doc["endpoint"], good.url)
            self.assertEqual(st["total"], 7)  # 4 квадрата, первый разделён на 4
            self.assertEqual(len(bad.queries), 1, "после отказа зеркала остальные квадраты идут на рабочее")
            saved = json.loads(self.out.read_text(encoding="utf-8"))
            self.assertEqual(saved["fields"][:3], ["type", "street", "housenumber"])
            info = OA.status(self.out)
            self.assertEqual((info["exists"], info["count"]), (True, 4))
            self.assertTrue(info["downloadedAt"].startswith("20"))
        finally:
            bad.close()
            good.close()

    def test_failure_keeps_previous_file(self):
        self.out.parent.mkdir(parents=True)
        self.out.write_text('{"format":"osm-addresses","downloadedAt":"old","count":1,"rows":[]}', encoding="utf-8")
        empty = FakeOverpass([])
        try:
            prog = BM.Progress()
            self.assertIsNone(OA.download(prog, out=self.out, endpoints=[empty.url], grid=(1, 1), pause=0))
            self.assertEqual(prog.snapshot()["state"], "error")
            self.assertIn("мало адресов", prog.snapshot()["message"])
            self.assertEqual(OA.status(self.out)["downloadedAt"], "old")
        finally:
            empty.close()


class AddressesApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.fake = FakeOverpass(ELEMENTS * 40)
        os.environ["MCA_OVERPASS_URL"] = cls.fake.url
        cls.serve = load("serve_addresses", ROOT / "serve.py")
        cls.serve.ADDRESSES_FILE = Path(cls.tmp.name) / "osm" / "moscow_addresses.json"
        cls.serve.osm_addresses.MIN_COUNT = 1
        cls.serve.GEOCODED_FILE = Path(cls.tmp.name) / "geocoded_houses.csv"
        cls.app = cls.serve.Server(("127.0.0.1", 0), cls.serve.Handler)
        threading.Thread(target=cls.app.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("MCA_OVERPASS_URL", None)
        cls.app.shutdown()
        cls.app.server_close()
        cls.fake.close()
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

    def test_download_and_status(self):
        st, body = self.api("/api/addresses")
        self.assertEqual((st, body["exists"]), (200, False))
        st, body = self.api("/api/addresses/download", {})
        self.assertEqual(st, 202, body)
        for _ in range(200):
            st, body = self.api("/api/addresses")
            if body["job"]["state"] != "running":
                break
            threading.Event().wait(0.05)
        self.assertEqual(body["job"]["state"], "done", body["job"])
        self.assertEqual((body["exists"], body["count"]), (True, 4))
        self.assertEqual(body["url"], "data/local/osm/moscow_addresses.json")

    def test_save_geocoded_csv(self):
        csv_text = "unom,lat,lon,source,accuracy,status,address\r\n5000002,55.7,37.6,OSM,здание,osm,\"Лескова ул., д.5\"\r\n"
        st, body = self.api("/api/geocoded", {"csv": csv_text})
        self.assertEqual(st, 200, body)
        self.assertEqual(self.serve.GEOCODED_FILE.read_bytes(), b"\xef\xbb\xbf" + csv_text.encode("utf-8"))
        st, body = self.api("/api/geocoded", {"csv": "rm -rf /"})
        self.assertEqual(st, 400)


YG = load("yandex_geocoder_mod", ROOT / "tools" / "yandex_geocoder.py")


def yandex_answer(query):
    """Ответ в формате HTTP Геокодера Яндекса (format=json)."""
    if "Неизвестная" in query:
        members = []
    else:
        precision = "number" if "Щербинка" in query else "exact"
        members = [{"GeoObject": {
            "metaDataProperty": {"GeocoderMetaData": {"precision": precision, "kind": "house", "text": "Россия, " + query}},
            "Point": {"pos": "37.593 55.889"}}}]
    return {"response": {"GeoObjectCollection": {"metaDataProperty": {}, "featureMember": members}}}


class FakeYandex:
    def __init__(self):
        self.calls = []
        fake = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
                fake.calls.append(q)
                if q["apikey"][0] == "bad-key-0000":
                    self.send_response(403)
                    self.end_headers()
                    return
                data = json.dumps(yandex_answer(q["geocode"][0])).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass
        self.srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/1.x/" % self.srv.server_address[1]

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class YandexGeocoder(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.settings, self.cache = d / "geocoder.local.json", d / "cache.json"
        self.fake = FakeYandex()
        os.environ["MCA_YANDEX_URL"] = self.fake.url

    def tearDown(self):
        os.environ.pop("MCA_YANDEX_URL", None)
        self.fake.close()
        self.tmp.cleanup()

    def run_items(self, items):
        prog = BM.Progress()
        YG.run(prog, items, settings_path=self.settings, cache_path=self.cache, rate=0)
        return prog

    def test_query_text(self):
        self.assertEqual(YG.query_for("Лескова ул., д.5"), "Москва, Лескова ул., д.5")
        self.assertEqual(YG.query_for("Чехова ул. (Щербинка г.), д.4"), "Москва, Щербинка г., Чехова ул., д.4")
        self.assertEqual(YG.query_for("Российская Федерация, город Москва, внутригородская территория муниципальный округ Куркино, Юровская улица, дом 93, корпус 5"),
                         "Москва, Юровская улица, дом 93, корпус 5")
        self.assertEqual(YG.query_for("Зеленоград г. (Зеленоград г.), к.2315а"), "Москва, Зеленоград г., к.2315а")

    def test_parse_response(self):
        r = YG.parse_response(yandex_answer("Москва, Лескова ул., д.5"))
        self.assertEqual((r["lat"], r["lon"], r["precision"], r["kind"]), (55.889, 37.593, "exact", "house"))
        self.assertEqual(YG.parse_response(yandex_answer("Неизвестная")), {"none": True})

    def test_settings_are_validated_and_masked(self):
        with self.assertRaises(ValueError):
            YG.save_settings({"apiKey": "ключ с пробелами"}, self.settings)
        YG.save_settings({"apiKey": "abcd-1234-efgh-5678", "dailyLimit": 50}, self.settings)
        st = YG.public_state(self.settings, self.cache)
        self.assertEqual((st["hasKey"], st["keyTail"], st["dailyLimit"]), (True, "5678", 50))
        self.assertNotIn("abcd-1234", json.dumps(st))

    def test_cache_and_daily_limit(self):
        YG.save_settings({"apiKey": "abcd-1234-efgh-5678", "dailyLimit": 2}, self.settings)
        items = [{"id": "1", "address": "Лескова ул., д.5"}, {"id": "2", "address": "Чехова ул. (Щербинка г.), д.4"},
                 {"id": "3", "address": "Неизвестная ул., д.1"}]
        prog = self.run_items(items)
        self.assertEqual(prog.snapshot()["state"], "done")
        self.assertIn("суточный лимит", prog.snapshot()["message"])
        self.assertEqual(sorted(prog.results), ["1", "2"])
        self.assertEqual(prog.results["2"]["precision"], "number")
        self.assertEqual(len(self.fake.calls), 2)
        self.assertEqual(self.fake.calls[0]["bbox"][0], "36.80,55.13~37.97,56.03")
        # повторный запуск: первые два из кэша, лимит на сегодня уже исчерпан
        prog = self.run_items(items)
        self.assertEqual(len(self.fake.calls), 2)
        self.assertEqual(sorted(prog.results), ["1", "2"])
        self.assertEqual(YG.public_state(self.settings, self.cache)["usedToday"], 2)

    def test_bad_key_and_missing_key(self):
        prog = self.run_items([{"id": "1", "address": "Лескова ул., д.5"}])
        self.assertEqual(prog.snapshot()["state"], "error")
        self.assertIn("ключ", prog.snapshot()["message"])
        YG.save_settings({"apiKey": "bad-key-0000"}, self.settings)
        prog = self.run_items([{"id": "1", "address": "Лескова ул., д.5"}])
        self.assertEqual(prog.snapshot()["state"], "error")
        self.assertIn("HTTP 403", prog.snapshot()["message"])


class YandexApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.fake = FakeYandex()
        os.environ["MCA_YANDEX_URL"] = cls.fake.url
        cls.serve = load("serve_yandex", ROOT / "serve.py")
        cls.serve.YANDEX_SETTINGS = Path(cls.tmp.name) / "geocoder.local.json"
        cls.serve.YANDEX_CACHE = Path(cls.tmp.name) / "cache.json"
        cls.app = cls.serve.Server(("127.0.0.1", 0), cls.serve.Handler)
        threading.Thread(target=cls.app.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("MCA_YANDEX_URL", None)
        cls.app.shutdown()
        cls.app.server_close()
        cls.fake.close()
        cls.tmp.cleanup()

    api = AddressesApi.api

    def test_settings_start_results(self):
        st, body = self.api("/api/yandex")
        self.assertEqual((st, body["hasKey"]), (200, False))
        st, body = self.api("/api/yandex/settings", {"apiKey": "abcd-1234-efgh-5678"})
        self.assertEqual((st, body["hasKey"], body["keyTail"]), (200, True, "5678"))
        st, body = self.api("/api/yandex/start", {"items": [{"id": "u1", "address": "Лескова ул., д.5"}]})
        self.assertEqual(st, 202, body)
        for _ in range(200):
            st, body = self.api("/api/yandex")
            if body["job"]["state"] != "running":
                break
            threading.Event().wait(0.05)
        self.assertEqual(body["job"]["state"], "done", body["job"])
        st, body = self.api("/api/yandex/results")
        self.assertEqual(body["results"]["u1"]["kind"], "house")
        st, body = self.api("/api/yandex/start", {"items": "не список"})
        self.assertEqual(st, 400)


OB = load("osm_boundaries_mod", ROOT / "tools" / "osm_boundaries.py")

SQUARE = [[37.50, 55.70], [37.60, 55.70], [37.60, 55.80], [37.50, 55.80], [37.50, 55.70]]


def overpass_boundaries(level):
    """Ответы Overpass для границ: список (out tags) и геометрия (out geom) из двух линий с общими концами."""
    names = {"5": ["Центральный административный округ", "Северный административный округ"],
             "8": ["район Арбат", "поселение Филимонковское"]}[level]
    return [{"type": "relation", "id": int(level) * 100 + i, "tags": {"name": n, "admin_level": level, "boundary": "administrative"},
             "members": [
                 {"type": "way", "role": "outer", "geometry": [{"lon": x, "lat": y} for x, y in SQUARE[:3]]},
                 {"type": "way", "role": "outer", "geometry": [{"lon": x, "lat": y} for x, y in reversed(SQUARE[2:])]},
             ]} for i, n in enumerate(names)]


class FakeOsmServices:
    """Overpass (POST) и Nominatim (GET /lookup, /search) на одном локальном порту."""

    def __init__(self, overpass_ok=True, nominatim_ok=True):
        self.log = []
        fake = self

        class H(http.server.BaseHTTPRequestHandler):
            def reply(self, code, obj):
                data = json.dumps(obj).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                q = urllib.parse.parse_qs(self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode("utf-8"))["data"][0]
                level = "5" if '"admin_level"="5"' in q else "8"
                kind = "geom" if "out geom" in q else "list"
                fake.log.append(("overpass", kind, level))
                if not overpass_ok:
                    return self.reply(502, {})
                els = overpass_boundaries(level)
                if kind == "list":
                    els = [{"type": e["type"], "id": e["id"], "tags": e["tags"]} for e in els]
                self.reply(200, {"elements": els})

            def do_GET(self):
                u = urllib.parse.urlsplit(self.path)
                q = urllib.parse.parse_qs(u.query)
                fake.log.append(("nominatim", u.path.rsplit("/", 1)[-1], q.get("osm_ids", q.get("q", [""]))[0]))
                if not nominatim_ok:
                    return self.reply(503, {})
                geom = {"type": "Polygon", "coordinates": [SQUARE]}
                if u.path.endswith("/lookup"):
                    ids = [int(x[1:]) for x in q["osm_ids"][0].split(",")]
                    feats = [{"type": "Feature", "properties": {"osm_type": "relation", "osm_id": i}, "geometry": geom} for i in ids]
                else:
                    text = q["q"][0]
                    ok = text.startswith(("район Арбат", "поселение Сосенское")) or "административный округ" in text
                    feats = [{"type": "Feature", "properties": {"category": "boundary", "type": "administrative", "osm_id": 1}, "geometry": geom}] if ok else []
                self.reply(200, {"type": "FeatureCollection", "features": feats})

            def log_message(self, *a):
                pass
        self.srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        base = "http://127.0.0.1:%d" % self.srv.server_address[1]
        self.overpass, self.nominatim = base + "/api/interpreter", base + "/nominatim"

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class OsmBoundaries(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def run_download(self, fake, areas=None):
        prog = BM.Progress()
        OB.download(prog, out_dir=self.dir, areas=areas, endpoints=[fake.overpass], nominatim=fake.nominatim, pause=0)
        return prog.snapshot()

    def read(self, kind):
        return json.loads(OB.out_file(kind, self.dir).read_text(encoding="utf-8"))

    def test_rings_from_lines(self):
        a = [(0, 0), (1, 0), (1, 1)]
        b = [(0, 0), (0, 1), (1, 1)]  # обратный порядок второй линии
        rings = OB.join_rings([a, b])
        self.assertEqual(len(rings), 1)
        self.assertEqual(rings[0][0], rings[0][-1])
        self.assertEqual(len(rings[0]), 5)
        self.assertEqual(OB.join_rings([[(0, 0), (1, 0)]]), [], "незамкнутая линия не становится контуром")

    def test_list_then_nominatim_polygons(self):
        fake = FakeOsmServices()
        try:
            st = self.run_download(fake)
            self.assertEqual(st["state"], "done", st)
            okrug, area = self.read("okrug"), self.read("area")
            self.assertEqual([f["properties"]["name"] for f in okrug["features"]], ["Центральный административный округ", "Северный административный округ"])
            self.assertEqual(area["features"][1]["properties"]["name"], "поселение Филимонковское")
            self.assertEqual(area["features"][0]["geometry"]["type"], "Polygon")
            self.assertNotIn(("overpass", "geom", "5"), fake.log, "тяжёлый запрос геометрии не нужен, если ответил Nominatim")
            self.assertEqual({k: st["area"][k] for k in ("listed", "got", "state")}, {"listed": 2, "got": 2, "state": "ok"}, "счётчики хода загрузки")
            self.assertIn("Nominatim", st["okrug"]["via"])
            self.assertEqual(sum(1 for x in fake.log if x[:2] == ("nominatim", "lookup")), 2)
            self.assertEqual(OB.status(self.dir)["area"]["exists"], True)
        finally:
            fake.close()

    def test_overpass_geometry_when_nominatim_down(self):
        fake = FakeOsmServices(nominatim_ok=False)
        try:
            st = self.run_download(fake)
            self.assertEqual(st["state"], "done", st)
            g = self.read("okrug")["features"][0]["geometry"]
            self.assertEqual(g["type"], "Polygon")
            self.assertEqual(g["coordinates"][0][0], g["coordinates"][0][-1])
            self.assertIn(("overpass", "geom", "8"), fake.log)
        finally:
            fake.close()

    def test_names_when_overpass_down(self):
        fake = FakeOsmServices(overpass_ok=False)
        orig = OB.time.sleep
        OB.time.sleep = lambda s: None  # повторы Overpass без ожидания
        try:
            st = self.run_download(fake, areas=["Арбат", "Сосенское", "Неизвестный"])
            self.assertEqual(st["state"], "done", st)
            self.assertEqual(len(self.read("okrug")["features"]), 12)
            self.assertEqual((st["area"]["listed"], st["area"]["got"], st["area"]["checked"]), (3, 2, 3))
            self.assertEqual([f["properties"]["name"] for f in self.read("area")["features"]], ["Арбат", "Сосенское"])
            self.assertIn(("nominatim", "search", "поселение Сосенское, Москва"), fake.log)
        finally:
            OB.time.sleep = orig
            fake.close()

    def test_everything_down_keeps_old_files(self):
        fake = FakeOsmServices(overpass_ok=False, nominatim_ok=False)
        OB.out_file("okrug", self.dir).parent.mkdir(parents=True, exist_ok=True)
        OB.out_file("okrug", self.dir).write_text('{"old":1}', encoding="utf-8")
        orig = OB.time.sleep
        OB.time.sleep = lambda s: None
        try:
            st = self.run_download(fake)
            self.assertEqual(st["state"], "error")
            self.assertEqual(json.loads(OB.out_file("okrug", self.dir).read_text(encoding="utf-8")), {"old": 1})
        finally:
            OB.time.sleep = orig
            fake.close()


MR = load("mos_registry_mod", ROOT / "tools" / "mos_registry.py")

REG_POLY = {"type": "Polygon", "coordinates": [[[37.60, 55.75], [37.61, 55.75], [37.61, 55.76], [37.60, 55.76], [37.60, 55.75]]]}


def registry_items(n):
    """Записи в формате apidata.mos.ru /features: properties.Attributes с UNOM, geoData и geodata_center."""
    out = []
    for i in range(n):
        attrs = {"global_id": i, "UNOM": 5000000 + i, "geodata_center": {"type": "Point", "coordinates": [37.5 + i * 1e-4, 55.7]}}
        if i % 2 == 0:
            attrs["geoData"] = REG_POLY
        geometry = REG_POLY if i % 2 == 0 else attrs["geodata_center"]  # у части зданий в реестре нет контура
        out.append({"type": "Feature", "geometry": geometry, "properties": {"DatasetId": 60562, "Attributes": attrs}})
    out.append({"type": "Feature", "geometry": None, "properties": {"Attributes": {"global_id": -1}}})  # без UNOM
    return out


class FakeMosData:
    def __init__(self, n=2500, key="good-key-1234"):
        self.items, self.key, self.calls = registry_items(n), key, []
        fake = self

        class H(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                u = urllib.parse.urlsplit(self.path)
                q = urllib.parse.parse_qs(u.query)
                fake.calls.append((u.path, q.get("$skip", [""])[0]))
                if q.get("api_key", [""])[0] != fake.key:
                    self.send_response(403)
                    self.end_headers()
                    return
                if u.path.endswith("/count"):
                    body = json.dumps(len(fake.items))
                else:
                    skip, top = int(q["$skip"][0]), int(q["$top"][0])
                    body = json.dumps({"type": "FeatureCollection", "features": fake.items[skip:skip + top]})
                data = body.encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass
        self.srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), H)
        self.srv.daemon_threads = True
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = "http://127.0.0.1:%d/v1" % self.srv.server_address[1]

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class MosRegistry(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.settings, self.out = d / "geocoder.local.json", d / "mos_registry.json"
        self.fake = FakeMosData()

    def tearDown(self):
        self.fake.close()
        self.tmp.cleanup()

    def test_parse_item_formats(self):
        r = MR.parse_item({"properties": {"Attributes": {"UNOM": "00123", "geodata_center": {"type": "Point", "coordinates": [37.6, 55.75]}}}})
        self.assertEqual(r[:3], ("123", 55.75, 37.6))
        r = MR.parse_item({"Cells": {"UNOM": 7, "geoData": json.dumps(REG_POLY)}})  # формат /rows, геометрия строкой
        self.assertAlmostEqual(r[1], 55.755)
        self.assertAlmostEqual(r[2], 37.605)
        self.assertEqual(r[3]["type"], "Polygon")
        self.assertIsNone(MR.parse_item({"Cells": {"UNOM": 8, "geodata_center": {"type": "Point", "coordinates": [30.3, 59.9]}}}))

    def test_settings_keep_yandex_key(self):
        YG.save_settings({"apiKey": "yandex-key-1234"}, self.settings)
        MR.save_settings({"mosKey": "good-key-1234"}, self.settings)
        YG.save_settings({"dailyLimit": 5}, self.settings)
        self.assertEqual(YG.load_settings(self.settings)["apiKey"], "yandex-key-1234")
        self.assertEqual(MR.load_settings(self.settings)["mosKey"], "good-key-1234")
        st = MR.public_state(self.settings, self.out)
        self.assertEqual((st["hasKey"], st["keyTail"], st["dataset"]), (True, "1234", 60562))
        with self.assertRaises(ValueError):
            MR.save_settings({"mosKey": "плохой ключ"}, self.settings)

    def test_download_pages_and_matches_unoms(self):
        MR.save_settings({"mosKey": "good-key-1234"}, self.settings)
        prog = BM.Progress()
        MR.download(prog, unoms=["5000002", "5000003", "9999999"], settings_path=self.settings, out=self.out, base=self.fake.url, pause=0)
        st = prog.snapshot()
        self.assertEqual(st["state"], "done", st)
        self.assertEqual((st["records"], st["total"], st["found"], st["wanted"]), (2501, 2501, 2, 3))
        self.assertEqual([c[1] for c in self.fake.calls if c[0].endswith("/features")], ["0", "1000", "2000"])
        doc = json.loads(self.out.read_text(encoding="utf-8"))
        self.assertEqual(doc["count"], 2500)
        self.assertEqual(doc["points"]["5000003"], [55.7, 37.5003])
        self.assertEqual(sorted(doc["shapes"]), ["5000002"], "контуры только для домов реестра МЖИ")
        self.assertEqual(MR.public_state(self.settings, self.out)["count"], 2500)

    def test_bad_key_keeps_old_file(self):
        self.out.write_text('{"old":1}', encoding="utf-8")
        MR.save_settings({"mosKey": "wrong-key-0000"}, self.settings)
        prog = BM.Progress()
        MR.download(prog, settings_path=self.settings, out=self.out, base=self.fake.url, pause=0)
        self.assertEqual(prog.snapshot()["state"], "error")
        self.assertIn("ключ", prog.snapshot()["message"])
        self.assertEqual(json.loads(self.out.read_text(encoding="utf-8")), {"old": 1})


if __name__ == "__main__":
    unittest.main()
