'use strict';
// The speech model for voice commands (renderer/voice.js): Vosk's small
// English model, downloaded once into Ponder's data folder. Vosk publishes
// it as a .zip; the recogniser in the window reads a .tar.gz, so the zip is
// unpacked and packed again as one, with Node's zlib.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MODEL_NAME = 'vosk-model-small-en-us-0.15';
const MODEL_URL = `https://alphacephei.com/vosk/models/${MODEL_NAME}.zip`;
const DOWNLOAD_MB = 40;

const modelFile = (dataDir) => path.join(dataDir, 'voice', `${MODEL_NAME}.tar.gz`);

// The files of a zip: [{ name, data }], directories left out.
function unzip(buf) {
  // The end of the central directory: its signature, searched from the end.
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('The speech model download is not a zip file.');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The speech model download is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`The speech model uses a zip method Ponder cannot read (${method}).`);
    if (data.length !== size) throw new Error('The speech model download is damaged.');
    files.push({ name, data });
  }
  return files;
}

// A tar archive (ustar) of the files, each folder listed before what is in
// it (the recogniser's unpacker makes no folders of its own).
function tar(files) {
  const parts = [];
  const dirs = new Set();
  const entries = [];
  for (const f of files) {
    const segs = f.name.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/') + '/';
      if (!dirs.has(d)) { dirs.add(d); entries.push({ name: d, data: Buffer.alloc(0), dir: true }); }
    }
    entries.push(f);
  }
  for (const { name, data, dir } of entries) {
    const h = Buffer.alloc(512);
    let base = name;
    let prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', 154);
      prefix = name.slice(0, cut);
      base = name.slice(cut + 1);
    }
    h.write(base, 0, 100);
    h.write(dir ? '0000755\0' : '0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148);
    h.write(dir ? '5' : '0', 156);
    h.write('ustar\0' + '00', 257);
    h.write(prefix, 345, 155);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, data);
    if (data.length % 512) parts.push(Buffer.alloc(512 - (data.length % 512)));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function status(dataDir) {
  return { installed: fs.existsSync(modelFile(dataDir)), downloadMB: DOWNLOAD_MB, name: MODEL_NAME };
}

// Download, unpack and keep the model; onProgress(0…1) as it comes.
async function install(dataDir, fetch, onProgress) {
  const res = await fetch(MODEL_URL, { headers: { 'User-Agent': 'Ponder' } });
  if (!res.ok) throw new Error(`The speech model could not be downloaded (${res.status}).`);
  const total = +res.headers.get('content-length') || DOWNLOAD_MB * 1e6;
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    onProgress?.(Math.min(1, got / total));
  }
  const files = unzip(Buffer.concat(chunks));
  if (!files.some((f) => f.name.endsWith('am/final.mdl'))) throw new Error('The speech model download is not a Vosk model.');
  const out = modelFile(dataDir);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out + '.part', zlib.gzipSync(tar(files)));
  fs.renameSync(out + '.part', out);
  return status(dataDir);
}

const read = (dataDir) => fs.readFileSync(modelFile(dataDir));

module.exports = { status, install, read, unzip, tar, MODEL_URL };
