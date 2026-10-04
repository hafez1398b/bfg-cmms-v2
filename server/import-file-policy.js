'use strict';

const crypto = require('crypto');
const path = require('path');

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = new Set(['md', 'xlsx', 'csv', 'pdf', 'jpg', 'jpeg']);
const DANGEROUS = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'js', 'mjs', 'vbs', 'ps1', 'sh', 'html', 'htm', 'svg', 'php'
]);

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function startsWith(buffer, bytes) {
  return buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);
}

function magicMatches(ext, buffer) {
  if (ext === 'jpg' || ext === 'jpeg') return startsWith(buffer, [0xff, 0xd8, 0xff]);
  if (ext === 'pdf') return buffer.slice(0, 5).toString('ascii') === '%PDF-';
  if (ext === 'xlsx') return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
  if (ext === 'md' || ext === 'csv') {
    return !buffer.includes(0) && !startsWith(buffer, [0x4d, 0x5a]) && !startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46]);
  }
  return false;
}

function validateImportFile(file) {
  const buffer = Buffer.isBuffer(file && file.buffer) ? file.buffer : Buffer.alloc(0);
  if (!buffer.length) throw coded(422, 'FILE_EMPTY');
  if (buffer.length > MAX_BYTES) throw coded(413, 'FILE_TOO_LARGE');
  const raw = String(file.name || '');
  if (raw.includes('\0') || raw.includes('%00') || /[\\/]/.test(raw) || raw.includes('..')) throw coded(422, 'FILE_NAME_REJECTED');
  const base = path.basename(raw).replace(/[\u0000-\u001f]/g, '').trim();
  if (!base || base !== raw || base.length > 180 || base.startsWith('.')) throw coded(422, 'FILE_NAME_REJECTED');
  const parts = base.toLowerCase().split('.');
  if (parts.length < 2 || parts.some(part => !part) || parts.slice(1).some(ext => DANGEROUS.has(ext))) throw coded(422, 'DANGEROUS_FILE_REJECTED');
  const ext = parts[parts.length - 1];
  if (!ALLOWED.has(ext) || !magicMatches(ext, buffer)) throw coded(422, 'FILE_TYPE_REJECTED');
  if (ext === 'pdf' && /\/(?:JavaScript|JS|Launch|EmbeddedFile|OpenAction)\b/.test(buffer.toString('latin1'))) throw coded(422, 'DANGEROUS_FILE_REJECTED');
  if (ext === 'xlsx' && /\.(?:exe|dll|bat|cmd|js|vbs|ps1|html|svg|php|sh)\b/i.test(buffer.toString('latin1'))) throw coded(422, 'DANGEROUS_FILE_REJECTED');
  return {
    originalName: base,
    ext,
    buffer,
    byteSize: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

module.exports = { validateImportFile, MAX_BYTES, ALLOWED };
