const IMAGE_ID = /^(?:[a-f0-9]{16}|[a-f0-9]{64})$/i;
const MAX_BATCH = 25;
const MAX_TAGS = 80;
const MAX_TAG_LENGTH = 64;

function normalizeTags(input) {
  if (!Array.isArray(input) || input.length > MAX_TAGS) throw new Error('Tags must be a list of at most 80 values.');
  const seen = new Set();
  const result = [];
  for (const raw of input) {
    if (typeof raw !== 'string') throw new Error('Each tag must be text.');
    const value = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
    const key = value.toLocaleLowerCase();
    if (value && !seen.has(key)) { seen.add(key); result.push(value); }
  }
  return result;
}

function validateBatch(input) {
  if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > MAX_BATCH) {
    throw new Error(`Submit between 1 and ${MAX_BATCH} tag changes at a time.`);
  }
  const seen = new Set();
  return input.items.map(item => {
    if (!item || typeof item.imageId !== 'string' || !IMAGE_ID.test(item.imageId)) throw new Error('Invalid image ID.');
    if (seen.has(item.imageId)) throw new Error('An image can appear only once in a batch.');
    seen.add(item.imageId);
    if (item.etag !== null && item.etag !== undefined && (typeof item.etag !== 'string' || item.etag.length > 200)) throw new Error('Invalid ETag.');
    return {imageId: item.imageId, tags: item.tags === null ? null : normalizeTags(item.tags), etag: item.etag || null};
  });
}

function isCatalogEditor(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue) return false;
  try {
    const principal = JSON.parse(Buffer.from(headerValue, 'base64').toString('utf8'));
    return Array.isArray(principal.userRoles) && principal.userRoles.includes('catalog_editor');
  } catch { return false; }
}

module.exports = {IMAGE_ID, MAX_BATCH, normalizeTags, validateBatch, isCatalogEditor};
