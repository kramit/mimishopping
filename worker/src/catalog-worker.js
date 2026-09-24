const {app} = require('@azure/functions');
const {DefaultAzureCredential} = require('@azure/identity');
const {TableClient} = require('@azure/data-tables');
const {BlobServiceClient} = require('@azure/storage-blob');
const sharp = require('sharp');
const {CATEGORIES} = require('./catalog-schema');
const {createHash} = require('node:crypto');

const PARTITION = 'catalog';
const MAX_JSON_BYTES = 60 * 1024;
const credential = new DefaultAzureCredential();
let tableClient;
let blobService;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

function getTable() {
  if (!tableClient) tableClient = new TableClient(required('CATALOG_TABLE_ENDPOINT'), process.env.CATALOG_TABLE_NAME || 'CatalogItems', credential);
  return tableClient;
}

function getBlobService() {
  if (!blobService) blobService = new BlobServiceClient(required('CATALOG_BLOB_ENDPOINT'), credential);
  return blobService;
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function text(value, max = 1800) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function array(value, max = 20) { return Array.isArray(value) ? value.slice(0, max) : []; }
function uniqueTags(values) {
  const seen = new Set();
  return array(values, 40).map(x => text(x, 64).replace(/\s+/g, ' ')).filter(x => {
    const key = x.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key); return true;
  });
}
function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : ''; }
  catch { return ''; }
}
function sourceList(values, type = 'source') {
  return array(values, type === 'review' ? 4 : 6).map(item => ({
    title: text(item?.title || item?.name, 180), url: safeUrl(item?.url),
    ...(type === 'source' ? {purpose: text(item?.purpose, 240)} : {})
  })).filter(item => item.title && item.url);
}

function normalizeWebResearch(input, today) {
  const status = ['matched', 'partial', 'pending', 'unmatched'].includes(input?.status) ? input.status : 'unmatched';
  const range = input?.priceRange || {};
  const reviews = input?.reviewSummary || {};
  return {
    status, statusNote: text(input?.statusNote), checkedDate: text(input?.checkedDate, 20) || today,
    productSummary: text(input?.productSummary), observedPrice: text(input?.observedPrice, 500),
    priceRange: text(range.min, 40) || text(range.max, 40) ? {min: text(range.min, 40), max: text(range.max, 40), currency: text(range.currency, 20), basis: text(range.basis, 180)} : null,
    stores: array(input?.stores, 6).map(store => ({name: text(store?.name, 160), url: safeUrl(store?.url), observedPrice: text(store?.observedPrice, 240)})).filter(store => store.name && store.url),
    reviewSummary: {
      rating: text(reviews.rating, 40) || 'unavailable',
      count: text(reviews.count, 20), summary: text(reviews.summary),
      sources: sourceList(reviews.sources, 'review')
    },
    translations: array(input?.translations, 12).map(entry => ({text: text(entry?.text, 500), english: text(entry?.english, 500)})).filter(entry => entry.text && entry.english),
    sources: sourceList(input?.sources)
  };
}

function normalizeAgentResult(raw, {id, filename, now = new Date()} = {}) {
  const today = now.toISOString().slice(0, 10);
  const confidence = ['high', 'medium', 'low'].includes(raw?.confidence) ? raw.confidence : 'low';
  const products = array(raw?.products, 8).map(product => ({
    brand: text(product?.brand, 120), name: text(product?.name, 220) || 'Unidentified product',
    variant: text(product?.variant, 180), description: text(product?.description),
    identifiedBy: 'Foundry mimishopping (gpt-6-astra)',
    matchConfidence: ['confirmed', 'probable', 'uncertain'].includes(product?.matchConfidence) ? product.matchConfidence : 'uncertain',
    webResearch: normalizeWebResearch(product?.webResearch, today)
  }));
  const category = CATEGORIES.includes(raw?.category) ? raw.category : 'Needs review';
  const japaneseText = array(raw?.japaneseText, 40).map(entry => ({text: text(entry?.text, 500), translation: text(entry?.translation, 500)})).filter(entry => entry.text && entry.translation);
  const date = now.toISOString();
  const record = {
    id, filename, year: String(now.getUTCFullYear()), capturedDate: date.slice(0, 10), trip: 'Community contributions',
    category, tags: uniqueTags(raw?.tags), searchTerms: uniqueTags([category, ...products.flatMap(p => [p.brand, p.name, p.variant]), ...japaneseText.flatMap(x => [x.text, x.translation])]),
    products, japaneseText, description: text(raw?.description) || 'Community-submitted product photo.',
    confidence, evidence: text(raw?.evidence), notes: text(raw?.notes),
    reviewStatus: confidence === 'low' || products.length === 0 ? 'needs human review' : confidence === 'medium' ? 'needs closer inspection' : 'cataloged',
    image: `Contributions/photos/${id}.jpg`, download: `Contributions/photos/${id}.jpg`, downloadFilename: `${id}.jpg`,
    thumb: `Contributions/optimized-v1/thumbnails/${id}.jpg`, thumbWebp: `Contributions/optimized-v1/thumbnails/${id}.webp`,
    display: `Contributions/optimized-v1/display/${id}.jpg`, displayWebp: `Contributions/optimized-v1/display/${id}.webp`, isContribution: true
  };
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_JSON_BYTES) throw new Error('Structured product research exceeded the catalog record size limit.');
  return record;
}

function responseText(body) {
  if (typeof body?.output_text === 'string' && body.output_text) return body.output_text;
  for (const item of body?.output || []) {
    if (item.type !== 'message') continue;
    for (const content of item.content || []) if (content.type === 'output_text' && content.text) return content.text;
  }
  throw new Error('Foundry returned no structured catalog result.');
}

async function identifyImage(buffer, filename, context) {
  const endpoint = required('FOUNDRY_PROJECT_ENDPOINT').replace(/\/+$/, '');
  const agentName = process.env.FOUNDRY_AGENT_NAME || 'mimishopping';
  const url = `${endpoint}/agents/${encodeURIComponent(agentName)}/endpoint/protocols/openai/responses?api-version=v1`;
  const analysis = await sharp(buffer, {limitInputPixels: 48_000_000}).rotate().resize({width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true}).jpeg({quality: 84}).toBuffer();
  const token = await credential.getToken('https://ai.azure.com/.default');
  if (!token?.token) throw new Error('Could not authenticate to the Foundry agent.');
  const response = await fetch(url, {
    method: 'POST',
    headers: {'authorization': `Bearer ${token.token}`, 'content-type': 'application/json'},
    body: JSON.stringify({
      input: [{role: 'user', content: [
        {type: 'input_text', text: `Identify and research the prominent product(s) in this store photo. The submitted filename is ${JSON.stringify(filename)}. Use the provided image, perform current web search, translate readable Japanese, and follow your product-catalog instructions. Do not interpret the filename as evidence.`},
        {type: 'input_image', image_url: `data:image/jpeg;base64,${analysis.toString('base64')}`}
      ]}]
    })
  });
  if (!response.ok) {
    context.warn('Foundry request failed.', response.status);
    throw new Error(`Foundry request failed with HTTP ${response.status}.`);
  }
  const body = await response.json();
  return JSON.parse(responseText(body));
}

async function normalizeImages(source) {
  const pipeline = sharp(source, {limitInputPixels: 48_000_000}).rotate();
  const metadata = await pipeline.metadata();
  const publicJpeg = await sharp(source, {limitInputPixels: 48_000_000}).rotate()
    .resize({width: 2600, height: 2600, fit: 'inside', withoutEnlargement: true})
    .jpeg({quality: 88, mozjpeg: true}).toBuffer();
  const preview = await sharp(publicJpeg).resize({width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true}).jpeg({quality: 82}).toBuffer();
  const thumbBase = sharp(publicJpeg).resize({width: 480, height: 480, fit: 'inside', withoutEnlargement: true});
  const thumbnail = await thumbBase.clone().jpeg({quality: 82, mozjpeg: true}).toBuffer();
  const thumbnailWebp = await thumbBase.clone().webp({quality: 78, effort: 4}).toBuffer();
  const displayBase = sharp(publicJpeg).resize({width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true});
  const display = await displayBase.clone().jpeg({quality: 82, mozjpeg: true}).toBuffer();
  const displayWebp = await displayBase.clone().webp({quality: 80, effort: 4}).toBuffer();
  return {metadata, publicJpeg, preview, thumbnail, thumbnailWebp, display, displayWebp,
    publicSha256: sha256(publicJpeg), thumbSha256: sha256(thumbnail), thumbWebpSha256: sha256(thumbnailWebp),
    displaySha256: sha256(display), displayWebpSha256: sha256(displayWebp)};
}

function itemId(queueItem) {
  const value = typeof queueItem === 'string' ? JSON.parse(queueItem) : queueItem;
  if (!value || !['process', 'publish', 'remove'].includes(value.type) || !/^[a-f0-9]{64}$/i.test(value.id || '') || (value.attemptId !== undefined && !/^[a-f0-9]{32}$/i.test(value.attemptId))) throw new Error('Invalid catalog queue message.');
  return {type: value.type, id: value.id.toLowerCase(), ...(value.attemptId ? {attemptId: value.attemptId.toLowerCase()} : {})};
}

async function updateEntity(table, id, changes) {
  await table.updateEntity({partitionKey: PARTITION, rowKey: id, ...changes}, 'Merge', {etag: '*'});
}

async function processImage(id, context, deps = {}, attemptId = '') {
  const table = deps.table || getTable();
  const inbox = (deps.blobService || getBlobService()).getContainerClient(process.env.CATALOG_INTAKE_CONTAINER || 'contribution-inbox');
  const item = await table.getEntity(PARTITION, id);
  if (item.activeAttemptId ? item.activeAttemptId !== attemptId : Boolean(attemptId)) return;
  if (['ready', 'publishing', 'published', 'hidden'].includes(item.status)) return;
  if (item.expiresAt && item.expiresAt <= new Date().toISOString()) return;
  const filename = text(item.filename, 120) || 'phone-photo';
  try {
    await updateEntity(table, id, {status: 'processing', updatedAt: new Date().toISOString(), lastError: ''});
    const source = await inbox.getBlobClient(item.sourceBlob).downloadToBuffer();
    const outputs = await (deps.normalizeImages || normalizeImages)(source);
    const result = await (deps.identifyImage || identifyImage)(source, filename, context);
    const record = normalizeAgentResult(result, {id, filename});
    const previewBlob = `${id}/preview.jpg`;
    const safeBlob = `${id}/publish.jpg`;
    const thumbBlob = `${id}/thumb.jpg`;
    const thumbWebpBlob = `${id}/thumb.webp`;
    const displayBlob = `${id}/display.jpg`;
    const displayWebpBlob = `${id}/display.webp`;
    const privateOptions = {blobHTTPHeaders: {blobContentType: 'image/jpeg', blobCacheControl: 'no-store'}};
    await inbox.getBlockBlobClient(previewBlob).uploadData(outputs.preview, {...privateOptions, metadata: {sha256: sha256(outputs.preview)}});
    await inbox.getBlockBlobClient(safeBlob).uploadData(outputs.publicJpeg, {...privateOptions, metadata: {sha256: outputs.publicSha256}});
    await inbox.getBlockBlobClient(thumbBlob).uploadData(outputs.thumbnail, {...privateOptions, metadata: {sha256: outputs.thumbSha256}});
    await inbox.getBlockBlobClient(thumbWebpBlob).uploadData(outputs.thumbnailWebp, {blobHTTPHeaders: {...privateOptions.blobHTTPHeaders, blobContentType: 'image/webp'}, metadata: {sha256: outputs.thumbWebpSha256}});
    await inbox.getBlockBlobClient(displayBlob).uploadData(outputs.display, {...privateOptions, metadata: {sha256: outputs.displaySha256}});
    await inbox.getBlockBlobClient(displayWebpBlob).uploadData(outputs.displayWebp, {blobHTTPHeaders: {...privateOptions.blobHTTPHeaders, blobContentType: 'image/webp'}, metadata: {sha256: outputs.displayWebpSha256}});
    await updateEntity(table, id, {status: 'ready', catalogJson: JSON.stringify(record), previewBlob, publicBlob: safeBlob,
      thumbnailBlob: thumbBlob, thumbnailWebpBlob: thumbWebpBlob, displayBlob, displayWebpBlob,
      publicSha256: outputs.publicSha256, thumbnailSha256: outputs.thumbSha256, thumbnailWebpSha256: outputs.thumbWebpSha256,
      displaySha256: outputs.displaySha256, displayWebpSha256: outputs.displayWebpSha256,
      imageWidth: outputs.metadata.width || 0, imageHeight: outputs.metadata.height || 0,
      updatedAt: new Date().toISOString(), lastError: ''});
  } catch (error) {
    await updateEntity(table, id, {status: 'queued', updatedAt: new Date().toISOString(), lastError: text(error.message, 500)}).catch(() => {});
    throw error;
  }
}

async function publishImage(id, context, deps = {}, attemptId = '') {
  const table = deps.table || getTable();
  const blob = deps.blobService || getBlobService();
  const inbox = blob.getContainerClient(process.env.CATALOG_INTAKE_CONTAINER || 'contribution-inbox');
  const publicContainer = blob.getContainerClient(process.env.CATALOG_PUBLIC_CONTAINER || 'contributions');
  const item = await table.getEntity(PARTITION, id);
  if (item.activeAttemptId ? item.activeAttemptId !== attemptId : Boolean(attemptId)) return;
  if (item.status === 'published' || item.status === 'hidden') return;
  if (item.status !== 'publishing') throw new Error('Contribution is not awaiting publication.');
  const record = JSON.parse(item.catalogJson || '{}');
  const photoName = `photos/${id}.jpg`;
  const thumbName = `optimized-v1/thumbnails/${id}.jpg`;
  const thumbWebpName = `optimized-v1/thumbnails/${id}.webp`;
  const displayName = `optimized-v1/display/${id}.jpg`;
  const displayWebpName = `optimized-v1/display/${id}.webp`;
  const publicBlob = publicContainer.getBlockBlobClient(photoName);
  const thumbBlob = publicContainer.getBlockBlobClient(thumbName);
  const thumbWebpBlob = publicContainer.getBlockBlobClient(thumbWebpName);
  const displayBlob = publicContainer.getBlockBlobClient(displayName);
  const displayWebpBlob = publicContainer.getBlockBlobClient(displayWebpName);
  try {
    const source = await inbox.getBlobClient(item.publicBlob).downloadToBuffer();
    const thumbnail = await inbox.getBlobClient(item.thumbnailBlob).downloadToBuffer();
    const outputs = [
      [thumbBlob, item.thumbnailBlob, item.thumbnailSha256, 'image/jpeg', 'thumb'],
      [thumbWebpBlob, item.thumbnailWebpBlob, item.thumbnailWebpSha256, 'image/webp', 'thumb webp'],
      [displayBlob, item.displayBlob, item.displaySha256, 'image/jpeg', 'display'],
      [displayWebpBlob, item.displayWebpBlob, item.displayWebpSha256, 'image/webp', 'display webp'],
    ];
    await publicBlob.uploadData(source, {blobHTTPHeaders: {blobContentType: 'image/jpeg', blobContentDisposition: `attachment; filename="${id}.jpg"`, blobCacheControl: 'public, max-age=31536000, immutable'}, metadata: {sha256: item.publicSha256}});
    for (const [target, privateName, digest, mime] of outputs) {
      const bytes = await inbox.getBlobClient(privateName).downloadToBuffer();
      await target.uploadData(bytes, {blobHTTPHeaders: {blobContentType: mime, blobCacheControl: 'public, max-age=31536000, immutable'}, metadata: {sha256: digest}});
    }
    const all = [publicBlob, ...outputs.map(([target]) => target)];
    const props = await Promise.all(all.map(target => target.getProperties()));
    const buffers = await Promise.all(all.map(target => target.downloadToBuffer()));
    const expectedHashes = [item.publicSha256, ...outputs.map(([, , digest]) => digest)];
    if (props.some((value, index) => value.metadata?.sha256 !== expectedHashes[index])) throw new Error('Published image verification failed.');
    if (buffers.some((value, index) => sha256(value) !== expectedHashes[index])) throw new Error('Published image content hash verification failed.');
    record.image = `Contributions/${photoName}`;
    record.download = `Contributions/${photoName}`;
    record.downloadFilename = `${id}.jpg`;
    record.thumb = `Contributions/${thumbName}`;
    record.thumbWebp = `Contributions/${thumbWebpName}`;
    record.display = `Contributions/${displayName}`;
    record.displayWebp = `Contributions/${displayWebpName}`;
    await updateEntity(table, id, {status: 'published', catalogJson: JSON.stringify(record), publishedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), draftTokenHash: '', activeAttemptId: ''});
    await deletePrivateBlobs(inbox, id);
  } catch (error) {
    await updateEntity(table, id, {status: 'publishing', updatedAt: new Date().toISOString(), lastError: text(error.message, 500)}).catch(() => {});
    context.warn('Contribution publication will be retried.', id, error.code || error.name || 'unclassified');
    throw error;
  }
}

async function deletePrivateBlobs(container, id) {
  const names = [`${id}/source.jpg`, `${id}/source.png`, `${id}/source.webp`, `${id}/source.heic`, `${id}/source.avif`, `${id}/preview.jpg`, `${id}/publish.jpg`, `${id}/thumb.jpg`, `${id}/thumb.webp`, `${id}/display.jpg`, `${id}/display.webp`];
  await Promise.all(names.map(name => container.deleteBlob(name).catch(error => { if (error.statusCode !== 404) throw error; })));
}

async function removePublishedImage(id, deps = {}) {
  const table = deps.table || getTable();
  const blob = deps.blobService || getBlobService();
  const publicContainer = blob.getContainerClient(process.env.CATALOG_PUBLIC_CONTAINER || 'contributions');
  const item = await table.getEntity(PARTITION, id);
  await Promise.all([
    publicContainer.deleteBlob(`photos/${id}.jpg`).catch(error => { if (error.statusCode !== 404) throw error; }),
    ...[`thumbnails/${id}.jpg`, `optimized-v1/thumbnails/${id}.jpg`, `optimized-v1/thumbnails/${id}.webp`, `optimized-v1/display/${id}.jpg`, `optimized-v1/display/${id}.webp`].map(name => publicContainer.deleteBlob(name).catch(error => { if (error.statusCode !== 404) throw error; }))
  ]);
  await deletePrivateBlobs(blob.getContainerClient(process.env.CATALOG_INTAKE_CONTAINER || 'contribution-inbox'), id);
  if (item.status !== 'hidden') await updateEntity(table, id, {status: 'hidden', updatedAt: new Date().toISOString()});
}

async function expireDrafts(context, deps = {}) {
  const table = deps.table || getTable();
  const blob = deps.blobService || getBlobService();
  const now = new Date().toISOString();
  const inbox = blob.getContainerClient(process.env.CATALOG_INTAKE_CONTAINER || 'contribution-inbox');
  for await (const item of table.listEntities({queryOptions: {filter: `expiresAt lt '${now}'`}})) {
    if (item.partitionKey !== PARTITION) continue;
    if (item.status === 'published') continue;
    if (item.status === 'hidden') await removePublishedImage(item.rowKey, {table, blobService: blob});
    else await deletePrivateBlobs(inbox, item.rowKey);
    await table.deleteEntity(PARTITION, item.rowKey, {etag: '*'}).catch(error => { if (error.statusCode !== 404) throw error; });
    context.log('Expired a private catalog draft.', item.rowKey);
  }
}

async function handleCatalogQueue(queueItem, context, deps = {}) {
  const job = itemId(queueItem);
  if (job.type === 'process') return processImage(job.id, context, deps, job.attemptId);
  if (job.type === 'publish') return publishImage(job.id, context, deps, job.attemptId);
  return removePublishedImage(job.id, deps);
}

async function handlePoisonQueue(queueItem, context, deps = {}) {
  let job;
  try { job = typeof queueItem === 'string' ? JSON.parse(queueItem) : queueItem; }
  catch { context.error('Ignoring an invalid catalog poison message.'); return; }
  if (!job || !['process', 'publish'].includes(job.type) || !/^[a-f0-9]{64}$/i.test(job.id || '') || (job.attemptId !== undefined && !/^[a-f0-9]{32}$/i.test(job.attemptId))) return;
  const table = deps.table || getTable();
  try {
    const item = await table.getEntity(PARTITION, job.id.toLowerCase());
    const attemptId = job.attemptId?.toLowerCase() || '';
    if (item.activeAttemptId ? item.activeAttemptId !== attemptId : Boolean(attemptId)) return;
    if (job.type === 'process' && !['queued', 'processing'].includes(item.status)) return;
    if (job.type === 'publish' && item.status !== 'publishing') return;
    await updateEntity(table, item.rowKey, {status: 'failed', retryAction: job.type === 'publish' ? 'publish' : 'process', updatedAt: new Date().toISOString(), lastError: 'Processing stopped after repeated attempts. Retry this upload.'});
  } catch (error) { context.error('Could not record a failed catalog queue item.', error.code || error.statusCode || 'unclassified'); }
}

app.storageQueue('processCatalogContribution', {
  queueName: process.env.CATALOG_QUEUE_NAME || 'catalog-intake',
  connection: 'CatalogQueue',
  handler: handleCatalogQueue
});

app.storageQueue('markPoisonCatalogContribution', {
  queueName: `${process.env.CATALOG_QUEUE_NAME || 'catalog-intake'}-poison`,
  connection: 'CatalogQueue',
  handler: handlePoisonQueue
});

app.timer('expireCatalogDrafts', {
  schedule: '0 15 3 * * *',
  handler: async (_timer, context) => expireDrafts(context)
});

module.exports = {normalizeAgentResult, normalizeWebResearch, responseText, itemId, safeUrl, handleCatalogQueue, handlePoisonQueue, processImage, publishImage, expireDrafts, identifyImage, normalizeImages};
