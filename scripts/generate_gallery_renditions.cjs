#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const sharp = require('../worker/node_modules/sharp');

const EXPECTED_PHOTOS = 741;
const VERSION = 'optimized-v1';
const THUMB_EDGE = 480;
const DISPLAY_EDGE = 1600;

function parseCsv(source) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value.length === 0) quoted = true;
    else if (char === ',') { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(value); value = '';
      if (row.some(cell => cell.length)) rows.push(row);
      row = [];
    } else value += char;
  }
  if (value.length || row.length) { row.push(value); rows.push(row); }
  const headers = rows.shift() || [];
  return rows.map(cells => Object.fromEntries(headers.map((header, i) => [header, cells[i] || ''])));
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function argumentsFrom(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--shopping-root') result.shoppingRoot = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return result;
}

async function writeManifest(file, entries) {
  const contents = [...entries.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(entry => JSON.stringify(entry)).join('\n') + '\n';
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents, {encoding: 'utf8'});
  await fs.rename(temporary, file);
}

async function readManifest(file) {
  const entries = new Map();
  try {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (!entry.id || entries.has(entry.id)) throw new Error(`Duplicate or missing image ID in ${file}.`);
      entries.set(entry.id, entry);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return entries;
}

async function writeRendition(file, bytes, prior, sourcePath) {
  const digest = sha256(bytes);
  if (prior && prior.sha256 !== digest) {
    throw new Error(`Generated output changed at an immutable path: ${sourcePath} -> ${file}. Use a new rendition version.`);
  }
  let existingDigest = '';
  try { existingDigest = sha256(await fs.readFile(file)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existingDigest && existingDigest !== digest && !prior) {
    throw new Error(`Untracked output already exists and differs: ${file}. Inspect it or use a new rendition version.`);
  }
  if (existingDigest !== digest) {
    await fs.mkdir(path.dirname(file), {recursive: true});
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, bytes, {flag: 'w'});
    await fs.rename(temporary, file);
  }
  return {sha256: digest, bytes: bytes.length, status: 'verified'};
}

async function oldThumbnailBytes(folder) {
  const files = [];
  for (const entry of await fs.readdir(folder, {withFileTypes: true})) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.jpg')) files.push(path.join(folder, entry.name));
  }
  if (files.length !== EXPECTED_PHOTOS) throw new Error(`Expected ${EXPECTED_PHOTOS} existing JPEG thumbnails; found ${files.length}.`);
  let total = 0;
  for (const file of files) total += (await fs.stat(file)).size;
  return total;
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/generate_gallery_renditions.cjs --shopping-root <Japan shopping folder>');
    return;
  }
  if (!args.shoppingRoot) throw new Error('Pass --shopping-root with the Japan shopping folder.');
  const shoppingRoot = path.resolve(args.shoppingRoot);
  const catalogRoot = path.join(shoppingRoot, 'Catalog');
  const manifestPath = path.join(catalogRoot, `${VERSION}-manifest.jsonl`);
  const moveManifest = path.join(catalogRoot, 'move-manifest.csv');
  const rows = parseCsv(await fs.readFile(moveManifest, 'utf8'));
  if (rows.length !== EXPECTED_PHOTOS) throw new Error(`Expected ${EXPECTED_PHOTOS} source records; found ${rows.length}.`);
  if (new Set(rows.map(row => row.image_id)).size !== EXPECTED_PHOTOS) throw new Error('Source manifest contains duplicate image IDs.');
  if (rows.some(row => !row.image_id || !row.current_path || !/^[a-f0-9]{64}$/i.test(row.sha256))) throw new Error('Source manifest has a missing path, image ID, or SHA-256.');

  const baselineThumbBytes = await oldThumbnailBytes(path.join(catalogRoot, 'thumbnails'));
  const entries = await readManifest(manifestPath);
  const outputRoot = path.join(catalogRoot, VERSION);
  sharp.concurrency(2);
  let completed = 0;
  let webpThumbBytes = 0;
  let jpegThumbBytes = 0;
  let displayWebpBytes = 0;
  let displayJpegBytes = 0;

  for (const row of rows) {
    const sourcePath = row.current_path.replace(/\\/g, '/');
    const sourceFile = path.join(shoppingRoot, sourcePath);
    const sourceBytes = await fs.readFile(sourceFile);
    const sourceSha256 = sha256(sourceBytes);
    if (sourceSha256 !== row.sha256.toLowerCase()) throw new Error(`Original SHA-256 differs from the catalog move manifest: ${sourcePath}`);
    const previous = entries.get(row.image_id);
    if (previous && (previous.sourcePath !== sourcePath || previous.sourceSha256 !== sourceSha256)) {
      throw new Error(`Source changed since this rendition manifest was created: ${sourcePath}`);
    }

    const thumbBase = sharp(sourceBytes, {limitInputPixels: 48_000_000}).rotate()
      .resize({width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true});
    const thumbJpeg = await thumbBase.clone().flatten({background: '#ffffff'}).jpeg({quality: 82, mozjpeg: true}).toBuffer();
    const thumbWebp = await thumbBase.clone().webp({quality: 78, effort: 4}).toBuffer();
    const displayBase = sharp(sourceBytes, {limitInputPixels: 48_000_000}).rotate()
      .resize({width: DISPLAY_EDGE, height: DISPLAY_EDGE, fit: 'inside', withoutEnlargement: true});
    const displayJpeg = await displayBase.clone().flatten({background: '#ffffff'}).jpeg({quality: 82, mozjpeg: true}).toBuffer();
    const displayWebp = await displayBase.clone().webp({quality: 80, effort: 4}).toBuffer();

    const outputs = {};
    for (const [relative, bytes] of [
      [`${VERSION}/thumbnails/${row.image_id}.jpg`, thumbJpeg],
      [`${VERSION}/thumbnails/${row.image_id}.webp`, thumbWebp],
      [`${VERSION}/display/${row.image_id}.jpg`, displayJpeg],
      [`${VERSION}/display/${row.image_id}.webp`, displayWebp],
    ]) {
      outputs[relative] = await writeRendition(
        path.join(outputRoot, relative.slice(`${VERSION}/`.length)), bytes,
        previous?.outputs?.[relative], sourcePath,
      );
    }
    entries.set(row.image_id, {
      id: row.image_id,
      sourcePath,
      sourceSha256,
      status: 'verified',
      generator: `sharp-${sharp.versions.sharp}`,
      parameters: {thumbnailEdge: THUMB_EDGE, thumbnailWebpQuality: 78, jpegQuality: 82, displayEdge: DISPLAY_EDGE, displayWebpQuality: 80},
      outputs,
      verifiedAt: new Date().toISOString(),
    });
    await writeManifest(manifestPath, entries);
    webpThumbBytes += thumbWebp.length;
    jpegThumbBytes += thumbJpeg.length;
    displayWebpBytes += displayWebp.length;
    displayJpegBytes += displayJpeg.length;
    completed++;
    if (completed % 50 === 0 || completed === EXPECTED_PHOTOS) console.log(`${completed}/${EXPECTED_PHOTOS} images generated and hash-verified.`);
  }

  const reduction = 1 - webpThumbBytes / baselineThumbBytes;
  const mib = bytes => Number((bytes / 1048576).toFixed(2));
  const summary = {
    photos: completed,
    baselineJpegThumbnailMiB: mib(baselineThumbBytes),
    newJpegThumbnailMiB: mib(jpegThumbBytes),
    newWebpThumbnailMiB: mib(webpThumbBytes),
    webpThumbnailReductionPercent: Number((reduction * 100).toFixed(1)),
    jpegDetailMiB: mib(displayJpegBytes),
    webpDetailMiB: mib(displayWebpBytes),
    manifest: manifestPath,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (reduction < 0.30) throw new Error('WebP thumbnails do not meet the 30% aggregate savings target; do not publish this rendition set.');
}

main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
