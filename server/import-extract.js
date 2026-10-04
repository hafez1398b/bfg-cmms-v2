'use strict';

const zlib = require('zlib');

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function findEocd(buffer) {
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let index = buffer.length - 22; index >= min; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) return index;
  }
  return -1;
}

function unzip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) return [];
  const eocd = findEocd(buffer);
  if (eocd < 0) return [];
  const count = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  const files = [];
  for (let index = 0; index < count && cursor + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (localOffset + 30 <= buffer.length) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = buffer.slice(dataStart, dataStart + compressedSize);
      let data = compressed;
      if (method === 8) {
        try { data = zlib.inflateRawSync(compressed); } catch (_) { data = Buffer.alloc(0); }
      } else if (method !== 0) data = Buffer.alloc(0);
      files.push({ name, data });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function sharedStrings(xml) {
  const blocks = String(xml || '').match(/<si\b[\s\S]*?<\/si>/g) || [];
  return blocks.map(block => [...block.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join(''));
}

function sheetRows(xml, strings) {
  const rows = [];
  for (const row of String(xml || '').match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const cell of row.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []) {
      const type = (cell.match(/\bt="([^"]+)"/) || [])[1] || '';
      const value = (cell.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const inline = [...cell.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(match => decodeXml(match[1])).join('');
      if (type === 's') cells.push(strings[Number(value)] || '');
      else if (type === 'inlineStr') cells.push(inline);
      else cells.push(value == null ? inline : decodeXml(value));
    }
    if (cells.some(cell => String(cell).trim())) rows.push(cells.map(cell => String(cell).trim()));
    if (rows.length >= 80) break;
  }
  return rows;
}

function extractXlsx(buffer) {
  const files = unzip(buffer);
  const shared = files.find(file => /(^|\/)sharedStrings\.xml$/i.test(file.name));
  const sheet = files.find(file => /xl\/worksheets\/sheet1\.xml$/i.test(file.name))
    || files.find(file => /xl\/worksheets\/sheet[^/]*\.xml$/i.test(file.name));
  if (!sheet) return '';
  const strings = shared ? sharedStrings(shared.data.toString('utf8')) : [];
  const rows = sheetRows(sheet.data.toString('utf8'), strings).map(row => row.slice(0, 16));
  return rows.map(row => row.join('\t')).join('\n');
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { cell += '"'; index += 1; }
        else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(cell.trim()); cell = ''; continue; }
    if (char === '\n') {
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = '';
      if (rows.length >= 80) break;
      continue;
    }
    if (char !== '\r') cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean) && rows.length < 80) rows.push(row);
  return rows;
}

function extractPdfText(buffer) {
  const latin = buffer.toString('latin1');
  const chunks = [];
  let index = 0;
  while (index < latin.length) {
    const found = latin.indexOf('stream', index);
    if (found < 0) break;
    const dict = latin.slice(Math.max(0, found - 400), found);
    let start = found + 6;
    if (latin[start] === '\r') start += 1;
    if (latin[start] === '\n') start += 1;
    const end = latin.indexOf('endstream', start);
    if (end < 0) break;
    let chunk = Buffer.from(latin.slice(start, end), 'latin1');
    if (/FlateDecode/.test(dict)) {
      try { chunk = zlib.inflateSync(chunk); }
      catch (_) {
        try { chunk = zlib.inflateRawSync(chunk); }
        catch (_) { chunk = Buffer.alloc(0); }
      }
    }
    chunks.push(chunk.toString('latin1'));
    index = end + 9;
  }
  const pieces = [];
  const source = chunks.join('\n');
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] !== '(') continue;
    let text = '';
    let next = cursor + 1;
    while (next < source.length) {
      if (source[next] === '\\' && next + 1 < source.length) { text += source[next + 1]; next += 2; continue; }
      if (source[next] === ')') break;
      text += source[next];
      next += 1;
    }
    if (text.trim()) pieces.push(text);
    cursor = next;
  }
  return pieces.join(' ').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 16000);
}

function extractImport(file) {
  const ext = file.ext;
  if (ext === 'md' || ext === 'csv' || ext === 'txt') {
    const text = file.buffer.toString('utf8').replace(/^\uFEFF/, '').slice(0, 16000);
    return { kind: ext === 'csv' ? 'table' : 'text', text, rows: ext === 'csv' ? parseCsv(text) : [] };
  }
  if (ext === 'xlsx') {
    const text = extractXlsx(file.buffer).slice(0, 16000);
    const rows = text ? text.split('\n').map(line => line.split('\t')) : [];
    return { kind: 'table', text, rows };
  }
  if (ext === 'pdf') {
    const text = extractPdfText(file.buffer);
    return { kind: 'text', text, rows: [], notice: text ? null : 'PDF_NO_TEXT_LAYER' };
  }
  if (ext === 'jpg' || ext === 'jpeg') {
    return { kind: 'image', text: '', rows: [], media: { kind: 'image', mimeType: 'image/jpeg', data: file.buffer.toString('base64') } };
  }
  return { kind: 'unknown', text: '', rows: [] };
}

module.exports = { unzip, extractXlsx, parseCsv, extractPdfText, extractImport, decodeXml };
