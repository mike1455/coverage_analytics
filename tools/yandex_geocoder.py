# -*- coding: utf-8 -*-
"""Яндекс Геокодер для домов, которых нет в справочнике адресов OpenStreetMap.

Ключ API (кабинет разработчика Яндекса, сервис «JavaScript API и HTTP Геокодер») хранится только
на этом компьютере в config/geocoder.local.json. Ответы сохраняются в
data/local/yandex_geocoder_cache.json: повторный поиск того же адреса запрос не тратит.
Суточный лимит запросов задаётся в настройках, по умолчанию 1000 (бесплатный тариф).
Условия Яндекса для хранения результатов геокодирования проверьте для своего тарифа.
"""
import datetime as dt
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETTINGS = ROOT / "config" / "geocoder.local.json"
CACHE = ROOT / "data" / "local" / "yandex_geocoder_cache.json"
URL = "https://geocode-maps.yandex.ru/1.x/"
BBOX = "36.80,55.13~37.97,56.03"  # долгота,широта ~ долгота,широта
DEFAULT_LIMIT = 1000
RATE = 0.2  # не чаще 5 запросов в секунду


class YandexError(Exception):
    pass


def read_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path, obj):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(str(tmp), str(path))


def load_settings(path=SETTINGS):
    s = read_json(path, {})
    return {"apiKey": str(s.get("apiKey") or ""), "dailyLimit": int(s.get("dailyLimit") or DEFAULT_LIMIT)}


def save_settings(data, path=SETTINGS):
    cur = load_settings(path)
    if "apiKey" in data:
        key = str(data.get("apiKey") or "").strip()
        if key and not re.fullmatch(r"[A-Za-z0-9-]{8,64}", key):
            raise ValueError("Ключ API выглядит неверно: ожидаются латинские буквы, цифры и дефисы")
        cur["apiKey"] = key
    if "dailyLimit" in data:
        cur["dailyLimit"] = max(1, min(1000000, int(data.get("dailyLimit") or DEFAULT_LIMIT)))
    write_json(path, cur)
    return cur


def today():
    return dt.date.today().isoformat()


def public_state(settings_path=SETTINGS, cache_path=CACHE):
    s = load_settings(settings_path)
    c = read_json(cache_path, {})
    key = s["apiKey"]
    return {"hasKey": bool(key), "keyTail": key[-4:] if key else "", "dailyLimit": s["dailyLimit"],
            "usedToday": int((c.get("usage") or {}).get(today(), 0)), "cached": len(c.get("items") or {})}


def query_for(address):
    """Адрес МЖИ → строка запроса: «Москва, Щербинка, Чехова ул., д.4» вместо «Чехова ул. (Щербинка г.), д.4»."""
    s = re.sub(r"\s+", " ", str(address or "")).strip()
    s = re.sub(r"^Российская Федерация,\s*", "", s, flags=re.I)
    s = re.sub(r"^(?:город|г\.)\s*Москва,\s*", "", s, flags=re.I)
    s = re.sub(r"внутригородская территория[^,]*,\s*", "", s, flags=re.I)
    quals = [q.strip() for q in re.findall(r"\(([^)]*)\)", s) if q.strip()]
    s = re.sub(r"\s*\([^)]*\)", "", s).strip()
    parts = ["Москва"] + [q for q in quals if q.lower() not in s.lower()] + [s]
    return ", ".join(p for p in parts if p)


def parse_response(data):
    """Первый результат: координаты, точность (exact, number, near, street…), вид объекта, адрес Яндекса."""
    try:
        members = data["response"]["GeoObjectCollection"]["featureMember"]
    except (KeyError, TypeError):
        raise YandexError("Неожиданный ответ Яндекс Геокодера")
    if not members:
        return {"none": True}
    obj = members[0]["GeoObject"]
    lon, lat = (float(x) for x in obj["Point"]["pos"].split())
    meta = obj.get("metaDataProperty", {}).get("GeocoderMetaData", {})
    return {"lat": lat, "lon": lon, "precision": meta.get("precision", ""), "kind": meta.get("kind", ""),
            "text": meta.get("text", "")}


def request(key, query, url=None, timeout=20):
    params = urllib.parse.urlencode({"apikey": key, "geocode": query, "format": "json", "results": 1,
                                     "lang": "ru_RU", "bbox": BBOX, "rspn": 1})
    req = urllib.request.Request((url or os.environ.get("MCA_YANDEX_URL") or URL) + "?" + params,
                                 headers={"User-Agent": "coverage-analytics/1.0"})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return parse_response(json.loads(r.read().decode("utf-8")))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise YandexError("Яндекс отклонил запрос (HTTP %d): проверьте ключ API или суточный лимит." % e.code)
            last = "HTTP %d" % e.code
        except (OSError, ValueError) as e:
            last = str(e)
        time.sleep(2 * (attempt + 1))
    raise YandexError("Нет связи с Яндекс Геокодером: %s" % last)


def run(progress, items, settings_path=SETTINGS, cache_path=CACHE, rate=RATE):
    """Фоновая задача: items = [{"id", "address"}]. Результат: progress.results = {id: ответ}."""
    now = lambda: dt.datetime.now().astimezone().isoformat(timespec="seconds")  # noqa: E731
    progress.cancel.clear()
    progress.results = {}
    progress.set(state="running", stage="Яндекс Геокодер", done=0, total=len(items), message="", started=now(), finished=None)
    s = load_settings(settings_path)
    cache = read_json(cache_path, {})
    cache.setdefault("items", {})
    usage = cache.setdefault("usage", {})
    asked = 0
    try:
        if not s["apiKey"]:
            raise YandexError("Не указан ключ API Яндекс Геокодера.")
        for i, it in enumerate(items):
            progress.check()
            q = query_for(it.get("address"))
            hit = cache["items"].get(q)
            if hit is None:
                if usage.get(today(), 0) >= s["dailyLimit"]:
                    progress.set(message="Достигнут суточный лимит %d запросов. Продолжите завтра, найденное сохранено." % s["dailyLimit"])
                    break
                hit = request(s["apiKey"], q)
                cache["items"][q] = hit
                usage[today()] = usage.get(today(), 0) + 1
                asked += 1
                if asked % 50 == 0:
                    write_json(cache_path, cache)
                if rate:
                    time.sleep(rate)
            progress.results[str(it.get("id"))] = hit
            progress.set(done=i + 1, stage="Яндекс Геокодер: %d из %d" % (i + 1, len(items)))
        write_json(cache_path, cache)
        progress.set(state="done", finished=now())
    except Exception as e:  # noqa: BLE001 - сообщение показывается в приложении
        write_json(cache_path, cache)
        cancelled = progress.cancel.is_set()
        progress.set(state="cancelled" if cancelled else "error", stage="",
                     message="Остановлено, найденное сохранено." if cancelled else str(e), finished=now())
