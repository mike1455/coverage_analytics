// Запись XLSX: файл читается обратно нашим читателем, строки и числа на месте, имена листов допустимые.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from '../vendor/fflate/fflate.esm.js';
import { buildXlsx } from '../core/xlsxwrite.js';
import { readXlsx } from '../core/xlsx.js';

test('XLSX: шапка, строки, числа, проценты, спецсимволы', () => {
  const u8 = buildXlsx([
    {
      name: 'Дома', columns: [{ header: 'Адрес', width: 40 }, { header: 'Заявок', fmt: 'int' }, { header: 'Доля', fmt: 'pct' }],
      rows: [['ул. «Тверская» & <1>', 1234, 0.985], ['Пустые', null, ''], ['Ёлки', 0, 1]],
    },
    { name: 'Очень длинное имя листа: с [запрещёнными] символами?', columns: [{ header: 'A' }], rows: [['x']] },
  ]);
  const back = readXlsx(u8);
  assert.equal(back.sheetName, 'Дома');
  assert.deepEqual(back.rows[0], ['Адрес', 'Заявок', 'Доля']);
  assert.equal(back.rows[1][0], 'ул. «Тверская» & <1>');
  assert.equal(Number(back.rows[1][1]), 1234);
  assert.equal(Number(back.rows[1][2]), 0.985);
  assert.equal(back.rows[3][0], 'Ёлки');
  const files = unzipSync(u8);
  const wb = strFromU8(files['xl/workbook.xml']);
  const names = [...wb.matchAll(/<sheet name="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(names.length, 2);
  assert.ok(names[1].length <= 31 && !/[[\]:*?/\\]/.test(names[1]), 'имя листа допустимо в Excel');
  assert.match(strFromU8(files['xl/worksheets/sheet1.xml']), /<autoFilter ref="A1:C4"\/>/);
});
