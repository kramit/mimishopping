const test = require('node:test');
const assert = require('node:assert/strict');
const {isCatalogEditor, normalizeTags, validateBatch} = require('../src/lib/validation');
const {getTagOverrides, saveTagOverrides} = require('../src/functions/tag-overrides');

const context = {error() {}};

test('only a trusted principal carrying catalog_editor is accepted', () => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64');
  assert.equal(isCatalogEditor(encode({userRoles: ['anonymous', 'authenticated', 'catalog_editor']})), true);
  assert.equal(isCatalogEditor(encode({userRoles: ['anonymous', 'authenticated']})), false);
  assert.equal(isCatalogEditor('not-base64-json'), false);
  assert.equal(isCatalogEditor(null), false);
});

test('tags are normalized, case-insensitive duplicates are removed, and limits are enforced', () => {
  assert.deepEqual(normalizeTags(['  Face   mask ', 'face mask', '', 'SPF']), ['Face mask', 'SPF']);
  assert.throws(() => normalizeTags('not a list'));
  assert.throws(() => normalizeTags(Array(81).fill('tag')));
  assert.throws(() => normalizeTags([null]));
});

test('batch validation rejects malformed IDs, duplicate images, and oversized batches', () => {
  assert.deepEqual(validateBatch({items: [{imageId: '0123456789abcdef', tags: ['SPF']}]}), [
    {imageId: '0123456789abcdef', tags: ['SPF'], etag: null}
  ]);
  assert.throws(() => validateBatch({items: [{imageId: 'bad', tags: []}]}));
  assert.throws(() => validateBatch({items: [
    {imageId: '0123456789abcdef', tags: []}, {imageId: '0123456789abcdef', tags: []}
  ]}));
  assert.throws(() => validateBatch({items: Array(26).fill(0).map((_, i) => ({imageId: i.toString(16).padStart(16, '0'), tags: []}))}));
});

test('public reads include only gallery overrides and their ETags', async () => {
  const rows = [
    {partitionKey: 'gallery', rowKey: '0123456789abcdef', tags: '["SPF"]', etag: 'W/"1"'},
    {partitionKey: 'other', rowKey: '1111111111111111', tags: '["private"]', etag: 'W/"2"'}
  ];
  const table = {async *listEntities() { yield* rows; }};
  const response = await getTagOverrides({}, context, table);
  assert.equal(response.status, 200);
  assert.deepEqual(response.jsonBody.overrides, {'0123456789abcdef': {tags: ['SPF'], etag: 'W/"1"'}});
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('write API rejects anonymous callers before touching Table Storage', async () => {
  let touched = false;
  const table = {async createEntity() { touched = true; }};
  const request = {headers: {get: () => Buffer.from(JSON.stringify({userRoles: ['anonymous']})).toString('base64')}, async json() { return {items: []}; }};
  const response = await saveTagOverrides(request, context, table);
  assert.equal(response.status, 403);
  assert.equal(touched, false);
});

test('write API creates new rows and conditionally updates with the supplied ETag', async () => {
  const calls = [];
  const table = {
    async createEntity(entity) { calls.push(['create', entity]); return {etag: 'W/"created"'}; },
    async updateEntity(entity, mode, options) { calls.push(['update', entity, mode, options]); return {etag: 'W/"updated"'}; }
  };
  const principal = Buffer.from(JSON.stringify({userRoles: ['anonymous', 'authenticated', 'catalog_editor']})).toString('base64');
  const request = {headers: {get: () => principal}, async json() { return {items: [
    {imageId: '0123456789abcdef', tags: ['SPF'], etag: null},
    {imageId: '1111111111111111', tags: ['mask'], etag: 'W/"old"'}
  ]}; }};
  const response = await saveTagOverrides(request, context, table);
  assert.equal(response.status, 200);
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[1][0], 'update');
  assert.equal(calls[1][3].etag, 'W/"old"');
  assert.deepEqual(response.jsonBody.results.map(x => x.etag), ['W/"created"', 'W/"updated"']);
});
