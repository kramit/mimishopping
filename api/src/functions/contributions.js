const {app} = require('@azure/functions');
const {createHash, randomBytes, timingSafeEqual} = require('node:crypto');
const {normalizeTags, isCatalogEditor, IMAGE_ID} = require('../lib/validation');
const {CATEGORIES} = require('../lib/catalog-schema');
const {getCatalogTableClient, getInboxContainerClient, getIntakeQueueClient} = require('../lib/contribution-storage');

const PARTITION = 'catalog';
const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
const DRAFT_DAYS = 30;

function json(status, body, cacheControl = 'no-store') {
  return {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': cacheControl}, jsonBody: body};
}

function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function addDays(date, days) { const value = new Date(date); value.setUTCDate(value.getUTCDate() + days); return value.toISOString(); }
function statusCode(error) { return error?.statusCode || error?.status || 0; }
function missingEntity(error) { return statusCode(error) === 404 || error?.code === 'ResourceNotFound'; }
function existsEntity(error) { return statusCode(error) === 409 || error?.code === 'EntityAlreadyExists'; }

function safeFilename(value) {
  let name = String(value || 'phone-photo').slice(0, 180);
  try { name = decodeURIComponent(name); } catch {}
  name = name.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 120) || 'phone-photo';
}

function imageFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return {mime: 'image/jpeg', extension: 'jpg'};
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {mime: 'image/png', extension: 'png'};
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return {mime: 'image/webp', extension: 'webp'};
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (['heic','heix','hevc','hevx','mif1','msf1'].includes(brand)) return {mime: 'image/heic', extension: 'heic'};
    if (brand === 'avif' || brand === 'avis') return {mime: 'image/avif', extension: 'avif'};
  }
  return null;
}

function imageIdFrom(request) {
  const value = request.params?.id || '';
  return IMAGE_ID.test(value) ? value.toLowerCase() : null;
}

function draftToken(request) {
  const value = request.headers.get('x-catalog-draft-token') || '';
  return /^[a-f0-9]{64}$/i.test(value) ? value : '';
}

function tokenMatches(item, token) {
  if (!token || !item?.draftTokenHash) return false;
  const expected = Buffer.from(item.draftTokenHash, 'hex');
  const actual = Buffer.from(digest(token), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function getEntity(table, id) {
  try { return await table.getEntity(PARTITION, id); }
  catch (error) { if (missingEntity(error)) return null; throw error; }
}

function privateImageResponse(buffer) {
  return {status: 200, headers: {
    'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
  }, body: buffer};
}

async function sendJob(queue, message) {
  await queue.sendMessage(JSON.stringify(message));
}

function normalizeDisplayName(input) {
  if (typeof input !== 'string') throw new Error('Enter a contributor name to add this photo.');
  const value = input.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (!value) throw new Error('Enter a contributor name to add this photo.');
  if (value.length > 48) throw new Error('Contributor names must be 48 characters or fewer.');
  return value;
}

function normalizeSubmission(input, currentRecord, id) {
  if (!input || typeof input !== 'object') throw new Error('A contribution is required.');
  const name = normalizeDisplayName(input.uploaderName);
  const category = CATEGORIES.includes(input.category) ? input.category : 'Needs review';
  const proposedTags = normalizeTags(input.tags || []);
  const contributorTag = `Contributor: ${name}`;
  const tags = normalizeTags([...proposedTags.filter(tag => !/^contributor\s*:/i.test(tag)), contributorTag]);
  const record = {...currentRecord, id, category, tags, uploadedBy: name, isContribution: true,
    trip: 'Community contributions', reviewStatus: currentRecord.confidence === 'low' ? 'needs human review' : 'cataloged',
    image: `Contributions/photos/${id}.jpg`, thumb: `Contributions/thumbnails/${id}.jpg`};
  return {record, uploaderName: name};
}

async function createIntake(request, context, deps = {}) {
  const table = deps.table || getCatalogTableClient();
  const inbox = deps.inbox || getInboxContainerClient();
  const queue = deps.queue || getIntakeQueueClient();
  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_UPLOAD_BYTES) return json(413, {error: 'Choose a photo smaller than 24 MB.'});

  let bytes;
  try { bytes = Buffer.from(await request.arrayBuffer()); }
  catch { return json(400, {error: 'The photo upload could not be read.'}); }
  if (!bytes.length) return json(400, {error: 'Choose a photo first.'});
  if (bytes.length > MAX_UPLOAD_BYTES) return json(413, {error: 'Choose a photo smaller than 24 MB.'});
  const format = imageFormat(bytes);
  if (!format) return json(415, {error: 'Use a JPEG, PNG, WebP, HEIC, or AVIF photo.'});

  const id = digest(bytes);
  const suppliedToken = draftToken(request);
  let token = suppliedToken || randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  let existing;
  try { existing = await getEntity(table, id); }
  catch (error) { context.error('Catalog intake lookup failed.', error.code || statusCode(error) || 'unclassified'); return json(503, {error: 'Photo processing is temporarily unavailable.'}); }

  if (existing?.status === 'published') return json(200, {id, status: 'published', duplicate: true});
  let restartingExpired = false;
  if (existing && existing.expiresAt && existing.expiresAt <= now) {
    existing = {...existing, status: 'receiving', filename: safeFilename(request.headers.get('x-file-name')),
      sourceMime: format.mime, sourceExtension: format.extension, sourceBlob: `${id}/source.${format.extension}`,
      draftTokenHash: digest(token), createdAt: now, updatedAt: now, expiresAt: addDays(now, DRAFT_DAYS), lastError: ''};
    try { await table.updateEntity(existing, 'Replace', {etag: '*'}); }
    catch (error) {
      context.error('Expired catalog intake could not be restarted.', error.code || statusCode(error) || 'unclassified');
      return json(503, {error: 'Photo processing is temporarily unavailable.'});
    }
    restartingExpired = true;
  }
  if (existing) {
    // A content hash identifies duplicates, but is not an access credential. Never
    // grant access to a private draft unless the caller has its random bearer token.
    if (!restartingExpired && !tokenMatches(existing, suppliedToken)) {
      return json(409, {error: 'This exact photo already has a private upload. If it is yours, choose the same photo again to restore its session.'});
    }
    if (!restartingExpired && !['receiving', 'upload-failed', 'queue-failed', 'failed', 'queued', 'processing', 'ready', 'publishing'].includes(existing.status)) {
      return json(409, {error: 'This private upload is no longer available.'});
    }
    if (!restartingExpired) token = suppliedToken;
    if (restartingExpired || ['receiving', 'upload-failed'].includes(existing.status)) {
      try {
        await inbox.getBlockBlobClient(existing.sourceBlob).uploadData(bytes, {
          blobHTTPHeaders: {blobContentType: 'application/octet-stream', blobCacheControl: 'no-store'}, metadata: {sha256: id}
        });
      } catch (error) {
        await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'upload-failed', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'}).catch(() => {});
        context.error('Catalog intake source could not be restored.', error.code || statusCode(error) || 'unclassified');
        return json(503, {id, token, status: 'upload-failed', error: 'The photo was not fully received. Choose it again to retry.'});
      }
    }
    if (!restartingExpired && ['queued', 'processing', 'ready', 'publishing', 'failed'].includes(existing.status)) {
      return json(202, {id, token, status: existing.status, duplicate: true});
    }
    try {
      await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'queued', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'});
      await sendJob(queue, {type: 'process', id});
      return json(202, {id, token, status: 'queued', duplicate: true});
    } catch (error) {
      await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'queue-failed', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'}).catch(() => {});
      context.error('Catalog intake resume failed.', error.code || statusCode(error) || 'unclassified');
      return json(503, {id, token, status: 'queue-failed', error: 'The photo is stored privately but could not be queued. Choose Retry to continue.'});
    }
  }

  const filename = safeFilename(request.headers.get('x-file-name'));
  const item = {partitionKey: PARTITION, rowKey: id, sha256: id, status: 'receiving', filename,
    sourceMime: format.mime, sourceExtension: format.extension, sourceBlob: `${id}/source.${format.extension}`,
    draftTokenHash: digest(token), createdAt: now, updatedAt: now, expiresAt: addDays(now, DRAFT_DAYS)};
  try {
    await table.createEntity(item);
  } catch (error) {
    if (existsEntity(error)) return json(409, {error: 'This exact photo already has a private upload. Choose the same photo again to restore its session.'});
    context.error('Catalog intake record could not be created.', error.code || statusCode(error) || 'unclassified');
    return json(503, {error: 'Photo processing is temporarily unavailable.'});
  }

  try {
    const blob = inbox.getBlockBlobClient(item.sourceBlob);
    await blob.uploadData(bytes, {blobHTTPHeaders: {blobContentType: 'application/octet-stream', blobCacheControl: 'no-store'}, metadata: {sha256: id}});
  } catch (error) {
    await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'upload-failed', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'}).catch(() => {});
    context.error('Catalog intake source upload failed.', error.code || statusCode(error) || 'unclassified');
    return json(503, {id, token, status: 'upload-failed', error: 'The photo was not fully received. Choose it again to retry.'});
  }
  try {
    await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'queued', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'});
    await sendJob(queue, {type: 'process', id});
    return json(202, {id, token, status: 'queued', duplicate: false});
  } catch (error) {
    await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'queue-failed', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'}).catch(() => {});
    context.error('Catalog intake could not be queued.', error.code || statusCode(error) || 'unclassified');
    return json(503, {id, token, status: 'queue-failed', error: 'The photo is stored privately but could not be queued. Choose Retry to continue.'});
  }
}

async function getIntake(request, context, deps = {}) {
  const id = imageIdFrom(request);
  if (!id) return json(400, {error: 'Invalid upload ID.'});
  const table = deps.table || getCatalogTableClient();
  try {
    const item = await getEntity(table, id);
    if (!item || !tokenMatches(item, draftToken(request))) return json(404, {error: 'This private upload is unavailable.'});
    if (item.expiresAt <= new Date().toISOString()) return json(410, {error: 'This upload has expired. Upload the photo again to continue.'});
    let result = null;
    try { result = item.catalogJson ? JSON.parse(item.catalogJson) : null; } catch {}
    return json(200, {id, status: item.status, filename: item.filename, expiresAt: item.expiresAt, result, error: item.lastError || null});
  } catch (error) {
    context.error('Private catalog result could not be read.', error.code || statusCode(error) || 'unclassified');
    return json(503, {error: 'The private result is temporarily unavailable.'});
  }
}

async function getIntakePreview(request, context, deps = {}) {
  const id = imageIdFrom(request);
  if (!id) return json(400, {error: 'Invalid upload ID.'});
  const table = deps.table || getCatalogTableClient();
  const inbox = deps.inbox || getInboxContainerClient();
  try {
    const item = await getEntity(table, id);
    if (!item || !tokenMatches(item, draftToken(request))) return json(404, {error: 'This private upload is unavailable.'});
    if (!item.previewBlob) return json(404, {error: 'The preview is not ready yet.'});
    const downloaded = await inbox.getBlobClient(item.previewBlob).downloadToBuffer();
    return privateImageResponse(downloaded);
  } catch (error) {
    if (missingEntity(error)) return json(404, {error: 'The preview is not ready yet.'});
    context.error('Private image preview could not be read.', error.code || statusCode(error) || 'unclassified');
    return json(503, {error: 'The private preview is temporarily unavailable.'});
  }
}

async function retryIntake(request, context, deps = {}) {
  const id = imageIdFrom(request);
  if (!id) return json(400, {error: 'Invalid upload ID.'});
  const table = deps.table || getCatalogTableClient();
  const queue = deps.queue || getIntakeQueueClient();
  try {
    const item = await getEntity(table, id);
    if (!item || !tokenMatches(item, draftToken(request))) return json(404, {error: 'This private upload is unavailable.'});
    if (!['queue-failed', 'failed'].includes(item.status)) return json(409, {error: 'This upload is not ready to retry.'});
    const action = item.retryAction === 'publish' ? 'publish' : 'process';
    const retryStatus = action === 'publish' ? 'publishing' : 'queued';
    await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: retryStatus, retryAction: '', lastError: '', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'});
    try { await sendJob(queue, {type: action, id}); }
    catch (error) {
      await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'failed', retryAction: action, lastError: 'Retry could not be queued. Try again shortly.', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'}).catch(() => {});
      throw error;
    }
    return json(202, {id, status: action === 'publish' ? 'publishing' : 'queued'});
  } catch (error) {
    context.error('Catalog intake retry failed.', error.code || statusCode(error) || 'unclassified');
    return json(503, {error: 'Retry could not be queued. Try again shortly.'});
  }
}

async function publishIntake(request, context, deps = {}) {
  const id = imageIdFrom(request);
  if (!id) return json(400, {error: 'Invalid upload ID.'});
  const table = deps.table || getCatalogTableClient();
  const queue = deps.queue || getIntakeQueueClient();
  let body;
  try { body = await request.json(); } catch { return json(400, {error: 'Enter a contributor name and review the tags.'}); }
  try {
    const item = await getEntity(table, id);
    if (!item || !tokenMatches(item, draftToken(request))) return json(404, {error: 'This private upload is unavailable.'});
    if (item.status === 'published') return json(200, {id, status: 'published', duplicate: true});
    if (item.status !== 'ready' && item.status !== 'publishing') return json(409, {error: 'Wait until the complete result is ready before adding it.'});
    const currentRecord = JSON.parse(item.catalogJson || '{}');
    const {record, uploaderName} = normalizeSubmission(body, currentRecord, id);
    await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'publishing', catalogJson: JSON.stringify(record), uploaderName, updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'});
    try { await sendJob(queue, {type: 'publish', id}); }
    catch (error) {
      await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'failed', retryAction: 'publish', lastError: 'Publication could not be queued. Choose Retry to continue.', updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'}).catch(() => {});
      throw error;
    }
    return json(202, {id, status: 'publishing'});
  } catch (error) {
    if (error instanceof SyntaxError) return json(503, {error: 'The catalog result is invalid. Retry analysis before publishing.'});
    if (error.message?.startsWith('Enter a contributor') || error.message?.startsWith('Contributor names')) return json(400, {error: error.message});
    if (error.message?.startsWith('Tags')) return json(400, {error: error.message});
    context.error('Catalog contribution could not be submitted.', error.code || statusCode(error) || 'unclassified');
    return json(503, {error: 'The contribution could not be queued. Try again shortly.'});
  }
}

async function getCatalogItems(_request, context, deps = {}) {
  const table = deps.table || getCatalogTableClient();
  try {
    const images = [];
    for await (const entity of table.listEntities({queryOptions: {filter: "status eq 'published'"}})) {
      if (entity.status !== 'published' || !entity.catalogJson) continue;
      try { images.push(JSON.parse(entity.catalogJson)); }
      catch { context.error('Skipping a malformed published catalog row.', entity.rowKey); }
    }
    return json(200, {images}, 'no-store');
  } catch (error) {
    context.error('Published contributions could not be read.', error.code || statusCode(error) || 'unclassified');
    return json(503, {error: 'New contributions are temporarily unavailable.'});
  }
}

async function hideCatalogItem(request, context, deps = {}) {
  if (!isCatalogEditor(request.headers.get('x-ms-client-principal'))) return json(403, {error: 'Editor access is required.'});
  const id = imageIdFrom(request);
  if (!id) return json(400, {error: 'Invalid catalog item ID.'});
  const table = deps.table || getCatalogTableClient();
  const queue = deps.queue || getIntakeQueueClient();
  try {
    const item = await getEntity(table, id);
    if (!item || item.status !== 'published') return json(404, {error: 'Published contribution not found.'});
    await sendJob(queue, {type: 'remove', id});
    await table.updateEntity({partitionKey: PARTITION, rowKey: id, status: 'hidden', hiddenAt: new Date().toISOString(), updatedAt: new Date().toISOString()}, 'Merge', {etag: '*'});
    return json(200, {id, status: 'hidden'});
  } catch (error) {
    context.error('Contribution could not be hidden.', error.code || statusCode(error) || 'unclassified');
    return json(503, {error: 'The contribution could not be hidden. Try again shortly.'});
  }
}

app.http('createCatalogIntake', {route: 'intakes', methods: ['POST'], authLevel: 'anonymous', handler: createIntake});
app.http('getCatalogIntake', {route: 'intakes/{id}', methods: ['GET'], authLevel: 'anonymous', handler: getIntake});
app.http('getCatalogIntakePreview', {route: 'intakes/{id}/preview', methods: ['GET'], authLevel: 'anonymous', handler: getIntakePreview});
app.http('retryCatalogIntake', {route: 'intakes/{id}/retry', methods: ['POST'], authLevel: 'anonymous', handler: retryIntake});
app.http('publishCatalogIntake', {route: 'intakes/{id}/publish', methods: ['POST'], authLevel: 'anonymous', handler: publishIntake});
app.http('getCatalogItems', {route: 'catalog-items', methods: ['GET'], authLevel: 'anonymous', handler: getCatalogItems});
app.http('hideCatalogItem', {route: 'catalog-items/{id}/hide', methods: ['POST'], authLevel: 'anonymous', handler: hideCatalogItem});

module.exports = {MAX_UPLOAD_BYTES, createIntake, getIntake, getIntakePreview, retryIntake, publishIntake, getCatalogItems, hideCatalogItem, imageFormat, normalizeDisplayName, normalizeSubmission, safeFilename, tokenMatches};
