(() => {
  const $ = id => document.getElementById(id);
  const fileInput = $('contributionFile');
  const flow = $('contributionFlow');
  if (!fileInput || !flow) return;

  const MAX_BYTES = 24 * 1024 * 1024;
  const sessionKey = 'mimi-japan-contribution-draft-v1';
  const status = $('contributionStatus');
  const activity = $('contributionActivity');
  const preview = $('contributionPreview');
  const result = $('contributionResult');
  const form = $('contributionPublishForm');
  const nameInput = $('contributionName');
  const categoryInput = $('contributionCategory');
  const tagsInput = $('contributionTags');
  const addButton = $('addContribution');
  const retryButton = $('retryContribution');
  let active = null;
  let pending = null;
  let previewUrl = '';
  let polling = false;

  function setStatus(message) { status.textContent = message; }
  function setActivity(active) { activity.hidden = !active; }
  function parseTags(value) {
    const seen = new Set();
    return String(value || '').split(/[\n,;]/).map(tag => tag.trim().replace(/\s+/g, ' ').slice(0, 64)).filter(tag => {
      const key = tag.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 40);
  }
  function saveSession() {
    try {
      const draft = active?.id && active?.token ? active : pending;
      if (draft?.id && draft?.token) sessionStorage.setItem(sessionKey, JSON.stringify({id: draft.id, token: draft.token, filename: draft.filename, status: draft.status || ''}));
      else sessionStorage.removeItem(sessionKey);
    } catch {}
  }
  async function photoId(file) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  function newDraftToken() {
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    return [...random].map(value => value.toString(16).padStart(2, '0')).join('');
  }
  function releasePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }
  function setPreview(url) {
    releasePreview();
    previewUrl = url || '';
    preview.src = previewUrl;
    preview.hidden = !previewUrl;
  }
  function clearResult() {
    result.replaceChildren(); result.hidden = true; form.hidden = true; retryButton.hidden = true;
  }
  function showFlow() { flow.hidden = false; }

  function textBlock(parent, label, value, tagName = 'p') {
    if (!value) return;
    const el = document.createElement(tagName);
    el.textContent = value;
    if (tagName === 'p') el.className = 'meta';
    if (label) {
      const strong = document.createElement('strong'); strong.textContent = `${label}: `;
      el.prepend(strong);
    }
    parent.append(el);
  }

  function appendSources(parent, label, entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const wrap = document.createElement('p'); wrap.className = 'research-links';
    const heading = document.createElement('strong'); heading.textContent = `${label}: `; wrap.append(heading);
    entries.forEach((entry, index) => {
      if (index) wrap.append(document.createTextNode(' · '));
      const title = entry.title || entry.name || 'Source';
      try {
        const url = new URL(entry.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsafe link');
        const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = title; wrap.append(link);
      } catch { wrap.append(document.createTextNode(title)); }
      const note = [entry.observedPrice, entry.purpose].filter(Boolean).join(' · ');
      if (note) wrap.append(document.createTextNode(` (${note})`));
    });
    parent.append(wrap);
  }

  function renderResearch(parent, research) {
    const box = document.createElement('section'); box.className = 'web-research';
    const h = document.createElement('h5'); h.textContent = `Web research${research.checkedDate ? ` · checked ${research.checkedDate}` : ''}`; box.append(h);
    const badge = document.createElement('span'); badge.className = `research-badge research-${research.status || 'pending'}`;
    badge.textContent = ({matched: 'Matched', partial: 'Partial match', pending: 'Pending', unmatched: 'No match found'})[research.status] || 'Pending'; box.append(badge);
    textBlock(box, '', research.statusNote);
    textBlock(box, '', research.productSummary);
    const range = research.priceRange;
    if (range && (range.min || range.max)) {
      const currency = range.currency === 'JPY' ? '¥' : range.currency;
      const value = `${currency || ''}${range.min || '—'}–${currency || ''}${range.max || '—'}${range.basis ? ` (${range.basis})` : ''}`;
      textBlock(box, 'Observed price range', value);
    }
    textBlock(box, 'Observed price', research.observedPrice);
    appendSources(box, 'Likely stores', research.stores);
    if (research.reviewSummary) {
      const summary = research.reviewSummary;
      const rating = summary.rating && summary.rating !== 'unavailable' ? `${summary.rating}${summary.count ? ` · ${summary.count} reviews` : ''}. ` : '';
      textBlock(box, 'Customer reviews', `${rating}${summary.summary || 'No product-specific review summary was found.'}`);
      appendSources(box, 'Review sources', summary.sources);
    }
    if (research.translations?.length) {
      const translationHeading = document.createElement('h6'); translationHeading.textContent = 'Japanese product-page text translated'; box.append(translationHeading);
      for (const entry of research.translations) textBlock(box, '', [entry.text, entry.english].filter(Boolean).join(' — '));
    }
    appendSources(box, 'Product sources', research.sources);
    parent.append(box);
  }

  function renderFullResult(record) {
    result.replaceChildren();
    const title = document.createElement('h3'); title.textContent = 'Identification and research'; result.append(title);
    const confidence = document.createElement('p'); confidence.className = 'meta';
    confidence.textContent = `Confidence: ${record.confidence || 'low'}${record.evidence ? ` · ${record.evidence}` : ''}`; result.append(confidence);
    textBlock(result, 'What is in the photo', record.description);
    if (record.notes) textBlock(result, 'Unresolved details', record.notes);
    if (record.products?.length) {
      const productHeading = document.createElement('h3'); productHeading.textContent = 'Products'; result.append(productHeading);
      for (const product of record.products) {
        const block = document.createElement('section'); block.className = 'product-block';
        const productTitle = document.createElement('h4'); productTitle.textContent = [product.brand, product.name, product.variant].filter(Boolean).join(' — ') || 'Product identity uncertain'; block.append(productTitle);
        textBlock(block, 'Match confidence', product.matchConfidence);
        textBlock(block, 'What it does', product.description);
        if (product.webResearch) renderResearch(block, product.webResearch);
        result.append(block);
      }
    }
    if (record.japaneseText?.length) {
      const heading = document.createElement('h3'); heading.textContent = 'Japanese on the packaging · English translation'; result.append(heading);
      for (const entry of record.japaneseText) textBlock(result, '', [entry.text, entry.translation].filter(Boolean).join(' — '));
    }
    const tagsHeading = document.createElement('h3'); tagsHeading.textContent = 'Suggested tags'; result.append(tagsHeading);
    textBlock(result, '', (record.tags || []).join(' · ') || 'No product tags were confidently identified.');
    result.hidden = false;
    categoryInput.replaceChildren(...(window.CATALOG_DATA?.categories || []).map(value => new Option(value, value)));
    if (![...categoryInput.options].some(option => option.value === record.category)) categoryInput.add(new Option(record.category || 'Needs review', record.category || 'Needs review'));
    categoryInput.value = record.category || 'Needs review';
    tagsInput.value = (record.tags || []).join(', ');
    form.hidden = false;
    retryButton.hidden = true;
    addButton.disabled = false;
  }

  async function parseResponse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  async function getStatus() {
    if (!active?.id || !active?.token) throw new Error('This private upload session has expired. Choose the photo again.');
    const response = await fetch(`/api/intakes/${encodeURIComponent(active.id)}`, {headers: {'x-catalog-draft-token': active.token, 'cache-control': 'no-store'}});
    return parseResponse(response);
  }

  async function fetchPrivatePreview() {
    const response = await fetch(`/api/intakes/${encodeURIComponent(active.id)}/preview`, {headers: {'x-catalog-draft-token': active.token, 'cache-control': 'no-store'}});
    if (!response.ok) return;
    setPreview(URL.createObjectURL(await response.blob()));
  }

  async function pollUntilReady() {
    if (polling || !active) return;
    polling = true; showFlow();
    setActivity(true);
    const started = Date.now();
    try {
      while (Date.now() - started < 12 * 60 * 1000) {
        const item = await getStatus();
        active.status = item.status;
        saveSession();
        if (item.status === 'ready' && item.result) {
          setActivity(false);
          active.result = item.result; saveSession();
          await fetchPrivatePreview();
          renderFullResult(item.result);
          setStatus('The full result is ready. Review it, enter your name, and choose Add to catalog if you want to publish it.');
          polling = false; return;
        }
        if (item.status === 'published') {
          setActivity(false);
          setStatus('This photo has already been added to the catalog.');
          form.hidden = true; active = null; pending = null; saveSession(); polling = false; return;
        }
        if (['failed', 'upload-failed', 'queue-failed'].includes(item.status)) {
          setActivity(false);
          setStatus(item.error || 'Processing needs a retry. Your photo is still private.');
          retryButton.hidden = false; form.hidden = true; polling = false; return;
        }
        setStatus(item.status === 'processing' ? 'Identifying the products and researching current product pages…' : 'Photo received. Waiting for analysis…');
        await new Promise(resolve => setTimeout(resolve, 3500));
      }
      setActivity(false);
      setStatus('Analysis is taking longer than expected. Your draft is saved in this browser; reload the page to check it again.');
      retryButton.hidden = true;
    } catch (error) {
      setActivity(false);
      setStatus(error.message === 'This private upload is unavailable.'
        ? 'The upload session could not be found. Choose the same photo again to resume, or choose another photo to start a new upload.'
        : error.message || 'The private result could not be loaded.');
      retryButton.hidden = true;
    } finally { polling = false; }
  }

  async function beginUpload(file) {
    setActivity(false);
    clearResult();
    showFlow();
    const localPreview = URL.createObjectURL(file);
    setPreview(localPreview);
    if (!file.size) { setStatus('This photo is empty. Choose a different file.'); return; }
    if (file.size > MAX_BYTES) { setStatus('Choose a photo smaller than 24 MB.'); return; }
    setStatus('Uploading photo privately…');
    try {
      const id = await photoId(file);
      const previous = active?.id === id ? active : pending?.id === id ? pending : null;
      pending = {id, token: previous?.token || newDraftToken(), filename: file.name || 'phone-photo'};
      active = null;
      saveSession();
      const response = await fetch('/api/intakes', {method: 'POST', headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name || 'phone-photo'),
        'x-catalog-draft-token': pending.token
      }, body: file});
      const payload = await response.json().catch(() => ({}));
      if (payload.id && (payload.token || payload.status === 'published')) {
        active = payload.token ? {id: payload.id, token: payload.token, filename: file.name || 'phone-photo', status: payload.status} : null;
        pending = null;
        saveSession();
      }
      if (payload.duplicate && payload.status === 'published') {
        setStatus('This exact photo is already in the public catalog. Search by its product name or tags.');
        return;
      }
      if (!response.ok && !payload.token) throw new Error(payload.error || `Upload failed (${response.status}).`);
      if (!active) throw new Error(payload.error || 'The upload session could not be created.');
      if (payload.status === 'queue-failed' || payload.status === 'upload-failed') {
        setStatus(payload.error || 'Photo received but processing did not start. You can retry.');
        retryButton.hidden = false;
        return;
      }
      await pollUntilReady();
    } catch (error) {
      setStatus(`${error.message || 'The photo could not be uploaded.'}${pending ? ' If the connection dropped, choose the same photo again to resume this private draft.' : ''}`);
    }
  }

  fileInput.addEventListener('change', async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) await beginUpload(file);
  });

  $('clearContribution').addEventListener('click', () => {
    active = null; pending = null; saveSession(); clearResult(); setPreview(''); setStatus('Choose another photo whenever you’re ready. The unsubmitted private draft expires after 30 days.'); fileInput.value = '';
  });

  retryButton.addEventListener('click', async () => {
    if (!active) return;
    if (active.status === 'upload-failed') {
      setStatus('Choose the same photo again to resume its private upload.');
      fileInput.click();
      return;
    }
    retryButton.disabled = true;
    try {
      await parseResponse(await fetch(`/api/intakes/${encodeURIComponent(active.id)}/retry`, {method: 'POST', headers: {'x-catalog-draft-token': active.token}}));
      retryButton.hidden = true; setStatus('Retry queued. Your photo remains private while it is processed.'); await pollUntilReady();
    } catch (error) { setStatus(error.message); }
    finally { retryButton.disabled = false; }
  });

  async function waitForPublished(id) {
    for (let attempt = 0; attempt < 36; attempt++) {
      const response = await fetch('/api/catalog-items', {cache: 'no-store'});
      if (response.ok) {
        const payload = await response.json();
        const item = payload.images?.find(image => image.id === id);
        if (item) return item;
      }
      await new Promise(resolve => setTimeout(resolve, 2500));
    }
    throw new Error('Your contribution is queued for publishing. Reload the gallery shortly to see it.');
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!active?.id || !active?.token || !active.result) return;
    if (!nameInput.value.trim()) { nameInput.focus(); return; }
    addButton.disabled = true;
    retryButton.hidden = true;
    setStatus('Adding your contribution to the public catalog…');
    try {
      const response = await fetch(`/api/intakes/${encodeURIComponent(active.id)}/publish`, {
        method: 'POST', headers: {'x-catalog-draft-token': active.token, 'content-type': 'application/json'},
        body: JSON.stringify({uploaderName: nameInput.value, category: categoryInput.value, tags: parseTags(tagsInput.value)})
      });
      const payload = await parseResponse(response);
      if (payload.status === 'published') {
        setStatus('This exact photo is already in the catalog.'); return;
      }
      const item = await waitForPublished(active.id);
      window.dispatchEvent(new CustomEvent('mimi-catalog-item-published', {detail: item}));
      active = null;
      pending = null;
      saveSession();
      form.hidden = true;
      setStatus('Added to the catalog. Your photo, research, tags, and contributor name are now public.');
    } catch (error) {
      setStatus(error.message || 'The contribution could not be added.');
      addButton.disabled = false;
    }
  });

  try {
    const previous = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
    if (previous?.id && previous?.token) {
      active = previous; pending = previous; showFlow();
      setStatus('Restoring your private upload…');
      pollUntilReady();
    }
  } catch {}
})();
