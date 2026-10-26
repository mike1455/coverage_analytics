// Общие функции нормализации. Используются и в браузере (Web Worker), и в node-тестах.
// UUID, УНОМ и ФИАС всегда остаются строками: никаких Number(), parseInt() для идентификаторов.

import { ob } from './compact.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function str(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/** Нормализация заголовка CSV/XLSX для сравнения: BOM, пробелы, регистр, ё. */
export function normHeader(h) {
  return str(h).replace(/^﻿/, '').replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');
}

export function isUuid(v) {
  return UUID_RE.test(str(v));
}

/** UUID ЕДЦ: как в S2 - trim + нижний регистр. */
export function normUuid(v) {
  return ob(str(v).toLowerCase());
}

/**
 * УНОМ для сопоставления: как norm_unom в S2 (убрать ведущие нули).
 * Дополнительно убирается хвост ".0", который появляется, если файл прошёл через Excel.
 * Исходное значение нужно хранить отдельно и показывать пользователю.
 */
export function normUnom(v) {
  let s = str(v);
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  if (!s) return '';
  const stripped = s.replace(/^0+/, '');
  return ob(stripped || '0');
}

/** ФИАС: верхний регистр; валиден только корректный UUID (в МЖИ встречаются «nan», «0x2a», усечённые значения). */
export function normFias(v) {
  const raw = ob(str(v));
  const up = ob(raw.toUpperCase());
  return { raw, value: UUID_RE.test(up) ? up : '', valid: UUID_RE.test(up), empty: raw === '' };
}

/** Булевы значения из DBeaver/PostgreSQL. Пусто/неизвестно → null (не false!). */
export function parseBool(v) {
  const s = str(v).toLowerCase();
  if (s === 'true' || s === 't' || s === '1' || s === 'да' || s === 'yes') return true;
  if (s === 'false' || s === 'f' || s === '0' || s === 'нет' || s === 'no') return false;
  return null;
}

/** Неотрицательное целое (счётчики). Пусто → 0; мусор → ошибка с понятным текстом. */
export function parseCount(v, field, line) {
  const s = str(v);
  if (!s) return 0;
  if (!/^\d+$/.test(s)) {
    throw new ImportError(`Строка ${line}: поле «${field}» должно быть целым числом ≥ 0, получено «${s}»`);
  }
  return Number(s);
}

export function lowerYo(v) {
  return str(v).toLowerCase().replace(/ё/g, 'е');
}

export class ImportError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ImportError';
    this.details = details || null;
  }
}

/** FNV-1a 32 bit - быстрый хэш для сравнения снимков (не криптографический). */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Хэш записи без служебных полей (снимок и сам хэш). */
export function recordHash(rec) {
  const keys = Object.keys(rec).filter((k) => k !== 's' && k !== 'hs').sort();
  return fnv1a(JSON.stringify(keys.map((k) => [k, rec[k]])));
}

/** Сравнение дат строками допустимо только в одном формате; приводим к ISO для максимума. */
export function dateKey(v) {
  const s = str(v);
  if (!s) return '';
  // DBeaver: 2026-09-08 12:15:16.933 +0300
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?\s*([+-]\d{2}:?\d{2}|Z)?$/);
  if (!m) return s;
  const tz = m[3] ? (m[3] === 'Z' ? 'Z' : m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : '+03:00';
  const iso = `${m[1]}T${m[2] || '00:00:00'}${tz}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : s;
}

export function maxDate(a, b) {
  if (!a) return b || '';
  if (!b) return a;
  return dateKey(a) >= dateKey(b) ? a : b;
}

/** Дата среза по имени файла: «19.10.26_...» или «...202610191348...». */
export function guessDateFromFilename(name) {
  const s = str(name);
  let m = s.match(/(20\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{2})\.(\d{2})\.(\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2]}-${m[1]}`;
  }
  return '';
}

export const nowIso = () => new Date().toISOString();
