// Модульные тесты ядра: CSV, XLSX, заголовки, нормализация, МЖИ, определение типа файла.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { CsvParser, parseCsvText, sniffDelimiter, detectEncoding, toCsv } from '../core/csv.js';
import { readXlsx } from '../core/xlsx.js';
import { resolveColumns } from '../core/headers.js';
import { normUnom, normFias, parseBool, guessDateFromFilename, recordHash } from '../core/util.js';
import { parseMji } from '../core/mji.js';
import { detectKind, HOUSES_SPEC, ENTRANCES_SPEC, HOUSES_REQUIRED, ENTRANCES_REQUIRED, houseReader } from '../core/edc.js';
import { normOkrug, areaKey } from '../core/okrugs.js';

// Заголовки ровно как в «Примерах выгрузки» (S1) — с усечением PostgreSQL до 63 байт.
const HOUSES_HDR = readFileSync(join(ROOT, 'data/templates/01_дома.csv'), 'utf8').split(/\r?\n/)[0];
const ENTR_HDR = readFileSync(join(ROOT, 'data/templates/02_подъезды.csv'), 'utf8').split(/\r?\n/)[0];
const REQ_HDR = readFileSync(join(ROOT, 'data/templates/03_заявки_2026.csv'), 'utf8').split(/\r?\n/)[0];

test('CSV: кавычки, удвоенные кавычки, переводы строк внутри поля, CRLF', () => {
  const text = 'a,b,c\r\n"x, y","он сказал ""да""","строка1\nстрока2"\r\n1,,3\r\n';
  const { header, rows } = parseCsvText(text);
  assert.deepEqual(header, ['a', 'b', 'c']);
  assert.deepEqual(rows, [['x, y', 'он сказал "да"', 'строка1\nстрока2'], ['1', '', '3']]);
});

test('CSV: разбор по одному символу совпадает с разбором целиком (границы порций)', () => {
  const text = 'h1;h2\n"a;""b""";"c\r\nd"\r\n"";x\n';
  const whole = parseCsvText(text).rows;
  const rows = [];
  const p = new CsvParser(';', (r) => rows.push(r));
  for (const ch of text) p.feed(ch);
  p.end();
  assert.deepEqual(rows.slice(1), whole);
  assert.deepEqual(whole, [['a;"b"', 'c\r\nd'], ['', 'x']]);
});

test('CSV: разделитель и кодировка определяются автоматически', () => {
  assert.equal(sniffDelimiter('"a;b",c,d\n1,2,3'), ',');
  assert.equal(sniffDelimiter('a;b;c\n'), ';');
  assert.equal(sniffDelimiter('a\tb\tc\n'), '\t');
  assert.equal(detectEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])), 'utf-8');
  assert.equal(detectEncoding(new TextEncoder().encode('Адрес,УНОМ')), 'utf-8');
  assert.equal(detectEncoding(new Uint8Array([0xc0, 0xe4, 0xf0, 0xe5, 0xf1])), 'windows-1251'); // «Адрес» в cp1251
});

test('CSV: незакрытая кавычка — понятная ошибка', () => {
  assert.throws(() => parseCsvText('a,b\n"x,1\n'), /незакрытая кавычка/);
});

test('CSV: запись с BOM и экранированием', () => {
  const s = toCsv(['УНОМ', 'Адрес'], [['007', 'ул. А, д.1'], ['8', 'с "кавычками"']]);
  assert.ok(s.startsWith('﻿'));
  assert.deepEqual(parseCsvText(s).rows, [['007', 'ул. А, д.1'], ['8', 'с "кавычками"']]);
});

test('XLSX: shared/inline strings, числа без потерь, сущности, пустые ячейки', () => {
  const { sheetName, rows } = readXlsx(readFileSync(join(ROOT, 'tests/fixtures/mji_small.xlsx')));
  assert.equal(sheetName, 'МЖИ_тест');
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], ['Код', 'Округ', 'Район', 'Наименование/адрес', 'ФИАС', 'UNOM', 'Управляющая организация']);
  assert.equal(rows[1][5], '15425');
  assert.equal(rows[1][6], 'ТСЖ "ТЕСТ" & <партнёры>');
  assert.equal(rows[2][4] || '', '');
  assert.equal(rows[5][5], '0004400873', 'текстовый УНОМ с ведущими нулями сохраняется');
  assert.equal(rows[5][6], 'ООО «УК»\nвторая строка');
});

test('МЖИ: нормализация, проверки качества, дубли ФИАС без учёта регистра', () => {
  const { rows } = readXlsx(readFileSync(join(ROOT, 'tests/fixtures/mji_small.xlsx')));
  const { houses, report } = parseMji(rows[0], rows.slice(1));
  assert.equal(report.rowsTotal, 5);
  assert.deepEqual(report.errors, []);
  assert.equal(report.noFias, 1);
  assert.equal(report.invalidFias, 2); // nan, 0x2a
  assert.equal(report.dupFiasValues, 1); // один и тот же UUID в разном регистре
  assert.equal(report.noOkrug, 1);
  assert.equal(houses[2].okrug, 'СВАО');
  assert.equal(houses[4].u, '4400873');
  assert.equal(houses[4].ur, '0004400873');
  assert.equal(houses[0].fiasDup, true);
  assert.equal(houses[2].fiasValid, false);
});

test('МЖИ: повторяющийся UNOM — критическая ошибка', () => {
  const h = ['Округ', 'Район', 'Наименование/адрес', 'UNOM'];
  const { report } = parseMji(h, [['ЦАО', 'А', 'x', '1'], ['ЦАО', 'А', 'y', '001']]);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0], /UNOM повторяется/);
});

test('нормализация идентификаторов', () => {
  assert.equal(normUnom(' 0015425 '), '15425');
  assert.equal(normUnom('15425.0'), '15425');
  assert.equal(normUnom('0'), '0');
  assert.equal(normUnom(''), '');
  assert.equal(normFias('nan').valid, false);
  assert.equal(normFias('0x2a').valid, false);
  assert.equal(normFias('b8796595-cf08-43f4-b230-0a769cb08ab9').value, 'B8796595-CF08-43F4-B230-0A769CB08AB9');
  assert.equal(parseBool('true'), true);
  assert.equal(parseBool('f'), false);
  assert.equal(parseBool(''), null);
  assert.equal(guessDateFromFilename('19.10.26_МКД_SELECT_202610191348(1).xlsx'), '2026-10-19');
  assert.equal(guessDateFromFilename('выгрузка 01.02.2026.csv'), '2026-02-01');
  assert.equal(recordHash({ s: 1, a: 1, b: 2 }), recordHash({ b: 2, a: 1, s: 99 }));
});

test('заголовки, усечённые PostgreSQL до 63 байт, сопоставляются однозначно', () => {
  const h = parseCsvText(HOUSES_HDR + '\n').header;
  const cols = resolveColumns(h, HOUSES_SPEC, HOUSES_REQUIRED);
  assert.deepEqual(cols.missing, []);
  assert.deepEqual(cols.ambiguous, []);
  assert.deepEqual(cols.unknown, []);
  assert.equal(h[cols.index.isLast], 'Последняя версия записи адреса (is_l');
  assert.equal(h[cols.index.entrActFalse], 'Подъездов actual=false (если поле сущест');
  const e = parseCsvText(ENTR_HDR + '\n').header;
  const ce = resolveColumns(e, ENTRANCES_SPEC, ENTRANCES_REQUIRED);
  assert.deepEqual([ce.missing, ce.ambiguous, ce.unknown], [[], [], []]);
  assert.equal(e[ce.index.eRelCount], 'Количество настроек обслуживания');
});

test('тип файла определяется по заголовкам, не по имени', () => {
  assert.equal(detectKind(parseCsvText(HOUSES_HDR).header), 'houses');
  assert.equal(detectKind(parseCsvText(ENTR_HDR).header), 'entrances');
  assert.equal(detectKind(parseCsvText(REQ_HDR).header), 'requests');
  assert.equal(detectKind(['Код', 'Округ', 'Район', 'Наименование/адрес', 'ФИАС', 'UNOM']), 'mji');
  const merged = [...parseCsvText(HOUSES_HDR).header, 'Статистика 2026: способ сопоставления'];
  assert.equal(detectKind(merged), 'houses_merged');
  assert.equal(detectKind(['a', 'b']), 'unknown');
  // Ненужные для импорта выгрузки распознаются и пропускаются, а не считаются ошибкой
  assert.equal(detectKind(['Тип дома в ЕДЦ (house_type)', 'Принадлежность (affiliation)', 'Актуальность объекта (actual)', 'Число последних версий адресных з', 'Пример адреса']), 'sql1');
  assert.equal(detectKind(['Взято строк привязок', 'Строк после JOIN (версии подъездов м']), 'sql5');
  assert.equal(detectKind(['Адрес', 'УНОМ', 'ФИАС', 'ID адреса', 'Тип дома', 'Есть привязка платного дефекта', 'Количество платных дефектов', 'ID платных дефектов', 'Количество организаций', 'ID обслуживающих организаций']), 'sql6');
});

test('CSV домов: лишние колонки в строке и привязок больше, чем подъездов — ошибка', () => {
  const h = parseCsvText(HOUSES_HDR).header;
  const rd = houseReader(h, false);
  const row = h.map(() => '');
  row[h.indexOf('Корневой ID адреса')] = 'A';
  row[h.indexOf('Количество подъездов в реестре ЕД')] = '1';
  row[h.indexOf('Подъездов с найденной привязкой')] = '2';
  assert.throws(() => rd.read(row, 2), /больше, чем подъездов/);
  assert.throws(() => rd.read([...row, 'x'], 3), /лишние колонки/);
});

test('округа: разные написания', () => {
  assert.equal(normOkrug('ЦАО'), 'ЦАО');
  assert.equal(normOkrug('Центральный административный округ'), 'ЦАО');
  assert.equal(normOkrug('Зеленоградский'), 'ЗелАО');
  assert.equal(normOkrug('зелао'), 'ЗелАО');
  assert.equal(normOkrug('Новомосковский административный округ'), 'НАО');
  assert.equal(normOkrug('Непонятный'), '');
  assert.equal(areaKey('район Арбат'), 'арбат');
  assert.equal(areaKey('поселение Сосенское'), 'сосенское');
  assert.equal(areaKey('"Мосрентген"'), 'мосрентген');
  assert.equal(areaKey('Савёлки'), 'савелки');
  assert.equal(areaKey('муниципальный округ Выхино-Жулебино'), areaKey('Выхино-Жулебино'));
});
