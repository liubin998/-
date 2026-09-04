import { unzipEntries } from './zip.js';

function colLetterToIndex(letters) {
  let idx = 0;
  for (const ch of letters) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export function parseXlsx(buf) {
  const entries = unzipEntries(buf);
  const sharedStrings = [];
  const sst = entries.get('xl/sharedStrings.xml');
  if (sst) {
    const sstText = sst.toString('utf8');
    const siRe = /<si>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRe.exec(sstText))) {
      const inner = m[1];
      const parts = [];
      const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRe.exec(inner))) parts.push(decodeXml(tm[1]));
      sharedStrings.push(parts.join(''));
    }
  }

  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8') || '';
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8') || '';
  const relMap = new Map();
  const relRe = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g;
  let rm;
  while ((rm = relRe.exec(relsXml))) {
    relMap.set(rm[1], rm[2].replace(/^\//, ''));
  }

  const sheets = [];
  const sheetRe = /<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g;
  let sm;
  while ((sm = sheetRe.exec(workbookXml))) {
    let target = relMap.get(sm[2]) || sm[2];
    if (!target.startsWith('xl/')) target = `xl/${target}`;
    sheets.push({ name: decodeXml(sm[1]), target });
  }
  if (!sheets.length) {
    const keys = [...entries.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
    for (const key of keys) {
      sheets.push({ name: key.match(/sheet(\d+)\.xml/)[1], target: key });
    }
  }

  return sheets.map((sheet) => ({
    name: sheet.name,
    rows: parseSheetXml(entries.get(sheet.target)?.toString('utf8') || '', sharedStrings),
  }));
}

function parseSheetXml(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
    let cm;
    while ((cm = cellRe.exec(rowMatch[1]))) {
      const attrs = cm[1] || cm[3] || '';
      const inner = cm[2] || '';
      const refMatch = attrs.match(/r="([A-Z]+)\d+"/);
      const typeMatch = attrs.match(/t="([^"]+)"/);
      const colIdx = refMatch ? colLetterToIndex(refMatch[1]) : cells.length;
      let value = '';
      const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
      if (typeMatch?.[1] === 'inlineStr') {
        const tMatch = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        value = tMatch ? decodeXml(tMatch[1]) : '';
      } else if (vMatch) {
        value = decodeXml(vMatch[1]);
        if (typeMatch?.[1] === 's') {
          const idx = Number(value);
          value = sharedStrings[idx] ?? value;
        }
      }
      while (cells.length <= colIdx) cells.push('');
      cells[colIdx] = value;
    }
    rows.push(cells);
  }
  return rows;
}
