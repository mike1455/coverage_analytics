#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Генератор СИНТЕТИЧЕСКИХ выгрузок ЕДЦ и МЖИ для автотестов и проверки производительности.

ВНИМАНИЕ: все значения (UUID, УНОМ, адреса, счётчики, заявки) выдуманы генератором случайных чисел.
Файлы нельзя использовать как данные для аналитики - только для тестов приложения.
Заголовки повторяют реальные выгрузки DBeaver, включая усечение PostgreSQL до 63 байт.

Пример:
    py -3 tools/make_synthetic_data.py --houses 300000 --out C:\\tmp\\synthetic
"""
import argparse
import csv
import random
import uuid
from pathlib import Path

# Заголовки как в «Примеры выгрузки» (S1): часть усечена PostgreSQL до 63 байт.
HOUSES_HEADER = ["Адрес", "УНОМ", "ФИАС", "Корневой ID адреса", "ID записи адреса", "Тип дома (house_type из ЕДЦ)",
                 "Принадлежность (affiliation из ЕДЦ)", "Последняя версия записи адреса (is_l",
                 "Актуальность адресного объекта (act", "Жилой по house_type (предварительно)",
                 "Жилой и актуальный по ЕДЦ (предвар", "Есть текстовый адрес", "Дата изменения адресной записи",
                 "Есть настройка обслуживания ЕДЦ", "Количество настроек обслуживания", "Количество организаций",
                 "Перечень организаций (UUID через ;)", "Количество полномочий", "Перечень полномочий (UUID через ;)",
                 "Количество платных дефектов из сп", "Перечень ID платных дефектов через",
                 "Признак обслуживания всех подъезд", "Количество подъездов в реестре ЕД",
                 "Подъездов actual=true (если поле сущест", "Подъездов actual=false (если поле сущест",
                 "Подъездов с неизвестным actual", "Подъездов с найденной привязкой",
                 "Подъездов без найденной привязки", "Подъезды с привязкой через ;",
                 "Подъезды без найденной привязки ч", "Покрытие подъездов по данным ЕДЦ"]
ENTRANCES_HEADER = ["Адрес", "УНОМ", "ФИАС", "Корневой ID адреса", "ID записи адреса", "Тип дома (house_type из ЕДЦ)",
                    "Принадлежность (affiliation из ЕДЦ)", "Последняя версия записи адреса (is_l",
                    "Актуальность адресного объекта (act", "Жилой по house_type (предварительно)",
                    "Жилой и актуальный по ЕДЦ (предвар", "Есть текстовый адрес", "Дата изменения адресной записи",
                    "Подъезд (номер либо ID)", "Корневой ID подъезда", "is_last подъезда (если поле существуе",
                    "actual подъезда (если поле существует", "Статус обслуживания подъезда (по д",
                    "Количество настроек обслуживания", "Количество организаций подъезда",
                    "Организации подъезда (UUID через ;)", "Полномочия подъезда (UUID через ;)",
                    "Платных дефектов подъезда из спис", "ID платных дефектов подъезда через",
                    "Основание обслуживания подъезда"]
REQUESTS_HEADER = ["Уровень агрегации", "ID адреса для сопоставления", "Тип ключа адреса",
                   "Ключ подъезда для сопоставления", "Тип ключа подъезда", "УНОМ из заявок", "Заявок 2026 всего",
                   "Заявок 2026 с датой закрытия", "Заявок 2026 без даты закрытия", "Критических заявок 2026",
                   "Заявок без корневого ID адреса", "Заявок без корневого ID подъезда", "Заявок I квартал 2026",
                   "Заявок II квартал 2026", "Заявок III квартал 2026", "Заявок IV квартал 2026",
                   "Дата последней заявки в 2026"]
MJI_HEADER = ["Код", "Округ", "Район", "Наименование/адрес", "ФИАС", "UNOM", "Управляющая организация"]

OKRUGS = {
    "ЦАО": ["Синтетический-Центр-1", "Синтетический-Центр-2"], "САО": ["Синтетический-Север-1"],
    "СВАО": ["Синтетический-СВ-1"], "ВАО": ["Синтетический-Восток-1", "Синтетический-Восток-2"],
    "ЮВАО": ["Синтетический-ЮВ-1"], "ЮАО": ["Синтетический-Юг-1"], "ЮЗАО": ["Синтетический-ЮЗ-1"],
    "ЗАО": ["Синтетический-Запад-1"], "СЗАО": ["Синтетический-СЗ-1"], "ЗелАО": ["Синтетический-Зел-1"],
    "НАО": ["Синтетический-НАО-1"], "ТАО": ["Синтетический-ТАО-1"],
}
PAID = [37945, 16791, 37723, 37698, 18709, 38240, 48978, 41754, 39805, 49014]


def u(rng):
    return str(uuid.UUID(int=rng.getrandbits(128), version=4))


def bool_s(v):
    return "" if v is None else ("true" if v else "false")


def generate(n_houses, seed=7):
    rng = random.Random(seed)
    houses, entrances, requests, mji = [], [], [], []
    orgs = [u(rng) for _ in range(30)]
    auths = [u(rng) for _ in range(3)]
    okrug_list = list(OKRUGS)
    mji_code = 1
    for i in range(n_houses):
        root = u(rng)
        rec_id = root if rng.random() < 0.7 else u(rng)
        root_out = root
        if i % 97 == 13:  # корневой ID не заполнен - ключ по ID записи
            root_out = ""
        key_root = root_out or rec_id
        unom = str(5000000 + i)
        if i % 211 == 5 and i > 0:  # дубль УНОМ - вторая запись того же УНОМ
            unom = str(5000000 + i - 1)
        r = rng.random()
        house_type = "Жилое" if r < 0.45 else ("Нежилое" if r < 0.85 else "Категория не установлена")
        actual = rng.random() > 0.08
        if i % 389 == 7:
            actual = None
        fias = u(rng).upper() if rng.random() > 0.05 else ""
        street = f"Синтетическая улица {i // 40 + 1}"
        address = f"{street}, дом {i % 40 + 1}" if rng.random() > 0.01 else ""
        n_ent = rng.randint(1, 8) if house_type == "Жилое" else (rng.randint(0, 2) if rng.random() < 0.2 else 0)
        n_rel = rng.choice([0, 0, 2, 5, 12, 18]) if house_type == "Жилое" else rng.choice([0, 0, 0, 3])
        all_flag = n_rel > 0 and rng.random() < 0.5
        h_orgs = sorted(rng.sample(orgs, min(n_rel, len(orgs))))
        h_auth = sorted(rng.sample(auths, min(n_rel, 3) if n_rel else 0))
        paid = sorted(rng.sample(PAID, rng.randint(0, 3))) if n_rel else []
        ent_list = []
        for k in range(n_ent):
            e_root = u(rng)
            label = str(k + 1) if rng.random() > 0.05 else f"[ID подъезда: {e_root}]"
            linked = (n_rel > 0) and (all_flag or rng.random() < 0.6)
            ent_list.append((e_root, label, linked))
        linked_n = sum(1 for e in ent_list if e[2])
        served = "; ".join(sorted(e[1] for e in ent_list if e[2])) or ""
        unserved = "; ".join(sorted(e[1] for e in ent_list if not e[2])) or ""
        if actual is False:
            all_txt = "Адрес неактуален; настройки показаны справочно"
            cov_txt = "Адрес неактуален; сведения о подъездах справочно"
        elif actual is None:
            all_txt = "Актуальность адреса неизвестна; настройки показаны справочно"
            cov_txt = "Актуальность адреса неизвестна"
        else:
            all_txt = "Нет настроек обслуживания" if not n_rel else ("Да, во всех настройках" if all_flag else "Нет подтверждения обслуживания всех подъездов")
            if not n_ent:
                cov_txt = "Нет записей о подъездах"
            elif linked_n == n_ent:
                cov_txt = "Все найденные подъезды с привязкой"
            elif linked_n == 0:
                cov_txt = "Нет найденных привязок по подъездам"
            else:
                cov_txt = "Частичное покрытие подъездов"
        ht_res = {"Жилое": "Да (по категории ЕДЦ)", "Нежилое": "Нет (по категории ЕДЦ)"}.get(house_type, "Не определено")
        if house_type == "Жилое" and actual is True:
            res_act = "Да — жилой и актуальный (предварительно)"
        elif house_type == "Жилое" and actual is False:
            res_act = "Нет — жилой, но объект неактуален"
        elif house_type == "Жилое":
            res_act = "Не определено — нет значения actual"
        elif house_type == "Нежилое":
            res_act = "Нет — тип дома нежилой"
        else:
            res_act = "Не определено — категория дома и/или актуальность требуют проверки"
        edit = f"2026-0{rng.randint(1, 9)}-{rng.randint(10, 28)} 1{rng.randint(0, 9)}:{rng.randint(10, 59)}:{rng.randint(10, 59)}.{rng.randint(100, 999)} +0300"
        houses.append([address, unom, fias, root_out, rec_id, house_type, "", "true", bool_s(actual), ht_res, res_act,
                       "Да" if address else "Нет", edit, "Да" if n_rel else "Нет найденной настройки", n_rel,
                       len(h_orgs), "; ".join(h_orgs), len(h_auth), "; ".join(h_auth), len(paid),
                       "; ".join(map(str, paid)), all_txt, n_ent, 0, 0, n_ent, linked_n, n_ent - linked_n, served,
                       unserved, cov_txt])
        if not ent_list:
            entrances.append([address, unom, fias, root_out, rec_id, house_type, "", "true", bool_s(actual), ht_res,
                              res_act, "Да" if address else "Нет", edit, "", "", "", "", "Нет данных о подъездах", 0, 0,
                              "", "", 0, "", ""])
        for e_root, label, linked in sorted(ent_list, key=lambda x: x[1]):
            if actual is False:
                st = "Адрес неактуален; настройки подъезда справочно"
            elif actual is None:
                st = "Актуальность адреса неизвестна"
            else:
                st = "Есть настройка обслуживания" if linked else "Нет найденной привязки обслуживания"
            e_orgs = h_orgs if linked else []
            basis = ("Все подъезды" if all_flag else "Конкретный подъезд") if linked else ""
            entrances.append([address, unom, fias, root_out, rec_id, house_type, "", "true", bool_s(actual), ht_res,
                              res_act, "Да" if address else "Нет", edit, label, e_root, "true", "", st,
                              len(e_orgs), len(e_orgs), "; ".join(e_orgs), "; ".join(h_auth) if linked else "",
                              len(paid) if linked else 0, "; ".join(map(str, paid)) if linked else "", basis])
        # Заявки 2026: группы по подъездам + UNKNOWN/NUMBER/entrances.id; дом = сумма групп
        if rng.random() < 0.35:
            akey_type = "address.root_id" if root_out and rng.random() > 0.03 else "address.id (резервный ключ)"
            akey = root_out if akey_type == "address.root_id" else rec_id
            groups = []
            for e_root, label, _ in ent_list:
                if rng.random() < 0.6:
                    groups.append((e_root, "entrances.root_id"))
            if rng.random() < 0.5:
                groups.append(("UNKNOWN", "Подъезд не указан"))
            if ent_list and rng.random() < 0.15:
                groups.append(("NUMBER:" + ent_list[0][1], "Только номер подъезда"))
            if rng.random() < 0.05:
                groups.append((u(rng), "entrances.id (резервный ключ)"))
            if not groups:
                groups.append(("UNKNOWN", "Подъезд не указан"))
            req_unom = unom if rng.random() > 0.03 else str(7000000 + i)
            house_tot = [0] * 10
            last_all = ""
            for ekey, etype in groups:
                total = rng.randint(1, 30)
                open_ = rng.randint(0, total // 4)
                crit = rng.randint(0, total // 3)
                qs = [0, 0, 0, 0]
                for _ in range(total):
                    qs[rng.choice([0, 1, 2, 2, 3])] += 1
                no_root_addr = total if akey_type != "address.root_id" else 0
                no_root_entr = total if etype != "entrances.root_id" else 0
                vals = [total, total - open_, open_, crit, no_root_addr, no_root_entr] + qs
                last = f"2026-{rng.choice(['03', '06', '09', '10'])}-{rng.randint(10, 25)} 1{rng.randint(0, 9)}:{rng.randint(10, 59)}:{rng.randint(10, 59)}.{rng.randint(100, 999)} +0300"
                last_all = max(last_all, last)
                requests.append(["Подъезд", akey, akey_type, ekey, etype, req_unom] + vals + [last])
                house_tot = [a + b for a, b in zip(house_tot, vals)]
            requests.append(["Дом", akey, akey_type, "", "", req_unom] + house_tot + [last_all])
        # МЖИ: синтетический реестр, часть домов «есть в МЖИ»
        if house_type == "Жилое" and rng.random() < 0.8 and not (i % 211 == 5 and i > 0):
            ok = okrug_list[i % len(okrug_list)]
            area = OKRUGS[ok][i % len(OKRUGS[ok])]
            mji.append([mji_code, ok, area, f"{street}, д.{i % 40 + 1}", fias or "", unom, f"ООО «Синтетическая УК {i % 17}»"])
            mji_code += 1
    # Агрегат на адрес, которого нет в выгрузке домов
    for _ in range(3):
        requests.append(["Дом", u(rng), "address.root_id", "", "", "9999999"] + [1, 1, 0, 0, 0, 1, 1, 0, 0, 0] + ["2026-02-02 10:00:00.000 +0300"])
    # Несколько МЖИ без пары в ЕДЦ и без округа
    for k in range(5):
        ok = okrug_list[k % len(okrug_list)] if k else ""
        mji.append([mji_code, ok, OKRUGS[ok][0] if ok else "", f"Синтетический переулок, д.{k + 1}", "", str(8000000 + k), ""])
        mji_code += 1
    requests.sort(key=lambda r: (r[0], r[1], r[3]))
    return houses, entrances, requests, mji


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, quoting=csv.QUOTE_MINIMAL)
        w.writerow(header)
        w.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description="СИНТЕТИЧЕСКИЕ данные ЕДЦ/МЖИ для тестов")
    ap.add_argument("--houses", type=int, default=60)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    houses, entrances, requests, mji = generate(args.houses, args.seed)
    write_csv(out / "01_дома.csv", HOUSES_HEADER, houses)
    write_csv(out / "02_подъезды.csv", ENTRANCES_HEADER, entrances)
    write_csv(out / "03_заявки_2026.csv", REQUESTS_HEADER, requests)
    write_csv(out / "mji_synthetic.csv", MJI_HEADER, mji)
    print(f"СИНТЕТИКА: домов {len(houses)}, строк подъездов {len(entrances)}, агрегатов заявок {len(requests)}, МЖИ {len(mji)} → {out}")


if __name__ == "__main__":
    main()
