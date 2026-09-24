const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const sharp = require('sharp');
const hostConfig = require('../host.json');
const {normalizeAgentResult, normalizeWebResearch, responseText, itemId, processImage, publishImage, expireDrafts, normalizeImages, handlePoisonQueue} = require('../src/catalog-worker');

function sha(value) { return createHash('sha256').update(value).digest('hex'); }
function makeTable(initial = []) {
  const rows = new Map(initial.map(row => [row.rowKey, structuredClone(row)]));
  return {rows,
    async getEntity(partitionKey, rowKey) {
      const row = rows.get(rowKey);
      if (!row || row.partitionKey !== partitionKey) { const error = new Error('missing'); error.statusCode = 404; throw error; }
      return structuredClone(row);
    },
    async updateEntity(row, _mode, _options) { rows.set(row.rowKey, {...rows.get(row.rowKey), ...structuredClone(row)}); },
    async deleteEntity(partitionKey, rowKey) { if (rows.get(rowKey)?.partitionKey === partitionKey) rows.delete(rowKey); },
    async *listEntities() { for (const row of rows.values()) yield structuredClone(row); }
  };
}
function makeBlobService(initial = {}) {
  const containers = new Map();
  class Container {
    constructor(items = {}) { this.blobs = new Map(Object.entries(items).map(([name, blob]) => [name, {bytes: Buffer.from(blob.bytes), metadata: blob.metadata || {}}])); }
    getBlobClient(name) {
      const container = this;
      return {async downloadToBuffer() { const blob = container.blobs.get(name); if (!blob) { const error = new Error('missing'); error.statusCode = 404; throw error; } return Buffer.from(blob.bytes); },
        async getProperties() { const blob = container.blobs.get(name); if (!blob) { const error = new Error('missing'); error.statusCode = 404; throw error; } return {metadata: {...blob.metadata}}; }};
    }
    getBlockBlobClient(name) {
      const container = this;
      return {async uploadData(bytes, options = {}) { container.blobs.set(name, {bytes: Buffer.from(bytes), metadata: {...(options.metadata || {})}}); },
        async downloadToBuffer() { const blob = container.blobs.get(name); if (!blob) { const error = new Error('missing'); error.statusCode = 404; throw error; } return Buffer.from(blob.bytes); },
        async getProperties() { const blob = container.blobs.get(name); if (!blob) { const error = new Error('missing'); error.statusCode = 404; throw error; } return {metadata: {...blob.metadata}}; }};
    }
    async deleteBlob(name) { if (!this.blobs.delete(name)) { const error = new Error('missing'); error.statusCode = 404; throw error; } }
  }
  for (const [name, blobs] of Object.entries(initial)) containers.set(name, new Container(blobs));
  return {containers, getContainerClient(name) { if (!containers.has(name)) containers.set(name, new Container()); return containers.get(name); }};
}
const context = {log() {}, warn() {}, error() {}};
const agent = {category: 'Facial skincare', description: 'A skincare product in store packaging.', tags: ['skincare'], confidence: 'high', evidence: 'Logo and label are clearly visible.', notes: '', japaneseText: [{text: '化粧水', translation: 'Lotion'}], products: [{brand: 'Example', name: 'Hydrating Lotion', variant: '150 ml', description: 'A hydrating toner.', matchConfidence: 'confirmed', webResearch: {status: 'matched', statusNote: '', checkedDate: '', productSummary: 'Manufacturer listing.', observedPrice: '¥1,200', priceRange: {min: '', max: '', currency: '', basis: ''}, stores: [], reviewSummary: {rating: 'unavailable', count: '', summary: '', sources: []}, translations: [], sources: [{title: 'Manufacturer', url: 'https://example.jp/product', purpose: 'Product identity'}]}}]};

test('research normalization rejects unsafe links and omits an empty price range', () => {
  const research = normalizeWebResearch({status: 'matched', priceRange: {}, sources: [{title: 'Bad', url: 'javascript:alert(1)'}, {title: 'Good', url: 'https://example.jp'}]}, '2026-09-24');
  assert.equal(research.priceRange, null);
  assert.deepEqual(research.sources, [{title: 'Good', url: 'https://example.jp/', purpose: ''}]);
});

test('structured result normalization keeps evidence, translations, tags, and current research', () => {
  const record = normalizeAgentResult(agent, {id: '1'.repeat(64), filename: 'store.jpg', now: new Date('2026-09-24T12:00:00Z')});
  assert.equal(record.category, 'Facial skincare');
  assert.deepEqual(record.japaneseText[0], {text: '化粧水', translation: 'Lotion'});
  assert.equal(record.products[0].webResearch.sources[0].url, 'https://example.jp/product');
  assert.equal(record.reviewStatus, 'cataloged');
});

test('Responses output parsing and queue message validation handle supported payloads', () => {
  assert.equal(responseText({output_text: '{"ok":true}'}), '{"ok":true}');
  assert.equal(responseText({output: [{type: 'message', content: [{type: 'output_text', text: 'result'}]}]}), 'result');
  assert.deepEqual(itemId(JSON.stringify({type: 'process', id: 'A'.repeat(64)})), {type: 'process', id: 'a'.repeat(64)});
  assert.throws(() => itemId({type: 'other', id: 'a'.repeat(64)}), /Invalid/);
});

test('Functions reads raw JSON messages sent by the Azure Queue SDK', () => {
  assert.equal(hostConfig.extensions.queues.messageEncoding, 'none');
  assert.deepEqual(itemId(JSON.stringify({type: 'process', id: 'a'.repeat(64)})), {type: 'process', id: 'a'.repeat(64)});
});

test('stale poison messages cannot fail a newer attempt or replace a ready result', async () => {
  const readyId = '5'.repeat(64), queuedId = '6'.repeat(64), attemptId = 'c'.repeat(32);
  const table = makeTable([
    {partitionKey: 'catalog', rowKey: readyId, status: 'ready', activeAttemptId: attemptId},
    {partitionKey: 'catalog', rowKey: queuedId, status: 'queued', activeAttemptId: attemptId}
  ]);
  await handlePoisonQueue(JSON.stringify({type: 'process', id: readyId, attemptId: 'a'.repeat(32)}), context, {table});
  await handlePoisonQueue(JSON.stringify({type: 'process', id: queuedId, attemptId: 'b'.repeat(32)}), context, {table});
  assert.equal(table.rows.get(readyId).status, 'ready');
  assert.equal(table.rows.get(queuedId).status, 'queued');
  await handlePoisonQueue(JSON.stringify({type: 'process', id: queuedId, attemptId}), context, {table});
  assert.equal(table.rows.get(queuedId).status, 'failed');
});

test('processing strips photo metadata and publication verifies actual blob hashes', async () => {
  const id = '2'.repeat(64);
  const source = await sharp({create: {width: 32, height: 24, channels: 3, background: '#aabbcc'}}).withMetadata({exif: {IFD0: {ImageDescription: 'private camera note'}}}).jpeg().toBuffer();
  const exifInput = await sharp(source).metadata();
  assert.ok(exifInput.exif, 'test source should contain EXIF');
  const table = makeTable([{partitionKey: 'catalog', rowKey: id, status: 'queued', filename: 'phone.jpg', sourceBlob: `${id}/source.jpg`, expiresAt: '2099-01-01T00:00:00.000Z'}]);
  const blobService = makeBlobService({'contribution-inbox': {[`${id}/source.jpg`]: {bytes: source}}});
  await processImage(id, context, {table, blobService, identifyImage: async () => agent});
  assert.equal(table.rows.get(id).status, 'ready');
  const safeBuffer = blobService.getContainerClient('contribution-inbox').blobs.get(`${id}/publish.jpg`).bytes;
  assert.equal((await sharp(safeBuffer).metadata()).exif, undefined);
  const record = JSON.parse(table.rows.get(id).catalogJson);
  await table.updateEntity({partitionKey: 'catalog', rowKey: id, status: 'publishing', uploaderName: 'Mimi', catalogJson: JSON.stringify({...record, uploadedBy: 'Mimi', tags: ['Contributor: Mimi']})}, 'Merge');
  await publishImage(id, context, {table, blobService});
  assert.equal(table.rows.get(id).status, 'published');
  assert.equal(table.rows.get(id).draftTokenHash, '');
  const publicBlobs = blobService.getContainerClient('contributions').blobs;
  assert.equal(sha(publicBlobs.get(`photos/${id}.jpg`).bytes), table.rows.get(id).publicSha256);
  assert.equal(sha(publicBlobs.get(`thumbnails/${id}.jpg`).bytes), table.rows.get(id).thumbnailSha256);
  assert.equal(blobService.getContainerClient('contribution-inbox').blobs.size, 0);
});

test('expired private drafts and hidden published images are physically removed', async () => {
  const draftId = '3'.repeat(64), hiddenId = '4'.repeat(64);
  const table = makeTable([
    {partitionKey: 'catalog', rowKey: draftId, status: 'ready', expiresAt: '2000-01-01T00:00:00.000Z'},
    {partitionKey: 'catalog', rowKey: hiddenId, status: 'hidden', expiresAt: '2000-01-01T00:00:00.000Z'}
  ]);
  const blobService = makeBlobService({
    'contribution-inbox': {[`${draftId}/source.jpg`]: {bytes: Buffer.from('private')}, [`${hiddenId}/source.jpg`]: {bytes: Buffer.from('private')}},
    contributions: {[`photos/${hiddenId}.jpg`]: {bytes: Buffer.from('public')}, [`thumbnails/${hiddenId}.jpg`]: {bytes: Buffer.from('thumb')}}
  });
  await expireDrafts(context, {table, blobService});
  assert.equal(table.rows.size, 0);
  assert.equal(blobService.getContainerClient('contribution-inbox').blobs.size, 0);
  assert.equal(blobService.getContainerClient('contributions').blobs.size, 0);
});

test('generated previews are JPEGs suitable for browser display', async () => {
  const source = await sharp({create: {width: 8, height: 8, channels: 3, background: '#cc8844'}}).png().toBuffer();
  const outputs = await normalizeImages(source);
  assert.equal((await sharp(outputs.preview).metadata()).format, 'jpeg');
  assert.equal((await sharp(outputs.thumbnail).metadata()).format, 'jpeg');
});
