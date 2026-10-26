// Минимальный читатель XLSX (первый лист) без SheetJS: zip через fflate + разбор XML регулярными выражениями.
// Достаточно для выгрузок DBeaver/Excel: shared strings, inline strings, числа, булевы.
// Все значения возвращаются строками - идентификаторы (UNOM, ФИАС) не превращаются в числа с потерями.

import { unzipSync, strFromU8 } from '../vendor/fflate/fflate.esm.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  if (s.indexOf('&') === -1 && s.indexOf('_x') === -1) return s;
  return s
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === '#') {
        const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return String.fromCodePoint(cp);
      }
      return ENT[e];
    })
    .replace(/_x([0-9a-fA-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function textOf(xmlFragment) {
  // Все <t>...</t> кроме фонетических <rPh>
  const noPh = xmlFragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g;
  let m;
  while ((m = re.exec(noPh))) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

function colIndex(ref) {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

function resolveSheetPath(files) {
  const wb = files['xl/workbook.xml'] ? strFromU8(files['xl/workbook.xml']) : '';
  const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
  const sheet = wb.match(/<sheet\b[^>]*>/);
  let name = '';
  if (sheet) {
    const nm = sheet[0].match(/\bname="([^"]*)"/);
    name = nm ? decodeXml(nm[1]) : '';
    const rid = sheet[0].match(/\br:id="([^"]*)"/);
    if (rid && rels) {
      const re = new RegExp(`<Relationship\\b[^>]*Id="${rid[1]}"[^>]*>`);
      const rel = rels.match(re);
      const tgt = rel && rel[0].match(/Target="([^"]*)"/);
      if (tgt) {
        let p = tgt[1].replace(/^\//, '');
        if (!p.startsWith('xl/')) p = 'xl/' + p;
        if (files[p]) return { path: p, name };
      }
    }
  }
  const first = Object.keys(files).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  return { path: first, name };
}

/** @returns {{sheetName:string, rows:string[][]}} */
export function readXlsx(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (u8[0] !== 0x50 || u8[1] !== 0x4b) throw new Error('Файл не похож на XLSX (не zip-архив).');
  const files = unzipSync(u8, {
    filter: (f) => f.name === 'xl/workbook.xml' || f.name === 'xl/_rels/workbook.xml.rels' ||
      f.name === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(f.name),
  });
  const { path, name } = resolveSheetPath(files);
  if (!path) throw new Error('В XLSX не найден лист с данными.');

  const shared = [];
  if (files['xl/sharedStrings.xml']) {
    const ss = strFromU8(files['xl/sharedStrings.xml']);
    const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
    let m;
    while ((m = re.exec(ss))) shared.push(m[1] ? textOf(m[1]) : '');
  }

  const xml = strFromU8(files[path]);
  const rows = [];
  const rowRe = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm;
  let nextRow = 0;
  while ((rm = rowRe.exec(xml))) {
    const rAttr = rm[0].match(/^<row\b[^>]*\br="(\d+)"/);
    const rIdx = rAttr ? Number(rAttr[1]) - 1 : nextRow;
    while (rows.length < rIdx) rows.push([]);
    nextRow = rIdx + 1;
    const row = [];
    const body = rm[1] || '';
    let cm;
    let nextCol = 0;
    cellRe.lastIndex = 0;
    while ((cm = cellRe.exec(body))) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const refM = attrs.match(/\br="([A-Z]+)\d+"/);
      const ci = refM ? colIndex(refM[1]) : nextCol;
      nextCol = ci + 1;
      const tM = attrs.match(/\bt="([^"]*)"/);
      const t = tM ? tM[1] : 'n';
      let val = '';
      if (t === 'inlineStr') {
        val = textOf(inner);
      } else {
        const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
        const v = vM ? decodeXml(vM[1]) : '';
        if (t === 's') val = v === '' ? '' : (shared[Number(v)] ?? '');
        else if (t === 'b') val = v === '1' ? 'true' : v === '0' ? 'false' : v;
        else if (t === 'str' || t === 'e') val = v;
        else val = /^-?\d+\.0+$/.test(v) ? v.replace(/\.0+$/, '') : v;
      }
      while (row.length < ci) row.push('');
      row[ci] = val;
    }
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return { sheetName: name, rows };
}
