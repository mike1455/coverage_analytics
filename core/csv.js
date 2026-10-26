// Потоковый RFC 4180 CSV-парсер без зависимостей.
// Поддерживает кавычки, удвоенные кавычки, переводы строк внутри кавычек, CRLF/LF,
// разделители «,», «;», TAB. Кодировки: UTF-8, UTF-8 BOM, Windows-1251 (автоопределение).

export class CsvParser {
  constructor(delimiter, onRow) {
    this.d = delimiter;
    this.onRow = onRow;
    this.field = '';
    this.row = [];
    this.inQuotes = false;
    this.quotePending = false; // встретили кавычку внутри кавычек — ждём следующий символ
    this.rowsEmitted = 0;
    this.lastWasCR = false;
  }

  _endField() {
    this.row.push(this.field);
    this.field = '';
  }

  _endRow() {
    this._endField();
    const row = this.row;
    this.row = [];
    // Полностью пустые строки (например, финальный перевод строки) пропускаем.
    if (!(row.length === 1 && row[0] === '')) {
      this.rowsEmitted++;
      this.onRow(row);
    }
  }

  feed(chunk) {
    const d = this.d;
    const n = chunk.length;
    let i = 0;
    while (i < n) {
      if (this.inQuotes) {
        if (this.quotePending) {
          this.quotePending = false;
          const c = chunk[i];
          if (c === '"') { this.field += '"'; i++; continue; }
          this.inQuotes = false; // закрывающая кавычка
          continue; // обработать c вне кавычек
        }
        const q = chunk.indexOf('"', i);
        if (q === -1) { this.field += chunk.slice(i); return; }
        this.field += chunk.slice(i, q);
        i = q + 1;
        this.quotePending = true;
        continue;
      }
      const c = chunk[i];
      if (this.lastWasCR) {
        this.lastWasCR = false;
        if (c === '\n') { i++; continue; }
      }
      if (c === '"' && this.field === '') { this.inQuotes = true; i++; continue; }
      if (c === d) { this._endField(); i++; continue; }
      if (c === '\n') { this._endRow(); i++; continue; }
      if (c === '\r') { this._endRow(); this.lastWasCR = true; i++; continue; }
      // Быстрый путь: до ближайшего спецсимвола
      let j = i + 1;
      while (j < n) {
        const cj = chunk[j];
        if (cj === d || cj === '\n' || cj === '\r' || cj === '"') break;
        j++;
      }
      // Кавычка в середине неэкранированного поля — допускаем как обычный символ.
      if (j < n && chunk[j] === '"') { this.field += chunk.slice(i, j + 1); i = j + 1; continue; }
      this.field += chunk.slice(i, j);
      i = j;
    }
  }

  end() {
    if (this.quotePending) { this.quotePending = false; this.inQuotes = false; }
    if (this.inQuotes) {
      throw new Error('CSV оборван: незакрытая кавычка в конце файла. Проверьте экспорт.');
    }
    if (this.field !== '' || this.row.length) this._endRow();
  }
}

/** Определение разделителя по строке заголовка (вне кавычек). */
export function sniffDelimiter(text) {
  let line = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    if (!inQ && (c === '\n' || c === '\r')) break;
    line += c;
  }
  const count = (ch) => {
    let k = 0; let q = false;
    for (const c of line) { if (c === '"') q = !q; else if (!q && c === ch) k++; }
    return k;
  };
  const cands = [[',', count(',')], [';', count(';')], ['\t', count('\t')]];
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0][1] > 0 ? cands[0][0] : ',';
}

/** Кодировка по первым байтам: BOM → UTF-8; валидный UTF-8 → UTF-8; иначе Windows-1251. */
export function detectEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return 'utf-8';
  } catch (e) {
    return 'windows-1251';
  }
}

/**
 * Потоковое чтение CSV из Blob/File (браузер, worker).
 * onRow(rowArray, lineNo) вызывается для каждой строки данных, onHeader(headers) — один раз.
 * Каждые ~4 МБ вызывается await onChunk(progress) — для записи пачек в IndexedDB.
 */
export async function readCsvBlob(blob, { encoding = 'auto', delimiter = 'auto', onHeader, onRow, onChunk } = {}) {
  const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
  const enc = encoding === 'auto' ? detectEncoding(head) : encoding;
  const decoder = new TextDecoder(enc);
  const headText = new TextDecoder(enc).decode(head, { stream: true });
  const delim = delimiter === 'auto' ? sniffDelimiter(headText.replace(/^﻿/, '')) : delimiter;
  let header = null;
  let line = 1;
  let rowsInChunk = 0;
  const parser = new CsvParser(delim, (row) => {
    if (!header) {
      header = row.map((h, i) => (i === 0 ? h.replace(/^﻿/, '') : h));
      onHeader && onHeader(header);
      return;
    }
    line++;
    rowsInChunk++;
    onRow(row, line);
  });
  const reader = blob.stream().getReader();
  let readBytes = 0;
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    readBytes += value.length;
    let text = decoder.decode(value, { stream: true });
    if (first) { text = text.replace(/^﻿/, ''); first = false; }
    parser.feed(text);
    if (onChunk && rowsInChunk > 0) {
      rowsInChunk = 0;
      await onChunk({ bytes: readBytes, total: blob.size, rows: line - 1 });
    }
  }
  parser.feed(decoder.decode());
  parser.end();
  if (onChunk) await onChunk({ bytes: blob.size, total: blob.size, rows: line - 1, done: true });
  if (!header) throw new Error('Файл пуст: нет строки заголовков.');
  return { encoding: enc, delimiter: delim, rows: line - 1, header };
}

/** Синхронный разбор строки целиком (node-тесты, маленькие файлы). */
export function parseCsvText(text, delimiter = 'auto') {
  const t = text.replace(/^﻿/, '');
  const d = delimiter === 'auto' ? sniffDelimiter(t) : delimiter;
  const rows = [];
  const p = new CsvParser(d, (r) => rows.push(r));
  p.feed(t);
  p.end();
  return { delimiter: d, header: rows[0] || [], rows: rows.slice(1) };
}

/** Экранирование значения для записи CSV (запятая, UTF-8 с BOM при сохранении). */
export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  const out = [header.map(csvCell).join(',')];
  for (const r of rows) out.push(r.map(csvCell).join(','));
  return '﻿' + out.join('\r\n') + '\r\n';
}
