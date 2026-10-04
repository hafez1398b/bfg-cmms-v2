'use strict';

const crypto = require('crypto');
const path = require('path');

const MAX_BYTES = 12 * 1024 * 1024;
const DANGEROUS = new Set([
  'exe','dll','bat','cmd','com','scr','msi','js','jse','mjs','cjs','vbs','vbe','ps1','sh','bash','zsh','ksh','csh',
  'jar','html','htm','svg','php','asp','aspx','py','rb','pl','apk','dmg','iso','lnk','reg','app','deb','rpm','elf',
  'so','bin','cpl','msc','hta','wsf','gadget','inf','msp','msix','appx','swf','xhtml','xml','shtml','cgi','war',
  'class','pif','cab','img','vhd','vhdx','wasm','pkg','scf','url','command','action','workflow','msi'
]);
const ALLOWED = new Set(['pdf','png','jpg','jpeg','gif','webp','txt','csv','docx','xlsx','mp4','webm']);
const MEDIA = {
  pdf:'application/pdf', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp',
  txt:'text/plain', csv:'text/csv',
  docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp4:'video/mp4', webm:'video/webm'
};

function coded(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function startsWith(buffer, bytes, offset = 0) {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

function magicMatches(ext, buffer) {
  if (ext === 'png') return startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (ext === 'jpg' || ext === 'jpeg') return startsWith(buffer, [0xff, 0xd8, 0xff]);
  if (ext === 'gif') return buffer.slice(0, 4).toString('ascii') === 'GIF8';
  if (ext === 'webp') return buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP';
  if (ext === 'pdf') return buffer.slice(0, 5).toString('ascii') === '%PDF-';
  if (ext === 'docx' || ext === 'xlsx') return startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]);
  if (ext === 'mp4') return buffer.slice(4, 8).toString('ascii') === 'ftyp';
  if (ext === 'webm') return startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3]);
  if (ext === 'txt' || ext === 'csv') return !buffer.includes(0) && !startsWith(buffer, [0x4d, 0x5a]) && !startsWith(buffer, [0x7f, 0x45, 0x4c, 0x46]);
  return false;
}

function payloadRejected(ext, buffer) {
  const text = buffer.toString('latin1');
  if (ext === 'pdf' && /\/(?:JavaScript|JS|Launch|EmbeddedFile|OpenAction)\b/.test(text)) return true;
  if (ext === 'docx' || ext === 'xlsx') {
    return /\.(?:exe|dll|bat|cmd|js|vbs|ps1|html|svg|php|sh)\b/i.test(text);
  }
  return false;
}

function validate(file) {
  const buffer = Buffer.isBuffer(file && file.buffer) ? file.buffer : Buffer.alloc(0);
  if (!buffer.length) throw coded(422, 'FILE_EMPTY');
  if (buffer.length > MAX_BYTES) throw coded(413, 'FILE_TOO_LARGE');
  const raw = String(file.name || '');
  if (raw.includes('\0') || raw.includes('%00') || /[\\/]/.test(raw) || raw.includes('..')) throw coded(422, 'FILE_NAME_REJECTED');
  const base = path.basename(raw).replace(/[\u0000-\u001f]/g, '').trim();
  if (!base || base !== raw || base.length > 180 || base.startsWith('.')) throw coded(422, 'FILE_NAME_REJECTED');
  const parts = base.toLowerCase().split('.');
  if (parts.length < 2 || parts.some(part => !part)) throw coded(422, 'FILE_NAME_REJECTED');
  if (parts.slice(1).some(ext => DANGEROUS.has(ext))) throw coded(422, 'DANGEROUS_FILE_REJECTED');
  const ext = parts[parts.length - 1];
  if (!ALLOWED.has(ext) || !magicMatches(ext, buffer) || payloadRejected(ext, buffer)) throw coded(422, 'FILE_TYPE_REJECTED');
  return {
    originalName: base,
    ext,
    mediaType: MEDIA[ext],
    buffer,
    byteSize: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex')
  };
}

function storedName(id, ext) {
  if (!/^[0-9a-f-]{36}$/i.test(id) || !ALLOWED.has(ext)) throw coded(422, 'FILE_NAME_REJECTED');
  return `${id}.${ext}`;
}

module.exports = { MAX_BYTES, validate, storedName, coded };
