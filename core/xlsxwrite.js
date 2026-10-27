// Минимальная запись XLSX без сторонних библиотек: несколько листов, жирная шапка, форматы чисел,
// ширина столбцов, закреплённая первая строка и автофильтр. Строки хранятся в общей таблице (sharedStrings).

import { zipSync, strToU8 } from '../vendor/fflate/fflate.esm.js';

// Стили ячеек (индексы в cellXfs ниже)
const STYLE = { text: 0, head: 1, int: 2, pct: 3, num1: 4, num2: 5, title: 6, date: 0 };

const esc = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

const sheetName = (s, used) => {
  let n = String(s).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Лист';
  let i = 2;
  while (used.has(n)) n = `${n.slice(0, 28)} ${i++}`;
  used.add(n);
  return n;
};

/**
 * @param {{name: string, columns: {header: string, width?: number, fmt?: 'text'|'int'|'pct'|'num1'|'num2'}[],
 *   rows: any[][], title?: string, filter?: boolean}[]} sheets  ячейка: значение или {v, fmt}
 * @returns {Uint8Array} содержимое файла .xlsx
 */
export function buildXlsx(sheets) {
  const strings = new Map();
  const sst = [];
  const si = (v) => {
    let i = strings.get(v);
    if (i === undefined) { i = sst.length; strings.set(v, i); sst.push(v); }
    return i;
  };
  const files = {};
  const used = new Set();
  const names = sheets.map((sh) => sheetName(sh.name, used));

  sheets.forEach((sh, n) => {
    const out = [];
    const cols = sh.columns;
    let r = 0;
    const cell = (ref, v, style) => {
      if (v && typeof v === 'object') { style = STYLE[v.fmt] ?? style; v = v.v; } // {v, fmt}: свой формат у ячейки
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'number') return Number.isFinite(v) ? `<c r="${ref}" s="${style}"><v>${v}</v></c>` : '';
      if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
      return `<c r="${ref}" t="s" s="${style === STYLE.head || style === STYLE.title ? style : STYLE.text}"><v>${si(String(v))}</v></c>`;
    };
    if (sh.title) {
      r++;
      out.push(`<row r="${r}">${cell(`A${r}`, sh.title, STYLE.title)}</row>`);
    }
    r++;
    const headRow = r;
    out.push(`<row r="${r}">${cols.map((c, i) => cell(`${colName(i)}${r}`, c.header, STYLE.head)).join('')}</row>`);
    const letters = cols.map((_, i) => colName(i));
    const styles = cols.map((c) => STYLE[c.fmt || 'text'] ?? STYLE.text);
    for (const row of sh.rows) {
      r++;
      let x = `<row r="${r}">`;
      for (let i = 0; i < cols.length; i++) x += cell(`${letters[i]}${r}`, row[i], styles[i]);
      out.push(`${x}</row>`);
    }
    const last = `${colName(Math.max(0, cols.length - 1))}${Math.max(r, headRow)}`;
    const widths = cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('');
    const pane = `<pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/>`;
    files[`xl/worksheets/sheet${n + 1}.xml`] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"${n === 0 ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>`
      + `<sheetFormatPr defaultRowHeight="15"/><cols>${widths}</cols><sheetData>${out.join('')}</sheetData>`
      + (sh.filter !== false && sh.rows.length ? `<autoFilter ref="A${headRow}:${last}"/>` : '')
      + '</worksheet>');
  });

  files['xl/sharedStrings.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">`
    + sst.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('') + '</sst>');
  files['xl/styles.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="#,##0.0"/></numFmts>'
    + '<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F0EC"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="2"><border/><border><bottom style="thin"><color rgb="FFC3C2B7"/></bottom></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="7">'
    + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>'
    + '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
  files['xl/workbook.xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets>${names.map((nm, i) => `<sheet name="${esc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + names.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
    + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`
    + `<Relationship Id="rId${names.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`
    + '</Relationships>');
  files['_rels/.rels'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  files['[Content_Types].xml'] = strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + '</Types>');
  return zipSync(files, { level: 6 });
}
