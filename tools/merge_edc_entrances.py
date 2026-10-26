#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Объединение CSV ЕДЦ без внешних зависимостей (Python 3.9+)."""
import argparse
import csv
import codecs
import sqlite3
import sys
import tempfile
from collections import Counter
from pathlib import Path

# Таблица статистики заявок, сформированная запросом № 4.
STATS_COLUMNS = [
    'Заявок 2026 всего',
    'Заявок 2026 с датой закрытия',
    'Заявок 2026 без даты закрытия',
    'Критических заявок 2026',
    'Заявок без корневого ID адреса',
    'Заявок без корневого ID подъезда',
    'Заявок I квартал 2026',
    'Заявок II квартал 2026',
    'Заявок III квартал 2026',
    'Заявок IV квартал 2026',
]
LAST_DATE_COLUMN = 'Дата последней заявки в 2026'
ADD_COLUMNS = [
    'Статистика 2026: способ сопоставления',
    'Статистика 2026: групп сопоставлено',
    'Статистика 2026: УНОМ из заявок',
    'Статистика 2026: расхождение УНОМ',
] + STATS_COLUMNS + [LAST_DATE_COLUMN]


def configure_csv_limits():
    limit = sys.maxsize
    while limit:
        try:
            csv.field_size_limit(limit)
            return
        except OverflowError:
            limit = limit // 10


def choose_encoding(path, specified):
    if specified != 'auto':
        return specified
    blob = Path(path).open('rb').read(32768)
    for enc in ('utf-8-sig', 'cp1251'):
        try:
            decoder = codecs.getincrementaldecoder(enc)(errors='strict')
            decoder.decode(blob, final=False)
            return enc
        except UnicodeError:
            pass
    raise ValueError('Не удалось определить кодировку CSV. Используйте --encoding.')


def open_csv(path, encoding='auto', delimiter='auto'):
    enc = choose_encoding(path, encoding)
    fh = open(path, 'r', encoding=enc, newline='')
    preview = fh.read(32768)
    fh.seek(0)
    if delimiter == 'auto':
        try:
            sep = csv.Sniffer().sniff(preview, delimiters=',;\t').delimiter
        except csv.Error:
            sep = ','
    else:
        sep = '\t' if delimiter == 'tab' else delimiter
    reader = csv.DictReader(fh, delimiter=sep)
    if not reader.fieldnames:
        fh.close()
        raise ValueError('В файле нет строки заголовков: ' + str(path))
    names = [x.strip().lstrip('\ufeff') for x in reader.fieldnames]
    if len(names) != len(set(names)):
        fh.close()
        raise ValueError('Повторяющиеся имена колонок в файле: ' + str(path))
    reader.fieldnames = names
    return fh, reader


def need_columns(reader, names, path):
    missing = [x for x in names if x not in reader.fieldnames]
    if missing:
        raise ValueError('В файле ' + str(path) + ' нет обязательных колонок: ' + '; '.join(missing) +
                         '\nДоступные заголовки: ' + '; '.join(reader.fieldnames))


def cell(row, name):
    return str(row.get(name) or '').strip()


def norm_uuid(v):
    return (v or '').strip().lower()


def norm_unom(v):
    return (v or '').strip().lstrip('0') or ('0' if str(v).strip() else '')


def parse_nonnegative_int(v, name, index):
    raw = str(v or '').strip()
    if not raw:
        return 0
    if not raw.isdecimal():
        raise ValueError(f'Строка {index}: поле {name!r} должно быть целым числом >= 0, получено {raw!r}')
    return int(raw)


def address_keys(row):
    root = norm_uuid(cell(row, 'Корневой ID адреса'))
    individual = norm_uuid(cell(row, 'ID записи адреса'))
    keys = []
    if root:
        keys.append(('address.root_id', root))
    if individual:
        keys.append(('address.id', individual))
    return keys


def stats_address_kind(v):
    val = v.strip().lower()
    if val == 'address.root_id':
        return 'address.root_id'
    if val.startswith('address.id'):
        return 'address.id'
    return 'UNSUPPORTED:' + v.strip()


def stats_entrance_kind(v):
    val = v.strip().lower()
    if val == 'entrances.root_id':
        return 'entrances.root_id'
    if val.startswith('entrances.id'):
        return 'entrances.id'
    if val == 'только номер подъезда':
        return 'NUMBER'
    if val == 'подъезд не указан':
        return 'UNKNOWN'
    return 'UNSUPPORTED:' + v.strip()


def clean_entrance_number(v):
    return ' '.join(str(v or '').strip().casefold().split())


class StatsDB:
    """Индекс статистики на диске: ~189 тыс. агрегатов, без pandas и загрузки всех CSV в ОЗУ."""
    def __init__(self, path, requested_level, encoding='auto', delimiter='auto'):
        self.requested_level = requested_level
        self.work = tempfile.TemporaryDirectory(prefix='edc_stats_')
        self.conn = sqlite3.connect(str(Path(self.work.name) / 'stats.sqlite3'))
        self.conn.execute('PRAGMA synchronous=OFF')
        self.conn.execute('PRAGMA journal_mode=OFF')
        self.conn.execute('PRAGMA temp_store=MEMORY')
        numeric_ddl = ', '.join('n' + str(i) + ' INTEGER NOT NULL' for i in range(len(STATS_COLUMNS)))
        self.conn.execute('CREATE TABLE stats ('
                          'a_type TEXT NOT NULL, a_key TEXT NOT NULL, '
                          'e_type TEXT NOT NULL, e_key TEXT NOT NULL, '
                          'unom TEXT NOT NULL, last_date TEXT NOT NULL, '
                          + numeric_ddl + ', used INTEGER NOT NULL DEFAULT 0, '
                          'UNIQUE(a_type, a_key, e_type, e_key))')
        fh, reader = open_csv(path, encoding, delimiter)
        expected = ['Уровень агрегации', 'ID адреса для сопоставления', 'Тип ключа адреса',
                    'Ключ подъезда для сопоставления', 'Тип ключа подъезда',
                    'УНОМ из заявок', LAST_DATE_COLUMN] + STATS_COLUMNS
        need_columns(reader, expected, path)
        self.loaded = 0
        self.skipped_other_level = 0
        self.no_address_key = 0
        self.by_keytype = Counter()
        qs = ','.join('?' for _ in range(6+len(STATS_COLUMNS)))
        sql = ('INSERT INTO stats(a_type,a_key,e_type,e_key,unom,last_date,' +
               ','.join('n'+str(i) for i in range(len(STATS_COLUMNS))) + ') VALUES ('+qs+')')
        try:
            with self.conn:
                for i,row in enumerate(reader, 2):
                    if None in row:
                        raise ValueError(f'Строка {i} в CSV заявок имеет больше полей, чем заголовок. Проверьте разделитель.')
                    if cell(row, 'Уровень агрегации') != requested_level:
                        self.skipped_other_level += 1
                        continue
                    at = stats_address_kind(cell(row, 'Тип ключа адреса'))
                    ak = norm_uuid(cell(row, 'ID адреса для сопоставления'))
                    ek = stats_entrance_kind(cell(row, 'Тип ключа подъезда')) if requested_level == 'Подъезд' else ''
                    ev = cell(row, 'Ключ подъезда для сопоставления') if requested_level == 'Подъезд' else ''
                    if ek == 'NUMBER':
                        if ev.upper().startswith('NUMBER:'):
                            ev = clean_entrance_number(ev[7:])
                        else:
                            ev = clean_entrance_number(ev)
                    elif ek in ('entrances.root_id','entrances.id'):
                        ev = norm_uuid(ev)
                    if not ak:
                        self.no_address_key += 1
                    nums = [parse_nonnegative_int(cell(row,x),x,i) for x in STATS_COLUMNS]
                    record = (at,ak,ek,ev,cell(row,'УНОМ из заявок'),
                              cell(row,LAST_DATE_COLUMN),*nums)
                    try:
                        self.conn.execute(sql, record)
                    except sqlite3.IntegrityError as err:
                        raise ValueError(
                            f'Дублирующаяся агрегированная строка заявок в CSV, строка {i}: '
                            f'тип адреса={at}, ID={ak}, тип подъезда={ek}, ключ={ev}. '
                            'Перед объединением надо удалить дубликаты / перепроверить SQL.'
                        ) from err
                    self.loaded += 1
                    self.by_keytype[(at,ek)] += 1
        finally:
            fh.close()
        self.conn.execute('CREATE INDEX idx_stats ON stats(a_type,a_key,e_type,e_key)')
        self.conn.commit()
        self.select = 'SELECT rowid, unom, last_date, ' + ', '.join('n'+str(i) for i in range(len(STATS_COLUMNS))) + ' FROM stats WHERE a_type=? AND a_key=? AND e_type=? AND e_key=?'
        self.used_rows = set()  # rowids only (memory ~few MB)

    def match(self, addr_keys, entrance_kind='', entrance_key=''):
        found = {}
        for at, ak in addr_keys:
            for result in self.conn.execute(self.select, (at,ak,entrance_kind,entrance_key)):
                found[result[0]] = result
        self.used_rows.update(found)
        return list(found.values())

    def unmatched_report(self):
        # used_rows to temp table, avoids huge placeholders in one IN (...).
        self.conn.execute('CREATE TEMP TABLE matched(row_id INTEGER PRIMARY KEY)')
        self.conn.executemany('INSERT INTO matched(row_id) VALUES (?)', ((v,) for v in self.used_rows))
        rows = self.conn.execute("""
            SELECT s.a_type,s.e_type,COUNT(*)
            FROM stats s LEFT JOIN matched m ON m.row_id=s.rowid
            WHERE m.row_id IS NULL
            GROUP BY s.a_type,s.e_type ORDER BY COUNT(*) DESC
        """).fetchall()
        example = self.conn.execute("""
            SELECT s.a_type,s.a_key,s.e_type,s.e_key,n0
            FROM stats s LEFT JOIN matched m ON m.row_id=s.rowid
            WHERE m.row_id IS NULL ORDER BY s.rowid LIMIT 20
        """).fetchall()
        return rows, example

    def close(self):
        self.conn.close()
        self.work.cleanup()


def combine_statistics(results, input_unom):
    totals = [0]*len(STATS_COLUMNS)
    dates = []
    unoms = set()
    for rec in results:
        _, unom, date, *values = rec
        for n,v in enumerate(values):
            totals[n] += v
        if date:
            dates.append(date)
        for candidate in unom.split(';'):
            if candidate.strip():
                unoms.add(candidate.strip())
    mismatch = bool(input_unom and unoms and norm_unom(input_unom) not in {norm_unom(v) for v in unoms})
    return totals, max(dates) if dates else '', '; '.join(sorted(unoms)), mismatch


def extras(results, status, unom):
    totals, latest, unom_values, mismatch = combine_statistics(results, unom)
    return [status, len(results), unom_values, 'Да' if mismatch else 'Нет', *totals, latest]


def safe_paths(inputs, output):
    target = Path(output).resolve()
    if any(target == Path(p).resolve() for p in inputs):
        raise ValueError('Нельзя записывать результат поверх исходного CSV.')
    target.parent.mkdir(parents=True, exist_ok=True)
    return target


def write_report(dest, level, input_rows, output_rows, statsdb, matched_rows,
                 missing_rows, unom_errors, additional_lines=None):
    unmatched, examples = statsdb.unmatched_report()
    lines = [
        'КОНТРОЛЬ ОБЪЕДИНЕНИЯ ДАННЫХ ЕДЦ — ' + level,
        '='*68,
        f'Строк исходного реестра: {input_rows}',
        f'Строк выходного CSV: {output_rows}',
        f'Строк с найденными агрегатами заявок: {matched_rows}',
        f'Строк без подходящего агрегата: {missing_rows}',
        f'Строк с расхождением УНОМ (сопоставление по UUID): {unom_errors}',
        f'Агрегатов уровня {level} в CSV заявок: {statsdb.loaded}',
        f'Агрегатов, сопоставленных хотя бы один раз: {len(statsdb.used_rows)}',
        f'Агрегатов, оставшихся без привязки: {sum(r[2] for r in unmatched)}',
        '',
        'Несопоставленные агрегаты по типу ключей:',
    ]
    lines += [f'  {a} / {e or "(дом)"}: {n}' for a,e,n in unmatched] or ['  Нет']
    lines += ['', 'Примеры несопоставленных агрегатов (первые 20):']
    lines += [f'  {a} | {ak} | {e} | {ek} | заявок: {num}'
              for a,ak,e,ek,num in examples] or ['  Нет']
    if additional_lines:
        lines.extend(['', *additional_lines])
    lines.extend(['',
        'ВАЖНО: заявки с ключом подъезда UNKNOWN и резервным entrances.id не могут',
        'автоматически распределяться между подъездами без данных для сопоставления.',
        'Пустой результат поиска по UUID подъезда не доказывает отсутствие заявок вообще.',
        'Период статистики: созданные в 2026 году, фактически по момент выгрузки.',
    ])
    Path(dest).write_text('\n'.join(lines)+'\n', encoding='utf-8')
    return unmatched


def make_number_uniqueness(path, encoding, delimiter):
    """Считает номера подъездов в пределах дома; необходим для безопасного fallback."""
    count=Counter()
    fh,rd=open_csv(path,encoding,delimiter)
    need_columns(rd,['Корневой ID адреса','ID записи адреса','Корневой ID подъезда','Подъезд (номер либо ID)'],path)
    try:
        for record in rd:
            if None in record:
                raise ValueError('Некорректное число полей во входном CSV подъездов.')
            if not cell(record,'Корневой ID подъезда'):
                continue
            label=cell(record,'Подъезд (номер либо ID)')
            if not label or label.startswith('[ID подъезда:'):
                continue
            number=clean_entrance_number(label)
            for typ,key in address_keys(record):
                count[(typ,key,number)]+=1
    finally:
        fh.close()
    return count


def main():
    ap=argparse.ArgumentParser(description='ЕДЦ: объединение все подъезды + заявки 2026.')
    ap.add_argument('--entrances',required=True,help='CSV № 2 из SQL-запроса № 3 (адреса и подъезды)')
    ap.add_argument('--requests',required=True,help='CSV № 3 из SQL-запроса № 4 (агрегаты заявок)')
    ap.add_argument('--output',default='Подъезды_ЕДЦ_2026_с_заявками.csv')
    ap.add_argument('--report',help='Контрольный отчёт TXT; по умолчанию <output>.control.txt')
    ap.add_argument('--encoding',default='auto')
    ap.add_argument('--delimiter',default='auto')
    ap.add_argument('--match-by-number',action='store_true',
                    help='Дополнительно сопоставлять заявки только с номером подъезда, '
                         'если номер уникален в доме. Результат помечается как условный.')
    args=ap.parse_args()
    configure_csv_limits()
    output=safe_paths([args.entrances,args.requests],args.output)
    report=Path(args.report) if args.report else Path(str(output)+'.control.txt')
    db=StatsDB(args.requests,'Подъезд',args.encoding,args.delimiter)
    counts=make_number_uniqueness(args.entrances,args.encoding,args.delimiter) if args.match_by_number else {}
    rows=0;matched=0;no_match=0;mismatched=0;empty_entry=0
    uuid_matches=0;number_matches=0;ambiguous=0
    try:
        fh,rd=open_csv(args.entrances,args.encoding,args.delimiter)
        needed=['Корневой ID адреса','ID записи адреса','Корневой ID подъезда',
                'Подъезд (номер либо ID)','УНОМ']
        need_columns(rd,needed,args.entrances)
        if set(rd.fieldnames) & set(ADD_COLUMNS):
            raise ValueError('CSV подъездов уже содержит итоговую статистику — требуется исходный CSV.')
        with fh,open(output,'w',encoding='utf-8-sig',newline='') as wf:
            wr=csv.writer(wf,delimiter=',',quoting=csv.QUOTE_MINIMAL)
            wr.writerow(rd.fieldnames+ADD_COLUMNS)
            for record in rd:
                if None in record:
                    raise ValueError('Строка CSV содержит лишние колонки. Проверьте разделитель файла.')
                rows+=1
                addr=address_keys(record)
                ent_uuid=norm_uuid(cell(record,'Корневой ID подъезда'))
                matches=[];status=''
                if not ent_uuid:
                    empty_entry+=1
                    status='Нет подъезда в реестре: статистика не распределяется'
                else:
                    uuid_results=db.match(addr,'entrances.root_id',ent_uuid)
                    matches.extend(uuid_results)
                    if uuid_results:
                        uuid_matches+=1
                    # Резервный entrances.id сознательно НЕ приравнивается к root_id.
                    label=cell(record,'Подъезд (номер либо ID)')
                    if args.match_by_number and label and not label.startswith('[ID подъезда:'):
                        number=clean_entrance_number(label)
                        if number and all(counts[(a,k,number)]==1 for a,k in addr):
                            numbered=db.match(addr,'NUMBER',number)
                            used_ids={v[0] for v in matches}
                            new=[v for v in numbered if v[0] not in used_ids]
                            matches.extend(new)
                            number_matches+=bool(new)
                        else:
                            ambiguous+=1
                    if uuid_results and len(matches)>len(uuid_results):
                        status='UUID подъезда + уникальный номер (номер проверять)'
                    elif uuid_results:
                        status='Совпало по UUID подъезда'
                    elif matches:
                        status='Только уникальный номер подъезда (условно)'
                    elif args.match_by_number and (not label or label.startswith('[ID подъезда:')):
                        status='Нет UUID-агрегата; номер неизвестен'
                    else:
                        status='Нет агрегата по UUID подъезда'
                result=extras(matches,status,cell(record,'УНОМ'))
                matched+=bool(matches)
                no_match+=not matches
                mismatched+=result[3]=='Да'
                wr.writerow([record.get(x,'') or '' for x in rd.fieldnames]+result)
                if rows%50000==0:
                    print(f'Подъезды: обработано {rows:,} строк...',flush=True)
        if rows==0:
            raise ValueError('Исходная выгрузка подъездов пуста.')
        details=[
            f'Строк с пустым ID подъезда (заглушки домов): {empty_entry}',
            f'Строк с совпадением по UUID подъезда: {uuid_matches}',
            f'Строк с дополнительным совпадением по номеру: {number_matches}',
            f'Неоднозначные номера (если включена опция): {ambiguous}',
            'Сопоставление только по номеру: '+('ВКЛЮЧЕНО' if args.match_by_number else 'ВЫКЛЮЧЕНО'),
        ]
        write_report(report,'Подъезд',rows,rows,db,matched,no_match,mismatched,details)
        print(f'ГОТОВО: {output} | строк: {rows:,} | совпадений: {matched:,}')
        print('Контрольный отчёт:',report)
        if not matched:
            print('ПРЕДУПРЕЖДЕНИЕ: нет ни одного совпадения. Проверьте ключи.',file=sys.stderr)
            return 2
        return 0
    finally:
        db.close()

if __name__=='__main__':
    try:
        sys.exit(main())
    except (ValueError,OSError,csv.Error) as exc:
        print('ОШИБКА:',exc,file=sys.stderr)
        sys.exit(1)
