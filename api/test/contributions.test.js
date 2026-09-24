const test = require('node:test');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {createIntake, getIntake, retryIntake, publishIntake, getCatalogItems, hideCatalogItem, imageFormat, normalizeSubmission} = require('../src/functions/contributions');

function context() { return {log() {}, warn() {}, error() {}}; }
function request({headers = {}, params = {}, bytes, body, principal} = {}) {
  const values = new Map(Object.entries({...headers, ...(principal ? {'x-ms-client-principal': principal} : {})}).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {headers: {get: key => values.get(key.toLowerCase()) || null}, params,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    json: async () => body};
}
function makeTable(initial = []) {
  const rows = new Map(initial.map(row => [row.rowKey, {...row}]));
  return {rows,
    async getEntity(partitionKey, rowKey) {
      const row = rows.get(rowKey);
      if (!row || row.partitionKey !== partitionKey) { const error = new Error('missing'); error.statusCode = 404; throw error; }
      return {...row};
    },
    async createEntity(row) {
      if (rows.has(row.rowKey)) { const error = new Error('exists'); error.statusCode = 409; throw error; }
      rows.set(row.rowKey, {...row});
    },
    async updateEntity(row, mode) {
      const old = rows.get(row.rowKey) || {};
      rows.set(row.rowKey, mode === 'Replace' ? {...row} : {...old, ...row});
      return {etag: 'W/"test"'};
    },
    async *listEntities() { for (const row of rows.values()) yield {...row}; }
  };
}
function makeInbox() {
  const uploads = new Map();
  return {uploads, getBlockBlobClient(name) { return {async uploadData(bytes, options) { uploads.set(name, {bytes: Buffer.from(bytes), options}); }}; }};
}
function makeQueue(shouldFail = false) {
  const messages = [];
  return {messages, async sendMessage(message) { if (shouldFail) throw new Error('queue unavailable'); messages.push(JSON.parse(message)); }};
}
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const hash = value => createHash('sha256').update(value).digest('hex');

test('image upload accepts supported image signatures and rejects non-images', () => {
  assert.equal(imageFormat(png).mime, 'image/png');
  assert.equal(imageFormat(Buffer.from([0xff, 0xd8, 0xff, 0])).extension, 'jpg');
  assert.equal(imageFormat(Buffer.from('<svg></svg>')), null);
});

test('anonymous intake stores the image privately and returns a token-gated draft', async () => {
  const table = makeTable(), inbox = makeInbox(), queue = makeQueue();
  const response = await createIntake(request({headers: {'content-length': String(png.length), 'x-file-name': 'store%20photo.png'}, bytes: png}), context(), {table, inbox, queue});
  assert.equal(response.status, 202);
  assert.equal(response.jsonBody.id, hash(png));
  assert.match(response.jsonBody.token, /^[a-f0-9]{64}$/);
  assert.equal(queue.messages[0].type, 'process');
  assert.match(queue.messages[0].attemptId, /^[a-f0-9]{32}$/);
  assert.equal(table.rows.get(hash(png)).activeAttemptId, queue.messages[0].attemptId);
  assert.deepEqual([...inbox.uploads.keys()], [`${hash(png)}/source.png`]);
  assert.equal(table.rows.get(hash(png)).status, 'queued');
  const privateResult = await getIntake(request({params: {id: hash(png)}}), context(), {table});
  assert.equal(privateResult.status, 404);
  const authorized = await getIntake(request({params: {id: hash(png)}, headers: {'x-catalog-draft-token': response.jsonBody.token}}), context(), {table});
  assert.equal(authorized.status, 200);
  assert.equal(authorized.jsonBody.status, 'queued');
  table.rows.get(hash(png)).retryAction = 'publish';
  const retryable = await getIntake(request({params: {id: hash(png)}, headers: {'x-catalog-draft-token': response.jsonBody.token}}), context(), {table});
  assert.equal(retryable.jsonBody.retryAction, 'publish');
});

test('oversized uploads and invalid signatures are rejected before storage', async () => {
  const table = makeTable(), inbox = makeInbox(), queue = makeQueue();
  const tooLarge = await createIntake(request({headers: {'content-length': String(24 * 1024 * 1024 + 1)}, bytes: png}), context(), {table, inbox, queue});
  assert.equal(tooLarge.status, 413);
  const invalid = await createIntake(request({bytes: Buffer.from('not an image')}), context(), {table, inbox, queue});
  assert.equal(invalid.status, 415);
  assert.equal(table.rows.size, 0);
  assert.equal(queue.messages.length, 0);
});

test('an expired draft with the same photo can be safely restarted', async () => {
  const id = hash(png), table = makeTable([{partitionKey: 'catalog', rowKey: id, status: 'failed', sourceBlob: `${id}/old.jpg`, expiresAt: '2000-01-01T00:00:00.000Z'}]);
  const inbox = makeInbox(), queue = makeQueue();
  const response = await createIntake(request({bytes: png}), context(), {table, inbox, queue});
  assert.equal(response.status, 202);
  assert.equal(response.jsonBody.status, 'queued');
  assert.equal(table.rows.get(id).status, 'queued');
  assert.ok(table.rows.get(id).expiresAt > new Date().toISOString());
  assert.ok(inbox.uploads.has(`${id}/source.png`));
});

test('uploading a duplicate cannot take over another visitor private draft', async () => {
  const id = hash(png), priorToken = 'b'.repeat(64);
  const table = makeTable([{partitionKey: 'catalog', rowKey: id, status: 'processing', draftTokenHash: hash(priorToken), expiresAt: '2099-01-01T00:00:00.000Z'}]);
  const inbox = makeInbox(), queue = makeQueue();
  const response = await createIntake(request({bytes: png}), context(), {table, inbox, queue});
  assert.equal(response.status, 409);
  assert.equal(response.jsonBody.token, undefined);
  assert.equal(table.rows.get(id).draftTokenHash, hash(priorToken));
  assert.equal(inbox.uploads.size, 0);
  assert.equal(queue.messages.length, 0);
});

test('the browser-held draft token can safely resume a source upload after a lost response', async () => {
  const id = hash(png), token = 'd'.repeat(64), table = makeTable(), queue = makeQueue();
  const failingInbox = {getBlockBlobClient() { return {async uploadData() { throw new Error('temporary storage failure'); }}; }};
  const interrupted = await createIntake(request({headers: {'x-catalog-draft-token': token}, bytes: png}), context(), {table, inbox: failingInbox, queue});
  assert.equal(interrupted.status, 503);
  assert.equal(interrupted.jsonBody.status, 'upload-failed');
  assert.equal(interrupted.jsonBody.token, token);
  assert.equal(table.rows.get(id).draftTokenHash, hash(token));

  const inbox = makeInbox();
  const resumed = await createIntake(request({headers: {'x-catalog-draft-token': token}, bytes: png}), context(), {table, inbox, queue});
  assert.equal(resumed.status, 202);
  assert.equal(resumed.jsonBody.status, 'queued');
  assert.equal(resumed.jsonBody.token, token);
  assert.equal(queue.messages.length, 1);
  assert.ok(inbox.uploads.has(`${id}/source.png`));
});

test('retry marks the intended action before enqueueing and preserves it after enqueue failure', async () => {
  const id = 'b'.repeat(64), token = 'c'.repeat(64);
  const table = makeTable([{partitionKey: 'catalog', rowKey: id, status: 'failed', retryAction: 'publish', draftTokenHash: hash(token)}]);
  const queue = {messages: [], async sendMessage(message) {
    assert.equal(table.rows.get(id).status, 'publishing');
    this.messages.push(JSON.parse(message));
  }};
  const response = await retryIntake(request({params: {id}, headers: {'x-catalog-draft-token': token}}), context(), {table, queue});
  assert.equal(response.status, 202);
  assert.equal(queue.messages.length, 1);
  assert.equal(queue.messages[0].type, 'publish');
  assert.equal(queue.messages[0].id, id);
  assert.match(queue.messages[0].attemptId, /^[a-f0-9]{32}$/);
  assert.equal(table.rows.get(id).activeAttemptId, queue.messages[0].attemptId);

  Object.assign(table.rows.get(id), {status: 'failed', retryAction: 'publish'});
  const failingQueue = {async sendMessage() { throw new Error('queue unavailable'); }};
  const failed = await retryIntake(request({params: {id}, headers: {'x-catalog-draft-token': token}}), context(), {table, queue: failingQueue});
  assert.equal(failed.status, 503);
  assert.equal(table.rows.get(id).status, 'failed');
  assert.equal(table.rows.get(id).retryAction, 'publish');
});

test('submit requires a ready result and contributor name, then adds an attribution tag', async () => {
  const id = 'a'.repeat(64), token = 'b'.repeat(64);
  const row = {partitionKey: 'catalog', rowKey: id, status: 'ready', draftTokenHash: hash(token), catalogJson: JSON.stringify({id, confidence: 'high', tags: ['skincare']})};
  const table = makeTable([row]), queue = makeQueue();
  const missingName = await publishIntake(request({params: {id}, headers: {'x-catalog-draft-token': token}, body: {category: 'Facial skincare', tags: ['skincare']}}), context(), {table, queue});
  assert.equal(missingName.status, 400);
  const response = await publishIntake(request({params: {id}, headers: {'x-catalog-draft-token': token}, body: {uploaderName: 'Mimi', category: 'Facial skincare', tags: ['skincare', 'Contributor: forged']}}), context(), {table, queue});
  assert.equal(response.status, 202);
  const record = JSON.parse(table.rows.get(id).catalogJson);
  assert.deepEqual(record.tags, ['skincare', 'Contributor: Mimi']);
  assert.equal(record.uploadedBy, 'Mimi');
  assert.equal(record.image, `Contributions/photos/${id}.jpg`);
  assert.equal(record.download, `Contributions/photos/${id}.jpg`);
  assert.equal(record.downloadFilename, `${id}.jpg`);
  assert.equal(record.thumbWebp, `Contributions/optimized-v1/thumbnails/${id}.webp`);
  assert.equal(record.displayWebp, `Contributions/optimized-v1/display/${id}.webp`);
  assert.equal(queue.messages.at(-1).type, 'publish');
});

test('only published contributions are exposed, and hiding requires the editor role', async () => {
  const id = 'c'.repeat(64), table = makeTable([
    {partitionKey: 'catalog', rowKey: 'd'.repeat(64), status: 'ready', catalogJson: '{}'},
    {partitionKey: 'catalog', rowKey: id, status: 'published', publishedAt: '2026-09-23T10:00:00.000Z', catalogJson: JSON.stringify({id})},
    {partitionKey: 'catalog', rowKey: 'e'.repeat(64), status: 'published', publishedAt: '2026-09-24T10:00:00.000Z', catalogJson: JSON.stringify({id: 'e'.repeat(64)})}
  ]);
  const publicItems = await getCatalogItems({}, context(), {table});
  assert.deepEqual(publicItems.jsonBody.images.map(item => item.id), ['e'.repeat(64), id]);
  assert.equal(publicItems.jsonBody.images[0].publishedAt, '2026-09-24T10:00:00.000Z');
  const queue = makeQueue();
  const anonymous = await hideCatalogItem(request({params: {id}}), context(), {table, queue});
  assert.equal(anonymous.status, 403);
  const principal = Buffer.from(JSON.stringify({userRoles: ['authenticated', 'catalog_editor']})).toString('base64');
  const hidden = await hideCatalogItem(request({params: {id}, principal}), context(), {table, queue});
  assert.equal(hidden.status, 200);
  assert.equal(queue.messages.at(-1).type, 'remove');
});

test('submission removes forged contributor tags and caps contributor display names', () => {
  const record = normalizeSubmission({uploaderName: 'Mimi', category: 'Sunscreen', tags: ['SPF', 'Contributor: Somebody else']}, {confidence: 'high', tags: ['old']}, 'e'.repeat(64)).record;
  assert.deepEqual(record.tags, ['SPF', 'Contributor: Mimi']);
  assert.throws(() => normalizeSubmission({uploaderName: 'x'.repeat(49), tags: []}, {}, 'f'.repeat(64)), /48 characters/);
});
