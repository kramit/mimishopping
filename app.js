(() => {
  const data = window.CATALOG_DATA || {categories: [], images: []};
  const $ = id => document.getElementById(id);
  const gallery = $('gallery'), productsView = $('productsView'), search = $('search'), category = $('category'), tag = $('tag'), trip = $('trip'), year = $('year'), researchStatus = $('researchStatus'), needsReview = $('needsReview');
  const detail = $('detail');
  const overrideKey = 'mimi-japan-shopping-tag-overrides-v1';
  const reviewKey = 'mimi-japan-shopping-review-checks-v1';
  const imageIds = new Set(data.images.map(x => x.id));
  const clean = value => String(value ?? '').toLocaleLowerCase();
  const unique = values => [...new Set(values.filter(Boolean))].sort((a,b) => String(a).localeCompare(String(b)));
  const pageSize = 48;
  let tagOverrides = readOverrides();
  const localOverridesOnLoad = {...tagOverrides};
  let overrideEtags = {};
  let canEditTags = false;
  let signedIn = false;
  let reviewChecks = readReviewChecks();
  let showAllTags = false;
  let currentView = 'photos';
  let currentPage = 0;

  function normalizeTags(values) {
    const source = Array.isArray(values) ? values : String(values ?? '').split(/[\n,;]/);
    const seen = new Set(), result = [];
    for (const raw of source) {
      const value = String(raw ?? '').trim().replace(/\s+/g, ' ').slice(0, 64);
      const key = value.toLocaleLowerCase();
      if (value && !seen.has(key) && result.length < 80) { seen.add(key); result.push(value); }
    }
    return result;
  }
  function readOverrides() {
    try {
      const parsed = JSON.parse(localStorage.getItem(overrideKey) || '{}');
      const source = parsed?.tagOverrides && typeof parsed.tagOverrides === 'object' ? parsed.tagOverrides : parsed;
      const safe = {};
      for (const [id, values] of Object.entries(source || {})) {
        if (imageIds.has(id) && Array.isArray(values)) safe[id] = normalizeTags(values);
      }
      return safe;
    } catch { return {}; }
  }
  function saveOverrides() {
    try { localStorage.setItem(overrideKey, JSON.stringify(tagOverrides)); return true; }
    catch { return false; }
  }
  function assetUrl(path) {
    const raw = String(path || '');
    if (/^https?:\/\//i.test(raw)) return raw;
    const relative = raw.replace(/^(\.\.\/)+/, '');
    const mappings = [['Photos/', 'photos/', window.MIMI_ASSET_BASE], ['Catalog/thumbnails/', 'thumbnails/', window.MIMI_ASSET_BASE], ['Catalog/previews/', 'previews/', window.MIMI_ASSET_BASE], ['Catalog/optimized-v1/', 'optimized-v1/', window.MIMI_ASSET_BASE], ['Contributions/', '', window.MIMI_CONTRIBUTION_ASSET_BASE]];
    const mapping = mappings.find(([prefix]) => relative.startsWith(prefix));
    const base = String(mapping?.[2] || '').replace(/\/+$/, '');
    if (!base || !mapping) return raw;
    const objectPath = mapping[1] + relative.slice(mapping[0].length);
    return `${base}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
  }
  function responsiveImage(image, variant, alt, className = '') {
    const prefix = variant === 'thumb' ? 'thumb' : 'display';
    const fallback = assetUrl(image?.[prefix] || image?.image || '');
    const webp = image?.[`${prefix}Webp`];
    const picture = document.createElement('picture');
    if (webp) {
      const source = document.createElement('source');
      source.type = 'image/webp'; source.srcset = assetUrl(webp); picture.append(source);
    }
    const img = document.createElement('img');
    img.src = fallback; img.alt = alt || ''; img.decoding = 'async';
    if (className) img.className = className;
    picture.append(img);
    return picture;
  }
  function saveImageLink(image) {
    const path = image?.download || image?.image;
    if (!path) return null;
    const link = document.createElement('a');
    const url = new URL(assetUrl(path), window.location.href);
    url.searchParams.set('mimi-download', '1');
    link.href = url.href; link.download = image.downloadFilename || image.filename || 'mimi-japan-shopping-image';
    link.className = 'button button-primary save-image'; link.textContent = 'Save Image';
    return link;
  }
  function readReviewChecks() {
    try {
      const parsed=JSON.parse(localStorage.getItem(reviewKey)||'[]');
      return new Set(Array.isArray(parsed)?parsed.filter(id=>imageIds.has(id)):[]);
    } catch { return new Set(); }
  }
  function saveReviewChecks() {
    try { localStorage.setItem(reviewKey, JSON.stringify([...reviewChecks])); return true; }
    catch { return false; }
  }
  const needsAttention = image => ['needs human review','needs closer inspection'].includes(image.reviewStatus);
  function updateReviewLabel() {
    const open=data.images.filter(x=>needsAttention(x)&&!reviewChecks.has(x.id)).length;
    $('reviewToggleLabel').textContent=`Photo review only (${open} open)`;
  }
  function refreshDerivedData() {
    productGroups = buildProductGroups(data.images);
    browseTagCount = new Set(data.images.flatMap(x => (x.tags || []).filter(tag => !/^Contributor:/i.test(tag)))).size;
    $('summary').textContent = `${data.images.length} photos · ${productGroups.length} product groups · ${browseTagCount} browse tags`;
    const knownTrips = new Set([...trip.options].map(option => option.value));
    for (const image of data.images) {
      imageIds.add(image.id);
      const label = image.trip || (image.year ? `${image.year} · date unknown` : 'Date unknown');
      if (!knownTrips.has(label)) { trip.add(new Option(label, label)); knownTrips.add(label); }
      if (image.year && ![...year.options].some(option => option.value === image.year)) year.add(new Option(image.year, image.year));
    }
  }
  function effectiveTags(image) {
    return Object.prototype.hasOwnProperty.call(tagOverrides, image.id) ? tagOverrides[image.id] : (image.tags || []);
  }
  function announce(message) { $('tagStatus').textContent = message; }
  function setEditorAccess(principal) {
    const roles = Array.isArray(principal?.userRoles) ? principal.userRoles : [];
    signedIn = roles.includes('authenticated');
    canEditTags = roles.includes('catalog_editor');
    $('editorLogin').hidden = canEditTags;
    $('editorLogout').hidden = !signedIn;
    $('exportTags').hidden = !canEditTags;
    $('importTags').hidden = !canEditTags;
    const pending = Object.keys(localOverridesOnLoad).filter(id => !Object.hasOwn(overrideEtags, id)).length;
    $('tagStorageHint').textContent = canEditTags
      ? `${pending ? `${pending} browser-local tag edit(s) are not in the shared catalog; import a backup to sync them. ` : ''}Tag edits sync for all visitors. Photo review checks remain local to this browser.`
      : 'Browsing is public. Sign in with Mimi’s editor account to change shared tags.';
  }
  async function refreshSharedOverrides() {
    try {
      const [profileResponse, overridesResponse] = await Promise.all([fetch('/.auth/me'), fetch('/api/tag-overrides')]);
      let principal = null;
      if (profileResponse.ok) principal = (await profileResponse.json())?.clientPrincipal || null;
      if (!overridesResponse.ok) throw new Error(`Tag service returned ${overridesResponse.status}`);
      const payload = await overridesResponse.json();
      const shared = {}, etags = {};
      for (const [id, entry] of Object.entries(payload.overrides || {})) {
        if (!imageIds.has(id) || !Array.isArray(entry?.tags)) continue;
        shared[id] = normalizeTags(entry.tags);
        if (typeof entry.etag === 'string') etags[id] = entry.etag;
      }
      overrideEtags = etags;
      tagOverrides = {...localOverridesOnLoad, ...shared};
      saveOverrides();
      setEditorAccess(principal);
      renderTagTools(); render();
      if (Object.keys(localOverridesOnLoad).some(id => !Object.hasOwn(overrideEtags, id))) {
        announce('This browser has older local tag edits. Sign in and import an exported backup to add them to the shared catalog.');
      }
    } catch (error) {
      setEditorAccess(null);
      announce(`Shared tag edits could not be loaded: ${error.message}`);
    }
  }
  async function saveSharedOverrides(items) {
    if (!canEditTags) throw new Error('Sign in with the editor account to change shared tags.');
    const response = await fetch('/api/tag-overrides/save-many', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({items: items.map(item => ({...item, etag: overrideEtags[item.imageId] || null}))})
    });
    const payload = await response.json().catch(() => ({}));
    for (const result of payload.results || []) {
      if (result.cleared) {
        delete tagOverrides[result.imageId]; delete overrideEtags[result.imageId];
      } else if (Array.isArray(result.tags)) {
        tagOverrides[result.imageId] = normalizeTags(result.tags);
        if (typeof result.etag === 'string') overrideEtags[result.imageId] = result.etag;
      }
    }
    saveOverrides();
    if (!response.ok) throw new Error(payload.error || `Save failed (${response.status}). Reload the gallery if another editor changed these tags.`);
    return payload.results || [];
  }

  function normalizedProductKey(product) {
    const identity = [product.brand, product.name, product.variant].filter(Boolean).join(' ')
      || product.description || '';
    return identity.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function buildProductGroups(images) {
    const groups = new Map();
    for (const image of images) for (const product of image.products || []) {
      const key = normalizedProductKey(product);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, {key, product, products: [], images: new Map()});
      const group = groups.get(key);
      if (!group.products.some(x => JSON.stringify(x) === JSON.stringify(product))) group.products.push(product);
      if (image.id && !group.images.has(image.id)) group.images.set(image.id, image);
      const rank = p => ({matched:4,partial:3,unmatched:2,pending:1}[p?.webResearch?.status || 'pending'] || 0);
      if (rank(product) > rank(group.product)) group.product = product;
    }
    return [...groups.values()].map(group => ({...group, images:[...group.images.values()]}))
      .sort((a,b) => productTitle(a.product).localeCompare(productTitle(b.product)));
  }
  function productTitle(product) {
    return [product.brand,product.name,product.variant].filter(Boolean).join(' — ') || product.description || 'Unidentified product';
  }
  let productGroups = buildProductGroups(data.images);
  let browseTagCount = new Set(data.images.flatMap(x => (x.tags || []).filter(tag => !/^Contributor:/i.test(tag)))).size;
  const researchLabels = {matched:'Matched',partial:'Partial',pending:'Pending',unmatched:'No match'};
  function imageResearchStatuses(image) {
    const statuses=unique((image.products || []).map(p => p.webResearch?.status || 'pending'))
      .filter(status => Object.hasOwn(researchLabels,status));
    return statuses.length?statuses:['pending'];
  }
  function researchBadge(status) {
    const badge = document.createElement('span');
    badge.className = `research-badge research-${status}`;
    badge.textContent = researchLabels[status] || 'Pending';
    return badge;
  }
  function addResearchBadges(parent, statuses) {
    if (!statuses.length) statuses = ['pending'];
    const wrap = document.createElement('div'); wrap.className = 'research-badges';
    for (const status of statuses) wrap.append(researchBadge(status));
    parent.append(wrap);
  }

  for (const value of data.categories) category.add(new Option(value,value));
  const tripDateByLabel=new Map();
  for(const image of data.images){const label=image.trip||(image.year?`${image.year} · date unknown`:'Date unknown');if(image.capturedDate&&(!tripDateByLabel.get(label)||image.capturedDate>tripDateByLabel.get(label)))tripDateByLabel.set(label,image.capturedDate);}
  const tripLabels=unique(data.images.map(x=>x.trip||(x.year?`${x.year} · date unknown`:'Date unknown')))
    .sort((a,b)=>(tripDateByLabel.get(b)||'').localeCompare(tripDateByLabel.get(a)||'')||b.localeCompare(a));
  for (const value of tripLabels) trip.add(new Option(value,value));
  for (const value of unique(data.images.map(x => x.year))) year.add(new Option(value,value));
  $('summary').textContent = `${data.images.length} photos · ${productGroups.length} product groups · ${browseTagCount} browse tags`;
  $('tagStorageHint').textContent = 'Loading shared tag edits…';
  updateReviewLabel();

  function renderTagTools() {
    const selected = tag.value;
    const counts = new Map();
    for (const image of data.images) for (const value of unique(effectiveTags(image))) counts.set(value, (counts.get(value) || 0) + 1);
    const values = [...counts.keys()].sort((a,b) => a.localeCompare(b));
    tag.replaceChildren(new Option('All tags',''));
    for (const value of values) tag.add(new Option(value,value));
    tag.value = counts.has(selected) ? selected : '';

    const cloud = $('tagCloud');
    cloud.replaceChildren();
    const ranked = [...counts.entries()].filter(([value]) => !/^Contributor:/i.test(value)).sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
    const visible = showAllTags ? ranked : ranked.slice(0,60);
    if (tag.value && !visible.some(([value]) => value === tag.value)) visible.push([tag.value,counts.get(tag.value)]);
    for (const [value,count] of visible) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'cloud-tag';
      button.setAttribute('aria-pressed', String(tag.value === value));
      button.style.setProperty('--tag-size', `${12 + Math.min(9, Math.log2(count + 1) * 2.1)}px`);
      button.append(document.createTextNode(value));
      const total = document.createElement('span'); total.className = 'cloud-count'; total.textContent = String(count); button.append(total);
      button.addEventListener('click', () => { tag.value = tag.value === value ? '' : value; currentPage=0; renderTagTools(); render(); });
      cloud.append(button);
    }
    $('tagCloudSummary').textContent = showAllTags ? `All ${ranked.length} product tags · ${data.images.length} photos` : `Top 60 of ${ranked.length} product tags · ${data.images.length} photos`;
    const expand = $('expandTagCloud');
    expand.hidden = ranked.length <= 60;
    expand.textContent = showAllTags ? 'Show top tags' : `Show all ${ranked.length} tags`;
  }

  function matches(x) {
    const q = clean(search.value).trim(), tags = effectiveTags(x);
    const haystack = clean([x.filename,x.description,x.category,x.year,x.uploadedBy,...tags,...(x.searchTerms||[]),...(x.products||[]).flatMap(p=>[
      p.name,p.brand,p.variant,p.description,p.webResearch?.productSummary,p.webResearch?.reviewSummary?.summary,
      p.webResearch?.observedPrice,p.webResearch?.statusNote,
      ...(p.webResearch?.stores||[]).map(s=>s.name),...(p.webResearch?.translations||[]).flatMap(t=>[t.text,t.english])
    ]),...(x.japaneseText||[]).flatMap(t=>[t.text,t.translation])].join(' '));
    const statuses = imageResearchStatuses(x);
    return (!q || haystack.includes(q)) && (!category.value || x.category === category.value) &&
      (!tag.value || tags.includes(tag.value)) && (!trip.value || (x.trip || (x.year ? `${x.year} · date unknown` : 'Date unknown')) === trip.value) &&
      (!year.value || x.year === year.value) && (!researchStatus.value || statuses.includes(researchStatus.value)) &&
      (!needsReview.checked || (needsAttention(x) && !reviewChecks.has(x.id)));
  }
  function card(x) {
    const el = document.createElement('article'); el.className = 'card'; el.tabIndex = 0; el.setAttribute('role','button');
    const picture = responsiveImage(x, 'thumb', x.description || x.filename); const img=picture.querySelector('img'); img.loading = 'lazy';
    const body = document.createElement('div'); body.className = 'card-body';
    const title = (x.products||[]).map(p=>p.name).filter(Boolean).slice(0,2).join(' · ') || x.description || 'Catalog review pending';
    const heading = document.createElement('p'); heading.className='card-title'; heading.textContent=title;
    const meta = document.createElement('div'); meta.className='meta'; meta.textContent=[x.trip,x.category,x.uploadedBy?`Contributed by ${x.uploadedBy}`:'',x.filename].filter(Boolean).join(' · ');
    body.append(heading,meta);
    const tags = effectiveTags(x);
    if (tags.length) {const chips=document.createElement('div');chips.className='chips';tags.slice(0,5).forEach(t=>{const c=document.createElement('span');c.className='chip';c.textContent=t;chips.append(c)});body.append(chips)}
    addResearchBadges(body,imageResearchStatuses(x));
    if (['needs human review','needs closer inspection'].includes(x.reviewStatus)) {const s=document.createElement('div');s.className='status';s.textContent=x.reviewStatus;body.append(s)}
    el.append(picture,body); el.addEventListener('click',()=>openDetail(x)); el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openDetail(x)}}); return el;
  }
  function productCard(group) {
    const el=document.createElement('article');el.className='product-card';
    const coverPicture=responsiveImage((group.visibleImages[0]||group.images[0]),'thumb',productTitle(group.product));const cover=coverPicture.querySelector('img');cover.loading='lazy';
    const body=document.createElement('div');body.className='product-card-body';
    const title=document.createElement('h3');title.textContent=productTitle(group.product);
    const meta=document.createElement('p');meta.className='meta';
    const categories=unique(group.visibleImages.map(x=>x.category));
    const total=group.images.length, visible=group.visibleImages.length;
    meta.textContent=`${visible===total?total:`${visible} of ${total}`} photo${total===1?'':'s'}${categories.length?` · ${categories.join(', ')}`:''}`;
    body.append(title,meta);
    const statuses=unique(group.products.map(p=>p.webResearch?.status||'pending')).filter(s=>Object.hasOwn(researchLabels,s));
    addResearchBadges(body,statuses);
    const action=document.createElement('button');action.type='button';action.className='button button-quiet product-open';action.textContent='View photos and research';
    action.addEventListener('click',()=>openProductDetail(group));
    el.append(coverPicture,body,action);return el;
  }
  function renderReviewQueue() {
    const items=data.images.filter(needsAttention);
    $('reviewQueuePanel').hidden=!items.length;
    const checked=items.filter(x=>reviewChecks.has(x.id)).length,open=items.length-checked;
    $('reviewQueueSummary').textContent=`Photo review queue · ${open} open · ${checked} checked (${items.length} total)`;
    const list=$('reviewQueueList');list.replaceChildren();
    for(const image of items){
      const row=document.createElement('div');row.className=`review-queue-item${reviewChecks.has(image.id)?' review-checked':''}`;
      const button=document.createElement('button');button.type='button';button.className='review-queue-open';
      const thumbPicture=responsiveImage(image,'thumb','');const thumb=thumbPicture.querySelector('img');thumb.loading='lazy';
      const text=document.createElement('span');text.className='review-queue-text';
      const filename=document.createElement('strong');filename.textContent=image.filename;
      const note=document.createElement('span');note.textContent=`${reviewChecks.has(image.id)?'Checked locally · ':''}${image.reviewStatus}${image.notes?` · ${image.notes}`:''}`;
      text.append(filename,note);button.append(thumbPicture,text);button.addEventListener('click',()=>openDetail(image));
      const check=document.createElement('button');check.type='button';check.className='button button-quiet review-check-button';
      check.textContent=reviewChecks.has(image.id)?'Undo check':'Mark checked';
      check.setAttribute('aria-label',`${reviewChecks.has(image.id)?'Undo local check for':'Mark checked locally'} ${image.filename}`);
      check.addEventListener('click',()=>setReviewChecked(image,!reviewChecks.has(image.id)));
      row.append(button,check);list.append(row);
    }
  }
  function setReviewChecked(image,checked) {
    if(checked)reviewChecks.add(image.id);else reviewChecks.delete(image.id);
    const stored=saveReviewChecks();
    updateReviewLabel();renderReviewQueue();render();
    announce(`${checked?'Marked':'Reopened'} ${image.filename} ${stored?'in this browser.':'for this page only; export local edits before closing.'}`);
    if(detail.open&&$('detailContent').dataset.imageId===image.id)openDetail(image);
  }
  function updatePagination(total) {
    const pages=Math.max(1,Math.ceil(total/pageSize));
    currentPage=Math.min(currentPage,pages-1);
    const nav=$('pagination');nav.hidden=total<=pageSize;
    $('previousPage').disabled=currentPage===0;
    $('nextPage').disabled=currentPage>=pages-1;
    $('pageSummary').textContent=`Page ${currentPage+1} of ${pages}`;
  }
  function render() {
    const found=data.images.filter(matches);
    if(currentView==='photos'){
      gallery.hidden=false;productsView.hidden=true;
      const start=currentPage*pageSize, page=found.slice(start,start+pageSize);
      gallery.replaceChildren(...page.map(card));
      $('resultCount').textContent=found.length?`Showing ${start+1}–${Math.min(start+pageSize,found.length)} of ${found.length} photos`:'No photos match these filters';
      $('empty').hidden=found.length>0;updatePagination(found.length);return;
    }
    gallery.hidden=true;productsView.hidden=false;
    const groups=productGroups.map(group=>({...group,visibleImages:group.images.filter(matches)})).filter(group=>group.visibleImages.length);
    const matchingPhotoCount=groups.reduce((n,group)=>n+group.visibleImages.length,0);
    const start=currentPage*pageSize,page=groups.slice(start,start+pageSize);
    productsView.replaceChildren(...page.map(productCard));
    $('resultCount').textContent=groups.length?`Showing ${start+1}–${Math.min(start+pageSize,groups.length)} of ${groups.length} product groups · ${matchingPhotoCount} matching photos`:'No products match these filters';
    $('empty').hidden=groups.length>0;updatePagination(groups.length);
  }
  function appendLinks(parent, label, rows) {
    if (!rows?.length) return;
    const wrap=document.createElement('p'); wrap.className='research-links';
    const heading=document.createElement('strong'); heading.textContent=`${label}: `; wrap.append(heading);
    rows.forEach((row,i)=>{
      if(i) wrap.append(document.createTextNode(' · '));
      const title=row.name||row.title||'Source';
      try {
        const url=new URL(row.url);
        if(!['https:','http:'].includes(url.protocol)) throw new Error('unsafe scheme');
        const link=document.createElement('a'); link.href=url.href; link.target='_blank'; link.rel='noopener noreferrer'; link.textContent=title; wrap.append(link);
      } catch { wrap.append(document.createTextNode(title)); }
      const detailText=[row.observedPrice,row.purpose].filter(Boolean).join(' · ');
      if(detailText){wrap.append(document.createTextNode(` (${detailText})`))}
    });
    parent.append(wrap);
  }
  function productBlock(product) {
    const item=document.createElement('section'); item.className='product-block';
    const title=document.createElement('h4'); title.textContent=[product.brand,product.name,product.variant].filter(Boolean).join(' — '); item.append(title);
    if(product.identifiedBy){const by=document.createElement('p');by.className='identified-by';by.textContent=`Photo identification: ${product.identifiedBy}`;item.append(by)}
    if(product.description){const d=document.createElement('p');d.textContent=product.description;item.append(d)}
    const research=product.webResearch;
    if(!research) {addResearchBadges(item,['pending']);const missing=document.createElement('p');missing.className='research-status';missing.textContent='Web research has not been linked to this product yet.';item.append(missing);return item;}
    const box=document.createElement('div'); box.className='web-research';
    const heading=document.createElement('h5'); heading.textContent=`Web research${research.checkedDate?` · checked ${research.checkedDate}`:''}`; box.append(heading);
    addResearchBadges(box,[research.status||'pending']);
    if(research.status && research.status!=='matched'){
      const status=document.createElement('p');status.className='research-status';
      status.textContent=research.statusNote||(research.status==='unmatched'?'No reliable current product-page match was found.':research.status==='pending'?'Web research is pending.':'Only a partial or variant-level match was found.');box.append(status);
    }
    if(research.productSummary){const p=document.createElement('p');p.textContent=research.productSummary;box.append(p)}
    if(research.priceRange){
      const range=research.priceRange, p=document.createElement('p'), currency=range.currency==='JPY'?'¥':(range.currency||'');
      const amount=range.min===range.max?`${currency}${range.min}`:`${currency}${range.min}–${currency}${range.max}`;
      p.textContent=`Observed price: ${amount}${range.basis?` (${range.basis})`:''}`;box.append(p);
    }
    if(research.observedPrice){const p=document.createElement('p');p.textContent=`Observed price: ${research.observedPrice}`;box.append(p)}
    appendLinks(box,'Likely stores',research.stores);
    if(research.reviewSummary){
      const reviews=research.reviewSummary,p=document.createElement('p');p.className='review-summary';
      const rating=reviews.rating&&reviews.rating!=='unavailable'?`${reviews.rating}${reviews.count?` · ${reviews.count} reviews`:''}. `:'';
      p.textContent=`Customer reviews: ${rating}${reviews.summary||'No review summary is recorded.'}`;box.append(p);
      appendLinks(box,'Review sources',reviews.sources);
    }
    if(research.translations?.length){
      const sub=document.createElement('h6');sub.textContent='Japanese from product pages, translated';box.append(sub);
      research.translations.forEach(entry=>{const p=document.createElement('p');p.className='translation';p.textContent=[entry.text,entry.english].filter(Boolean).join(' — ');box.append(p)});
    }
    appendLinks(box,'Product sources',research.sources);
    item.append(box);return item;
  }
  function tagEditor(image, parent) {
    if (!canEditTags) return;
    const head=document.createElement('h3');head.textContent='Tags';parent.append(head);
    const list=document.createElement('div');list.className='chips detail-chips';
    const values=effectiveTags(image);
    if(values.length) values.forEach(value=>{const chip=document.createElement('span');chip.className='chip';chip.textContent=value;list.append(chip)});
    else {const empty=document.createElement('p');empty.className='meta';empty.textContent='No tags yet.';list.append(empty)}
    parent.append(list);
    const edit=document.createElement('button');edit.type='button';edit.className='button button-quiet';edit.textContent='Edit tags';parent.append(edit);
    edit.addEventListener('click',()=>{
      edit.remove(); list.remove();
      const form=document.createElement('form');form.className='tag-editor';
      const label=document.createElement('label');label.textContent='Tags, separated by commas';
      const input=document.createElement('textarea');input.rows=3;input.value=values.join(', ');input.setAttribute('aria-label','Image tags, separated by commas');
      label.append(input);
      const actions=document.createElement('div');actions.className='tag-editor-actions';
      const save=document.createElement('button');save.type='submit';save.className='button button-primary';save.textContent='Save tags';actions.append(save);
      if(Object.prototype.hasOwnProperty.call(tagOverrides,image.id)){
        const reset=document.createElement('button');reset.type='button';reset.className='button button-quiet';reset.textContent='Restore catalog tags';
        reset.addEventListener('click',async()=>{
          reset.disabled=true;
          try {
            await saveSharedOverrides([{imageId:image.id,tags:null}]);
            announce('Restored the catalog tags for all visitors.');
            renderTagTools(); render(); detail.close(); openDetail(image);
          } catch(error) { announce(error.message); reset.disabled=false; }
        }); actions.append(reset);
      }
      form.append(label,actions);parent.append(form);
      form.addEventListener('submit',async event=>{
        event.preventDefault(); save.disabled=true;
        try {
          await saveSharedOverrides([{imageId:image.id,tags:normalizeTags(input.value)}]);
          announce('Tags saved to the shared catalog.');
          renderTagTools();render();detail.close();openDetail(image);
        } catch(error) { announce(error.message); save.disabled=false; }
      });
      input.focus();
    });
  }
  async function applyBulkTags(group,mode,rawTags) {
    const changes=normalizeTags(rawTags);
    if(!changes.length){announce('Enter at least one tag first.');return;}
    const keys=new Set(changes.map(x=>x.toLocaleLowerCase()));
    const items=[];
    for(const image of group.images){
      const current=effectiveTags(image);
      const next=mode==='remove'?current.filter(x=>!keys.has(x.toLocaleLowerCase())):normalizeTags([...current,...changes]);
      items.push({imageId:image.id,tags:next});
    }
    try {
      for(let i=0;i<items.length;i+=25) await saveSharedOverrides(items.slice(i,i+25));
      renderTagTools();render();openProductDetail(group);
      announce(`${mode==='remove'?'Removed':'Added'} tag${changes.length===1?'':'s'} ${mode==='remove'?'from':'to'} ${group.images.length} photo${group.images.length===1?'':'s'} in the shared catalog.`);
    } catch(error) { announce(error.message); }
  }
  function openProductDetail(group) {
    const holder=$('detailContent');holder.replaceChildren();
    const representative=group.images[0];
    const image=responsiveImage(representative,'display',productTitle(group.product),'detail-image');
    const info=document.createElement('div');info.className='detail-info product-detail-info';
    const h=document.createElement('h2');h.textContent=productTitle(group.product);info.append(h);
    const meta=document.createElement('p');meta.className='detail-meta';meta.textContent=`${group.images.length} related photo${group.images.length===1?'':'s'} · ${unique(group.images.map(x=>x.trip)).join(', ')}`;info.append(meta);
    const save=saveImageLink(representative);if(save)info.append(save);
    const productSet=new Set();
    for(const photo of group.images)for(const product of photo.products||[]){if(normalizedProductKey(product)===group.key)productSet.add(JSON.stringify(product));}
    const productList=document.createElement('div');productList.className='product-list';
    for(const raw of productSet)productList.append(productBlock(JSON.parse(raw)));
    if(productList.childElementCount){const heading=document.createElement('h3');heading.textContent='Product details and web research';info.append(heading,productList)}
    if (canEditTags) {
    const bulkHeading=document.createElement('h3');bulkHeading.textContent=`Edit tags across all ${group.images.length} photos`;info.append(bulkHeading);
    const form=document.createElement('form');form.className='bulk-tag-editor';
    const label=document.createElement('label');label.textContent='Tags, separated by commas';
    const input=document.createElement('textarea');input.rows=2;input.placeholder='e.g. sheet mask, vitamin C';input.setAttribute('aria-label','Tags to add or remove across all photos');label.append(input);
    const actions=document.createElement('div');actions.className='bulk-tag-actions';
    const mode=document.createElement('select');mode.setAttribute('aria-label','Bulk tag action');mode.add(new Option('Add tags','add'));mode.add(new Option('Remove tags','remove'));
    const apply=document.createElement('button');apply.type='submit';apply.className='button button-primary';apply.textContent='Apply to every photo';actions.append(mode,apply);
    const hint=document.createElement('p');hint.className='meta';hint.textContent='Changes are shared with every visitor.';
    form.append(label,actions,hint);info.append(form);
    form.addEventListener('submit',event=>{event.preventDefault();applyBulkTags(group,mode.value,input.value.split(/[\n,;]/));});
    }
    const photoHeading=document.createElement('h3');photoHeading.textContent='Photos in this group';info.append(photoHeading);
    const photoGrid=document.createElement('div');photoGrid.className='related-photo-list';
    for(const photo of group.images){
      const button=document.createElement('button');button.type='button';button.className='related-photo';
      const thumbPicture=responsiveImage(photo,'thumb','');const thumb=thumbPicture.querySelector('img');thumb.loading='lazy';
      const caption=document.createElement('span');caption.textContent=[photo.trip,photo.filename].filter(Boolean).join(' · ');
      button.append(thumbPicture,caption);button.addEventListener('click',()=>openDetail(photo));photoGrid.append(button);
    }
    info.append(photoGrid);holder.append(image,info);if(!detail.open)detail.showModal();
  }
  function openDetail(x) {
    const holder=$('detailContent'); holder.replaceChildren();
    holder.dataset.imageId=x.id;
    const image=responsiveImage(x,'display',x.description||x.filename,'detail-image');
    const info=document.createElement('div'); info.className='detail-info';
    const h=document.createElement('h2'); h.textContent=(x.products||[]).map(p=>p.name).filter(Boolean).join(' · ')||'Image details'; info.append(h);
    const p=document.createElement('p'); p.className='detail-meta'; p.textContent=[x.trip,x.category,x.uploadedBy?`Contributed by ${x.uploadedBy}`:'',x.filename].filter(Boolean).join(' · '); info.append(p);
    const save=saveImageLink(x);if(save)info.append(save);
    if(x.description){const d=document.createElement('p');d.textContent=x.description;info.append(d)}
    if(needsAttention(x)){
      const review=document.createElement('section');review.className='review-detail';
      const note=document.createElement('p');note.textContent=`Catalog status: ${x.reviewStatus}. This local check does not change the catalog ledger.`;
      const button=document.createElement('button');button.type='button';button.className='button button-quiet';
      button.textContent=reviewChecks.has(x.id)?'Undo local check':'Mark checked in this browser';
      button.addEventListener('click',()=>setReviewChecked(x,!reviewChecks.has(x.id)));
      review.append(note,button);info.append(review);
    }
    tagEditor(x,info);
    if (canEditTags && x.isContribution) {
      const moderation=document.createElement('section');moderation.className='review-detail';
      const note=document.createElement('p');note.textContent='Hide this community contribution from the public catalog and remove its public photo.';
      const hide=document.createElement('button');hide.type='button';hide.className='button button-quiet';hide.textContent='Hide contribution';
      hide.addEventListener('click',async()=>{
        if(!window.confirm('Hide this contribution from the catalog and remove its photo?'))return;
        hide.disabled=true;
        try{
          const response=await fetch(`/api/catalog-items/${encodeURIComponent(x.id)}/hide`,{method:'POST'});
          const payload=await response.json().catch(()=>({}));
          if(!response.ok)throw new Error(payload.error||`Hide failed (${response.status}).`);
          const index=data.images.findIndex(image=>image.id===x.id);if(index>=0)data.images.splice(index,1);
          imageIds.delete(x.id);delete tagOverrides[x.id];delete overrideEtags[x.id];saveOverrides();
          refreshDerivedData();updateReviewLabel();detail.close();renderTagTools();renderReviewQueue();render();
          announce('Contribution hidden from the catalog.');
        }catch(error){announce(error.message);hide.disabled=false;}
      });
      moderation.append(note,hide);info.append(moderation);
    }
    if(x.products?.length){const head=document.createElement('h3');head.textContent='Products';info.append(head);const list=document.createElement('div');list.className='product-list';x.products.forEach(v=>list.append(productBlock(v)));info.append(list)}
    if(x.japaneseText?.length){const head=document.createElement('h3');head.textContent='Japanese packaging text with English translations';info.append(head);x.japaneseText.forEach(v=>{const line=document.createElement('p');line.className='translation';line.textContent=[v.text,v.translation].filter(Boolean).join(' — ');info.append(line)})}
    // Raw OCR is retained for internal search, but can contain untranslated Japanese.
    // Show only reviewed text/translation pairs above.
    if(x.notes){const n=document.createElement('p');n.textContent=`Review note: ${x.notes}`;info.append(n)}
    holder.append(image,info); if(!detail.open) detail.showModal();
  }
  function exportEdits() {
    const payload={format:overrideKey,exportedAt:new Date().toISOString(),tagOverrides,reviewCheckedIds:[...reviewChecks]};
    const blob=new Blob([JSON.stringify(payload,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob);
    const link=document.createElement('a');link.href=url;link.download='mimi-japan-shopping-local-edits.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    announce(`Exported ${Object.keys(tagOverrides).length} tag override(s) and ${reviewChecks.size} local review check(s).`);
  }
  $('exportTags').addEventListener('click',exportEdits);
  $('expandTagCloud').addEventListener('click',()=>{showAllTags=!showAllTags;renderTagTools()});
  $('importTags').addEventListener('click',()=>$('importTagsFile').click());
  $('importTagsFile').addEventListener('change',async event=>{
    const file=event.target.files?.[0];if(!file)return;
    try {
      const parsed=JSON.parse(await file.text());
      if(parsed.format!==overrideKey||!parsed.tagOverrides||typeof parsed.tagOverrides!=='object'||Array.isArray(parsed.tagOverrides))throw new Error('This is not a Mimi Japan shopping tag backup.');
      if(!canEditTags)throw new Error('Sign in with the editor account before importing tag edits.');
      const imported={};let ignored=0;
      for(const [id,values] of Object.entries(parsed.tagOverrides)){
        if(!imageIds.has(id)||!Array.isArray(values)){ignored++;continue;}
        imported[id]=normalizeTags(values);
      }
      const items=Object.entries(imported).map(([imageId,tags])=>({imageId,tags}));
      for(let i=0;i<items.length;i+=25) await saveSharedOverrides(items.slice(i,i+25));
      if(Array.isArray(parsed.reviewCheckedIds))reviewChecks=new Set(parsed.reviewCheckedIds.filter(id=>imageIds.has(id)));
      const storedReview=saveReviewChecks();renderTagTools();updateReviewLabel();renderReviewQueue();render();
      announce(`Synced ${Object.keys(imported).length} image tag edit(s) to the shared catalog and imported ${reviewChecks.size} local review check(s)${ignored?`; skipped ${ignored} unrecognized entr${ignored===1?'y':'ies'}`:''}${storedReview?'.':'; export review checks before closing.'}`);
    } catch(error) { announce(`Could not import tag edits: ${error.message}`); }
    event.target.value='';
  });

  async function loadCommunityCatalog() {
    try {
      const response=await fetch('/api/catalog-items',{cache:'no-store'});
      if(!response.ok)return;
      const payload=await response.json();
      const existing=new Set(data.images.map(image=>image.id));
      for(const image of Array.isArray(payload.images)?payload.images:[]){
        if(!image?.id||existing.has(image.id))continue;
        data.images.push(image);existing.add(image.id);
      }
      refreshDerivedData();updateReviewLabel();renderTagTools();renderReviewQueue();render();
    }catch{}
  }

  window.addEventListener('mimi-catalog-item-published',event=>{
    const image=event.detail;
    if(!image?.id||imageIds.has(image.id))return;
    data.images.push(image);refreshDerivedData();updateReviewLabel();
    category.value='';trip.value='';year.value='';researchStatus.value='';needsReview.checked=false;
    search.value=image.uploadedBy||'';
    tag.value=(image.tags||[]).find(value=>/^Contributor:/i.test(value))||'';
    currentView='photos';currentPage=0;
    $('photosViewButton').className='button button-primary';$('productsViewButton').className='button button-quiet';
    $('photosViewButton').setAttribute('aria-pressed','true');$('productsViewButton').setAttribute('aria-pressed','false');
    renderTagTools();renderReviewQueue();render();
  });

  $('closeDetail').addEventListener('click',()=>detail.close()); detail.addEventListener('click',e=>{if(e.target===detail)detail.close()});
  search.addEventListener('input',()=>{currentPage=0;render()});
  [category,tag,trip,year,researchStatus,needsReview].forEach(el=>el.addEventListener('change',()=>{currentPage=0;render()}));
  $('photosViewButton').addEventListener('click',()=>{currentView='photos';currentPage=0;$('photosViewButton').className='button button-primary';$('productsViewButton').className='button button-quiet';$('photosViewButton').setAttribute('aria-pressed','true');$('productsViewButton').setAttribute('aria-pressed','false');render()});
  $('productsViewButton').addEventListener('click',()=>{currentView='products';currentPage=0;$('productsViewButton').className='button button-primary';$('photosViewButton').className='button button-quiet';$('productsViewButton').setAttribute('aria-pressed','true');$('photosViewButton').setAttribute('aria-pressed','false');render()});
  $('previousPage').addEventListener('click',()=>{if(currentPage>0){currentPage--;render()}});
  $('nextPage').addEventListener('click',()=>{currentPage++;render()});
  renderReviewQueue();renderTagTools();render();
  loadCommunityCatalog().then(refreshSharedOverrides);
})();
