(() => {
  const $ = id => document.getElementById(id);
  const libraryInput = $('contributionLibraryFile');
  const cameraInput = $('contributionCameraFile');
  const flow = $('contributionFlow');
  if (!libraryInput || !cameraInput || !flow) return;

  const MAX_BYTES = 24 * 1024 * 1024;
  const sessionKey = 'mimi-japan-contribution-draft-v1';
  const draftsKey = 'mimi-japan-contribution-drafts-v2';
  const status = $('contributionStatus');
  const activity = $('contributionActivity');
  const preview = $('contributionPreview');
  const result = $('contributionResult');
  const form = $('contributionPublishForm');
  const publishStatus = $('contributionPublishStatus');
  const draftList = $('contributionDrafts');
  const nameInput = $('contributionName');
  const categoryInput = $('contributionCategory');
  const tagsInput = $('contributionTags');
  const addButton = $('addContribution');
  const retryButton = $('retryContribution');
  const drafts = new Map();
  let active = null;
  let previewUrl = '';
  let refreshTimer = 0;
  let refreshing = false;
  let activityTimer = 0;
  let activityFrame = 0;
  const pollingIds = new Set();
  const activityFrames = [...activity.querySelectorAll('.inspection-frame')];

  function setStatus(message, reveal = false) {
    status.textContent = message;
    if (reveal) status.scrollIntoView({block: 'nearest', behavior: 'smooth'});
  }
  function showActivityFrame(index) {
    activityFrame = index;
    activityFrames.forEach((frame, frameIndex) => frame.classList.toggle('is-active', frameIndex === index));
  }
  function setActivity(active) {
    const shouldShow = Boolean(active);
    if (activity.hidden === !shouldShow) return;
    activity.hidden = !shouldShow;
    clearInterval(activityTimer); activityTimer = 0;
    showActivityFrame(0);
    if (shouldShow && activityFrames.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      activityTimer = window.setInterval(() => showActivityFrame((activityFrame + 1) % activityFrames.length), 4000);
    }
  }
  function syncActivity() {
    setActivity([...drafts.values()].some(draft => ['queued', 'processing'].includes(draft.status)));
  }
  function parseTags(value) {
    const seen = new Set();
    return String(value || '').split(/[\n,;]/).map(tag => tag.trim().replace(/\s+/g, ' ').slice(0, 64)).filter(tag => {
      const key = tag.toLocaleLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 40);
  }
  function validDraft(draft) {
    return /^[a-f0-9]{64}$/i.test(draft?.id || '') && /^[a-f0-9]{64}$/i.test(draft?.token || '');
  }
  function restoreDrafts() {
    try {
      const saved = JSON.parse(localStorage.getItem(draftsKey) || '[]');
      if (Array.isArray(saved)) for (const draft of saved) if (validDraft(draft)) drafts.set(draft.id, {...draft});
    } catch {}
    try {
      const legacy = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
      if (validDraft(legacy) && !drafts.has(legacy.id)) drafts.set(legacy.id, {...legacy});
      sessionStorage.removeItem(sessionKey);
    } catch {}
    saveDrafts();
  }
  function saveDrafts() {
    try {
      localStorage.setItem(draftsKey, JSON.stringify([...drafts.values()].map(({id, token, filename, status, createdAt, error, retryAction}) => ({id, token, filename, status, createdAt, error, retryAction}))));
    } catch {}
  }
  function saveDraft(draft, patch = {}) {
    const saved = drafts.get(draft.id) || draft;
    Object.assign(saved, draft, patch);
    drafts.set(saved.id, saved);
    if (active?.id === saved.id) active = saved;
    saveDrafts();
    syncActivity();
    renderDraftList();
    scheduleRefresh();
    return saved;
  }
  function forgetDraft(id) {
    drafts.delete(id);
    if (active?.id === id) active = null;
    saveDrafts();
    syncActivity();
    renderDraftList();
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
    publishStatus.hidden = true; publishStatus.textContent = '';
    addButton.disabled = false; addButton.textContent = 'Add to catalog';
    nameInput.disabled = false; categoryInput.disabled = false; tagsInput.disabled = false;
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

  async function getStatus(draft) {
    if (!validDraft(draft)) throw new Error('This private upload session has expired. Choose the photo again.');
    const response = await fetch(`/api/intakes/${encodeURIComponent(draft.id)}`, {headers: {'x-catalog-draft-token': draft.token, 'cache-control': 'no-store'}});
    return parseResponse(response);
  }

  async function fetchPrivatePreview(draft) {
    const response = await fetch(`/api/intakes/${encodeURIComponent(draft.id)}/preview`, {headers: {'x-catalog-draft-token': draft.token, 'cache-control': 'no-store'}});
    if (!response.ok) return;
    const objectUrl = URL.createObjectURL(await response.blob());
    if (active?.id === draft.id) setPreview(objectUrl); else URL.revokeObjectURL(objectUrl);
  }

  function statusLabel(draft) {
    if (draft.status === 'ready') return 'Analysis complete · ready to review';
    if (draft.status === 'publishing') return 'Adding to the public catalog…';
    if (draft.status === 'processing') return 'AI is identifying products and checking web sources…';
    if (draft.status === 'queued' || draft.status === 'uploading') return 'AI analysis is running in the background…';
    if (['failed', 'upload-failed', 'queue-failed'].includes(draft.status)) return draft.error || 'This upload needs a retry.';
    return 'Private upload';
  }

  function renderDraftList() {
    if (!draftList) return;
    const items = [...drafts.values()].sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    draftList.replaceChildren();
    draftList.hidden = !items.length;
    for (const draft of items) {
      const row = document.createElement('div'); row.className = 'contribution-draft';
      const info = document.createElement('div'); info.className = 'contribution-draft-info';
      const filename = document.createElement('strong'); filename.textContent = draft.filename || 'Phone photo';
      const note = document.createElement('span'); note.textContent = statusLabel(draft);
      info.append(filename,note);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-quiet';
      if (draft.status === 'ready') button.textContent = 'Review result';
      else if (['failed','upload-failed','queue-failed'].includes(draft.status)) button.textContent = draft.status === 'upload-failed' ? 'Choose photo to resume' : 'Retry';
      else button.textContent = draft.status === 'publishing' ? 'Check catalog' : 'Check progress';
      button.setAttribute('aria-label',`${button.textContent}: ${draft.filename || 'phone photo'}`);
      button.addEventListener('click',()=>{
        if(draft.status==='ready') openDraft(draft);
        else if(['failed','upload-failed','queue-failed'].includes(draft.status)) retryDraft(draft);
        else if(draft.status==='publishing') refreshDrafts();
        else checkDraft(draft);
      });
      row.append(info,button); draftList.append(row);
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer); refreshTimer = 0;
    if ([...drafts.values()].some(draft => ['uploading','queued','processing','publishing'].includes(draft.status))) {
      refreshTimer = setTimeout(refreshDrafts, 12000);
    }
  }

  async function getPublicItem(id, cachedPayload = null) {
    let payload = cachedPayload;
    if (!payload) {
      const response = await fetch('/api/catalog-items',{cache:'no-store'});
      if (!response.ok) return null;
      payload = await response.json();
    }
    return (payload.images || []).find(image => image.id === id) || null;
  }

  function finishPublished(image) {
    if (image) window.dispatchEvent(new CustomEvent('mimi-catalog-item-published',{detail:image}));
    const id = image?.id || active?.id;
    const wasActive = active?.id === id;
    if (id) forgetDraft(id);
    if (wasActive) {
      clearResult();
      setPreview('');
      setActivity(false);
      setStatus('Added to the catalog. It is now the first photo in the collection.');
    }
  }

  function showReadyResult(draft, record) {
    if (active?.id !== draft.id) return;
    draft.result = record;
    renderFullResult(record);
    setActivity(false);
    if(draft.status==='publishing'){
      addButton.disabled=true;addButton.textContent='Publishing…';
      nameInput.disabled=true;categoryInput.disabled=true;tagsInput.disabled=true;
      publishStatus.hidden=false;publishStatus.textContent='Your contribution is queued for publishing. You can keep browsing; it will appear at the top of the gallery when ready.';
    }
  }

  async function checkDraft(draft) {
    showFlow();
    try {
      const item = await getStatus(draft);
      const saved = saveDraft(draft,{status:item.status,error:item.error||'',retryAction:item.retryAction||''});
      if(item.status==='ready'&&item.result){
        active=saved;clearResult();setPreview('');showReadyResult(saved,item.result);await fetchPrivatePreview(saved);
        setStatus('The full result is ready. Review it, enter your name, and choose Add to catalog if you want to publish it.');
      } else if(item.status==='publishing'&&item.result){
        active=saved;clearResult();setPreview('');showReadyResult(saved,item.result);await fetchPrivatePreview(saved);
      }
      renderDraftList();
      if(['queued','processing','publishing'].includes(item.status))scheduleRefresh();
    } catch(error) {
      saveDraft(draft,{error:error.message||'Could not check this private upload.'});
      setStatus(error.message||'Could not check this private upload. Try again shortly.');
    }
  }

  async function refreshDrafts() {
    if(refreshing)return;
    refreshing=true;
    try {
      let publicPayload=null;
      if([...drafts.values()].some(draft=>draft.status==='publishing')){
        const response=await fetch('/api/catalog-items',{cache:'no-store'});
        if(response.ok)publicPayload=await response.json();
      }
      for(const draft of [...drafts.values()]){
        if(draft.status==='publishing'){
          const published=await getPublicItem(draft.id,publicPayload);
          if(published){finishPublished(published);continue;}
        }
        if(pollingIds.has(draft.id)||!['uploading','queued','processing','publishing'].includes(draft.status))continue;
        try{
          const item=await getStatus(draft);
          const saved=saveDraft(draft,{status:item.status,error:item.error||'',retryAction:item.retryAction||''});
          if(item.status==='ready'&&item.result){saved.result=item.result;if(active?.id===saved.id)showReadyResult(saved,item.result);}
          if(item.status==='failed'&&active?.id===saved.id){
            publishStatus.hidden=false;publishStatus.textContent=item.error||'The catalog action needs a retry.';
            retryButton.textContent=item.retryAction==='publish'?'Retry adding to catalog':'Retry analysis';retryButton.hidden=false;
            addButton.disabled=true;
          }
          if(item.status==='published'){
            const published=await getPublicItem(saved.id,publicPayload);
            if(published)finishPublished(published);
          }
        }catch(error){
          if(draft.status==='publishing'){
            const published=await getPublicItem(draft.id).catch(()=>null);
            if(published){finishPublished(published);continue;}
            saveDraft(draft,{error:'Publication is still being checked. The photo remains in the queue.',status:'publishing'});
          }else if(error.message?.includes('unavailable')||error.message?.includes('expired'))saveDraft(draft,{error:error.message,status:'failed'});
        }
      }
    } finally {
      refreshing=false;renderDraftList();scheduleRefresh();
    }
  }

  async function pollUntilReady(draft) {
    if(pollingIds.has(draft.id))return;
    pollingIds.add(draft.id);showFlow();setActivity(true);
    const started = Date.now();
    try {
      while (Date.now() - started < 12 * 60 * 1000) {
        if(active?.id!==draft.id)return;
        const item = await getStatus(draft);
        saveDraft(draft,{status:item.status,error:item.error||'',retryAction:item.retryAction||''});
        if (item.status === 'ready' && item.result) {
          showReadyResult(draft,item.result);
          await fetchPrivatePreview(draft);
          setStatus('The full result is ready. Review it, enter your name, and choose Add to catalog if you want to publish it.');
          return;
        }
        if(item.status==='publishing'&&item.result){
          showReadyResult(draft,item.result);await fetchPrivatePreview(draft);scheduleRefresh();return;
        }
        if (['failed', 'upload-failed', 'queue-failed'].includes(item.status)) {
          setActivity(false);
          retryButton.textContent=item.retryAction==='publish'?'Retry adding to catalog':'Retry analysis';
          retryButton.hidden = false; form.hidden = true;renderDraftList();setStatus(item.error || 'Processing needs a retry. Your photo is still private.');return;
        }
        setStatus(item.status === 'processing' ? 'Identifying the products and researching current product pages…' : 'Photo received. Waiting for analysis…');
        await new Promise(resolve => setTimeout(resolve, 3500));
      }
      setActivity(false);
      setStatus('Analysis is taking longer than expected. It is still running in the background; check the upload list later.');
      retryButton.hidden = true;
    } catch (error) {
      setActivity(false);
      setStatus(error.message || 'The private result could not be loaded.');
      retryButton.hidden = true;
    } finally { pollingIds.delete(draft.id);renderDraftList();scheduleRefresh(); }
  }

  async function openDraft(draft) {
    active=draft;clearResult();setPreview('');showFlow();
    try{
      const item=await getStatus(draft);
      saveDraft(draft,{status:item.status,error:item.error||'',retryAction:item.retryAction||''});
      if(item.status==='ready'&&item.result){showReadyResult(draft,item.result);await fetchPrivatePreview(draft);setStatus('The full result is ready. Review it, enter your name, and choose Add to catalog if you want to publish it.');return;}
      if(item.status==='publishing'&&item.result){showReadyResult(draft,item.result);await fetchPrivatePreview(draft);return;}
      if(['failed','upload-failed','queue-failed'].includes(item.status)){setStatus(item.error||'This private upload needs a retry.');retryButton.textContent=item.retryAction==='publish'?'Retry adding to catalog':'Retry analysis';retryButton.hidden=false;return;}
      setStatus('Analysis continues in the background.');
      await pollUntilReady(draft);
    }catch(error){setStatus(error.message||'Could not open this private result.');}
  }

  async function retryDraft(draft) {
    if(draft.status==='upload-failed'||draft.status==='uploading'){
      setStatus('Choose the same photo from your camera roll to resume its private upload.');libraryInput.click();return;
    }
    try {
      const payload=await parseResponse(await fetch(`/api/intakes/${encodeURIComponent(draft.id)}/retry`,{method:'POST',headers:{'x-catalog-draft-token':draft.token}}));
      saveDraft(draft,{status:payload.status||'queued',error:'',retryAction:''});
      setStatus('Retry queued. Your private upload will continue in the background.');
      if(active?.id===draft.id){retryButton.hidden=true;if(draft.retryAction==='publish'){publishStatus.hidden=false;publishStatus.textContent='Retry queued. We will place the photo at the top of the gallery after publishing completes.';}}
    }catch(error){setStatus(error.message||'Retry could not be queued.');}
  }

  async function uploadPhoto(file,{background=false}={}) {
    if(!file.size)throw new Error(`${file.name||'Photo'} is empty.`);
    if(file.size>MAX_BYTES)throw new Error(`${file.name||'Photo'} is larger than 24 MB.`);
    showFlow();
    const localPreview=background?'':URL.createObjectURL(file);
    if(!background){active=null;clearResult();setPreview(localPreview);setStatus('Uploading photo privately…');}
    const id=await photoId(file);
    const previous=drafts.get(id);
    let draft=saveDraft(previous||{id,token:newDraftToken(),filename:file.name||'phone-photo',status:'uploading',createdAt:new Date().toISOString()},{filename:file.name||previous?.filename||'phone-photo',status:'uploading',error:''});
    let response, payload;
    try {
      response=await fetch('/api/intakes',{method:'POST',headers:{
        'content-type':file.type||'application/octet-stream',
        'x-file-name':encodeURIComponent(file.name||'phone-photo'),
        'x-catalog-draft-token':draft.token
      },body:file});
      payload=await response.json().catch(()=>({}));
    } catch (error) {
      saveDraft(draft,{status:'upload-failed',error:error.message||'The upload connection was interrupted. Choose the same photo to resume.'});
      throw error;
    }
    if(payload.token)draft=saveDraft(draft,{id:payload.id||id,token:payload.token,status:payload.status||'queued',error:payload.error||''});
    if(payload.duplicate&&payload.status==='published'){
      const published=await getPublicItem(id);if(published)finishPublished(published);else forgetDraft(id);
      return {published:true};
    }
    if(!response.ok){
      const message=payload.error||`Upload failed (${response.status}).`;
      if(payload.token)saveDraft(draft,{status:payload.status==='queue-failed'?'queue-failed':'upload-failed',error:message});
      else saveDraft(draft,{status:'upload-failed',error:message});
      throw new Error(message);
    }
    if(!draft.token||!validDraft(draft)){
      saveDraft(draft,{status:'upload-failed',error:payload.error||'The private upload could not be created.'});
      throw new Error(payload.error||'The private upload could not be created.');
    }
    draft=saveDraft(draft,{status:payload.status||'queued',error:payload.error||''});
    if(!background){active=draft;await pollUntilReady(draft);}
    else scheduleRefresh();
    return {draft};
  }

  async function uploadCameraRoll(files) {
    if(!files.length)return;
    showFlow();setActivity(false);
    let next=0,uploaded=0;const errors=[];
    setStatus(`Uploading ${files.length} photo${files.length===1?'':'s'} privately. AI analysis will run in the background after each upload.`);
    async function uploadWorker(){
      while(next<files.length){
        const index=next++,file=files[index];
        setStatus(`Uploading photo ${index+1} of ${files.length}…`);
        try{await uploadPhoto(file,{background:true});uploaded++;}
        catch(error){errors.push(`${file.name||`Photo ${index+1}`}: ${error.message||'upload failed'}`);}
      }
    }
    await Promise.all(Array.from({length:Math.min(2,files.length)},()=>uploadWorker()));
    renderDraftList();
    setStatus(`${uploaded} of ${files.length} photo${files.length===1?'':'s'} uploaded. AI processing continues in the background; you can keep browsing and review each result here when ready.${errors.length?` ${errors.join(' ')}`:''}`);
    scheduleRefresh();
  }

  libraryInput.addEventListener('change',event=>{
    const files=[...(event.target.files||[])];event.target.value='';uploadCameraRoll(files);
  });
  cameraInput.addEventListener('change',async event=>{
    const file=event.target.files?.[0];event.target.value='';
    if(file)try{await uploadPhoto(file,{background:false});}catch(error){setActivity(false);setStatus(error.message||'The photo could not be uploaded.');}
  });

  $('clearContribution').addEventListener('click',()=>{
    active=null;clearResult();setPreview('');setActivity(false);
    setStatus('Result closed. Private uploads remain in your list and can be reviewed later.');
  });

  retryButton.addEventListener('click',()=>{if(active)retryDraft(active);});

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!active?.id || !active?.token || !active.result) {setPublishStatus('Wait until the complete identification and research result is ready.',true);return;}
    if (!nameInput.value.trim()) { nameInput.focus(); setPublishStatus('Enter a contributor name before adding this photo.',true);return; }
    addButton.disabled = true;
    addButton.textContent='Adding…';
    retryButton.hidden = true;
    setPublishStatus('Sending your contribution to the catalog…',true);
    try {
      const response = await fetch(`/api/intakes/${encodeURIComponent(active.id)}/publish`, {
        method: 'POST', headers: {'x-catalog-draft-token': active.token, 'content-type': 'application/json'},
        body: JSON.stringify({uploaderName: nameInput.value, category: categoryInput.value, tags: parseTags(tagsInput.value)})
      });
      const payload = await parseResponse(response);
      if (payload.status === 'published') {
        const published=await getPublicItem(active.id);if(published)finishPublished(published);
        else setPublishStatus('This exact photo is already in the public catalog.');
        return;
      }
      saveDraft(active,{status:'publishing',error:'',retryAction:''});
      addButton.textContent='Publishing…';
      nameInput.disabled=true;categoryInput.disabled=true;tagsInput.disabled=true;
      setPublishStatus('Added to the publishing queue. You can keep browsing; the photo will appear at the top of the gallery when publishing finishes.');
      setStatus('Your photo is being added to the public catalog.');
      scheduleRefresh();
    } catch (error) {
      setPublishStatus(error.message || 'The contribution could not be added. Try again.');
      addButton.disabled = false;
      addButton.textContent='Add to catalog';
    }
  });

  function setPublishStatus(message,reveal=false){publishStatus.hidden=false;publishStatus.textContent=message;if(reveal)publishStatus.scrollIntoView({block:'nearest',behavior:'smooth'});}

  restoreDrafts();renderDraftList();syncActivity();
  if(drafts.size){showFlow();setStatus('Restoring private uploads from this browser…');refreshDrafts();}
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshDrafts();});
})();
