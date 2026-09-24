const {app} = require('@azure/functions');
const {getTableClient} = require('../lib/table-client');
const {validateBatch, isCatalogEditor} = require('../lib/validation');

function json(status, body) {
  return {status, headers: {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'}, jsonBody: body};
}

function etagOf(response) {
  return response?.etag || response?.headers?.get?.('etag') || null;
}

async function getTagOverrides(_request, context, tableClient) {
  try {
    const overrides = {};
    for await (const entity of (tableClient || getTableClient()).listEntities()) {
      if (entity.partitionKey !== 'gallery' || !entity.rowKey) continue;
      let tags = [];
      try { const parsed = JSON.parse(entity.tags || '[]'); if (Array.isArray(parsed)) tags = parsed; } catch {}
      overrides[entity.rowKey] = {tags, etag: entity.etag || null};
    }
    return json(200, {overrides});
  } catch (error) {
    context.error('Could not read tag overrides.', error.code || error.statusCode || 'unclassified');
    return json(503, {error: 'Shared tag edits are temporarily unavailable.'});
  }
}

async function saveTagOverrides(request, context, tableClient) {
  if (!isCatalogEditor(request.headers.get('x-ms-client-principal'))) return json(403, {error: 'Editor access is required.'});
  let items;
  try { items = validateBatch(await request.json()); }
  catch (error) { return json(400, {error: error.message}); }
  let table;
  try { table = tableClient || getTableClient(); }
  catch (error) { context.error('Tag API configuration is unavailable.', error.code || 'unclassified'); return json(503, {error: 'Shared tag edits are temporarily unavailable.'}); }

  const results = [];
  for (const item of items) {
    try {
      if (item.tags === null) {
        if (item.etag) await table.deleteEntity('gallery', item.imageId, {etag: item.etag});
        results.push({imageId: item.imageId, cleared: true});
        continue;
      }
      const entity = {partitionKey: 'gallery', rowKey: item.imageId, tags: JSON.stringify(item.tags), updatedAt: new Date().toISOString()};
      const response = item.etag
        ? await table.updateEntity(entity, 'Replace', {etag: item.etag})
        : await table.createEntity(entity);
      results.push({imageId: item.imageId, tags: item.tags, etag: etagOf(response)});
    } catch (error) {
      const conflict = [409, 412].includes(error.statusCode) || ['EntityAlreadyExists', 'UpdateConditionNotSatisfied'].includes(error.code);
      if (!conflict) context.error(`Could not save tag override for ${item.imageId}.`, error.code || error.statusCode || 'unclassified');
      return json(conflict ? 409 : 503, {
        error: conflict ? 'These tags changed in another session. Reload the gallery and try again.' : 'Shared tag edits are temporarily unavailable.',
        results,
        failedImageId: item.imageId
      });
    }
  }
  return json(200, {results});
}

app.http('getTagOverrides', {route: 'tag-overrides', methods: ['GET'], authLevel: 'anonymous', handler: getTagOverrides});
app.http('saveTagOverrides', {route: 'tag-overrides/save-many', methods: ['POST'], authLevel: 'anonymous', handler: saveTagOverrides});

module.exports = {getTagOverrides, saveTagOverrides};
