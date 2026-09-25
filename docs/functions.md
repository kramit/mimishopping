# Function reference

This is an inventory of the named functions in the browser, HTTP API, queue worker, and operational scripts. Source links point to definitions. Tables use **input → output; effect** notation. Browser helpers are private to their immediately invoked script; they return `undefined` unless a result is stated. DOM creation functions return an element. API handlers return Azure Functions HTTP responses, usually JSON. Their optional `deps`/client parameters inject storage doubles in tests. Worker functions use `DefaultAzureCredential`; API storage clients use configured SAS credentials. Errors are described at the handler or command level rather than repeated for every pure formatter.

## Gallery browser: [`app.js`](../app.js)

The script starts after `catalog-data.js`/`assets-config.js`, initializes controls, renders the gallery, loads public contributions, then fetches shared tag overrides and `/.auth/me`. Browser tag and review persistence uses `localStorage`; shared tag writes require the `catalog_editor` role. Network errors are shown in `tagStatus` or leave the initial gallery intact.

| Function | Input → output; caller/trigger and effect |
| --- | --- |
| [`$`](../app.js#L3), [`clean`](../app.js#L7), [`unique`](../app.js#L8) | DOM ID → element; value → lowercase text; values → sorted distinct truthy values. Internal lookup, search, and filter helpers. |
| [`normalizeTags`](../app.js#L23) | Array or delimited text → case-insensitive unique tags, up to 80 and 64 characters each; used for editor/import values. |
| [`readOverrides`](../app.js#L33), [`saveOverrides`](../app.js#L44) | Read valid image-ID tag maps from `localStorage` → map or `{}`; write current map → boolean. Invalid JSON/storage access falls back without throwing. |
| [`assetUrl`](../app.js#L48) | Catalog path → absolute configured asset URL when a known prefix/base exists, otherwise original path; encodes path segments. |
| [`responsiveImage`](../app.js#L59), [`saveImageLink`](../app.js#L74) | Image/variant/alt/class → `<picture>` with WebP and fallback; image → download `<a>` or `null`. Used by cards and dialogs; download URL gets `mimi-download=1`. |
| [`readReviewChecks`](../app.js#L84), [`saveReviewChecks`](../app.js#L90) | Read valid IDs from local storage → `Set`; persist checks → boolean. Invalid data/storage access uses empty/failure fallback. |
| [`needsAttention`](../app.js#L94), [`updateReviewLabel`](../app.js#L95) | Image → boolean for two review states; update review toggle open count in DOM. |
| [`refreshDerivedData`](../app.js#L99), [`effectiveTags`](../app.js#L111) | Rebuild product groups, summary, and filter options after contribution changes; image → shared/local override or catalog tags. |
| [`announce`](../app.js#L114), [`setEditorAccess`](../app.js#L115) | Message → status text; auth principal → editor flags and control visibility. Roles come from `/.auth/me`. |
| [`refreshSharedOverrides`](../app.js#L128) | Fetch profile and `/api/tag-overrides` → merge known shared entries/ETags with loaded local edits, save locally, rerender. On error disables editing and announces failure. |
| [`saveSharedOverrides`](../app.js#L154) | `{imageId,tags}` array → API results; POST with cached ETags, apply partial results to state and local storage. Throws for non-editor or API error/conflict. Called by single/bulk edits and backup import. |
| [`normalizedProductKey`](../app.js#L174), [`buildProductGroups`](../app.js#L179), [`productTitle`](../app.js#L194) | Product → normalized identity key; images → grouped/sorted products with deduplicated photos and preferred research match; product → display title. Internal `rank` selects the best research state. |
| [`imageResearchStatuses`](../app.js#L200), [`researchBadge`](../app.js#L205), [`addResearchBadges`](../app.js#L211) | Image → status list; status → badge; parent/statuses → appended badges. Unknown/missing research falls back to pending. |
| [`selectTag`](../app.js#L229), [`renderTagTools`](../app.js#L236) | Tag click toggles filter and rerenders; tag tools rebuild dropdown/cloud/counts from effective tags and current expansion state. |
| [`matches`](../app.js#L270) | Image → boolean across text, category, tag, trip, year, research, and local review filters. |
| [`card`](../app.js#L283), [`productCard`](../app.js#L315) | Image/group → gallery card with detail/filter actions. |
| [`renderReviewQueue`](../app.js#L331), [`setReviewChecked`](../app.js#L352) | Render local review queue; image/boolean → persist local check, update counts/views/dialog and announce. |
| [`updatePagination`](../app.js#L359), [`render`](../app.js#L367) | Item count → pagination controls; current filters/view → paged photo or product cards and result count. Page size is 48. |
| [`appendLinks`](../app.js#L384), [`productBlock`](../app.js#L401) | Parent/label/source rows → safe HTTP(S) anchors or plain titles; product → details and research section. |
| [`tagEditor`](../app.js#L436), [`applyBulkTags`](../app.js#L476) | Image/parent → editor-only tag form and restore action; group/mode/tags → shared updates in batches of 25, with errors announced. |
| [`openProductDetail`](../app.js#L492), [`openDetail`](../app.js#L527) | Group or image → populated modal. Editor-only actions save tags, update contributor credit (`PATCH /api/catalog-items/{id}/attribution`), or confirm hiding (`POST .../hide`); failed writes announce errors. |
| [`exportEdits`](../app.js#L597) | Current tag overrides/local checks → downloaded JSON backup via object URL; invoked by export button. Import handler validates format/IDs, sends 25-item batches, restores local checks. |
| [`loadCommunityCatalog`](../app.js#L627), [`orderCommunityImagesFirst`](../app.js#L639) | GET public contributions → append unseen images and refresh views; order contributions by newest published date before archive images. Fetch failures are ignored; publication event also calls the ordering path. |

Other event listeners in [`app.js`](../app.js#L597) handle backup import, a newly published contribution, search/filters, view switches, pagination, and dialog closing. They are anonymous callbacks rather than reusable named functions.

## Contribution browser: [`contributions.js`](../contributions.js)

This script exits when the upload controls are absent. Private draft IDs and bearer tokens are kept in browser storage; the server verifies tokens on draft reads, retries, discard, and publish. Uploads are limited to 24 MiB in both browser and API. The UI polls every 3.5 seconds while an active analysis is open (up to 12 minutes) and schedules background refreshes every 12 seconds while work is pending; visibility changes also refresh. API errors are rendered in the status areas.

| Function | Input → output; caller/trigger and effect |
| --- | --- |
| [`$`](../contributions.js#L2), [`setStatus`](../contributions.js#L34), [`setPublishStatus`](../contributions.js#L570) | DOM lookup; message/reveal flag → status text and optional scroll. |
| [`showActivityFrame`](../contributions.js#L38), [`setActivity`](../contributions.js#L42), [`syncActivity`](../contributions.js#L52) | Frame index → selected animation frame; active flag → activity visibility/4-second frame timer; draft states → activity flag. Reduced-motion preference suppresses timer. |
| [`parseTags`](../contributions.js#L55), [`validDraft`](../contributions.js#L63) | Delimited text → up to 40 unique tags of 64 characters; draft → boolean for 64-hex ID and token. |
| [`restoreDrafts`](../contributions.js#L66), [`saveDrafts`](../contributions.js#L78), [`saveDraft`](../contributions.js#L83), [`forgetDraft`](../contributions.js#L94) | Load valid drafts from local storage and migrate legacy session entry; persist limited draft fields; merge one draft and update UI/timers → saved draft; remove ID and update UI. Storage exceptions are ignored. |
| [`photoId`](../contributions.js#L101), [`newDraftToken`](../contributions.js#L105) | File → SHA-256 hex ID; secure random 32 bytes → independent 64-hex bearer token. |
| [`releasePreview`](../contributions.js#L110), [`setPreview`](../contributions.js#L114), [`clearResult`](../contributions.js#L120), [`showFlow`](../contributions.js#L127) | Manage object URL and preview, reset result/form controls, reveal contribution flow. |
| [`textBlock`](../contributions.js#L129), [`appendSources`](../contributions.js#L141), [`renderResearch`](../contributions.js#L159), [`renderFullResult`](../contributions.js#L188) | Append safe text/HTTP(S) links; research → section; normalized record → complete result and editable category/tags form. |
| [`parseResponse`](../contributions.js#L222), [`getStatus`](../contributions.js#L228), [`fetchPrivatePreview`](../contributions.js#L234) | Response → JSON or thrown API message; draft → token-authenticated status; draft → private preview object URL if ready. Preview failures are ignored. |
| [`statusLabel`](../contributions.js#L241), [`renderDraftList`](../contributions.js#L250), [`scheduleRefresh`](../contributions.js#L276) | Draft → human status; current drafts → sorted list with review/retry/check buttons; pending states → 12-second refresh timer. |
| [`getPublicItem`](../contributions.js#L283), [`finishPublished`](../contributions.js#L293), [`showReadyResult`](../contributions.js#L306) | ID/optional cached catalog payload → published image or `null`; image → publication event, forget draft and reset active UI; draft/record → review or publishing UI. |
| [`checkDraft`](../contributions.js#L320), [`refreshDrafts`](../contributions.js#L339), [`pollUntilReady`](../contributions.js#L380) | Manual check, periodic cross-draft refresh, or active 3.5-second polling → server states and UI transitions. Refresh guards against overlap; polling guards by ID and times out after 12 minutes while background refresh continues. |
| [`openDraft`](../contributions.js#L416), [`retryDraft`](../contributions.js#L429) | Draft → reopen result/progress; failed draft → choose same file for upload failure or POST token-authenticated retry. |
| [`uploadPhoto`](../contributions.js#L441), [`uploadCameraRoll`](../contributions.js#L483), [`uploadWorker`](../contributions.js#L488) | File/background flag → upload result/draft after validation, hash, local save, POST and optional active polling; file list → up to two concurrent uploads with per-file error collection; nested worker consumes the next file. |

Anonymous handlers in [`contributions.js`](../contributions.js#L504) bind camera/library selection, close, retry, discard, publish, and page visibility. Discard calls `DELETE /api/intakes/{id}` after confirmation. Publish requires a complete result and contributor name, then POSTs category/tags/name to `/api/intakes/{id}/publish`; the gallery receives a `mimi-catalog-item-published` event after public catalog confirmation.

## HTTP API

[`api/src/functions/contributions.js`](../api/src/functions/contributions.js) registers nine anonymous Azure HTTP routes. Anonymous registration means public catalog reads and upload creation are reachable without sign-in; private draft actions require the random draft token, and moderation requires `catalog_editor` in the trusted Static Web Apps principal header. The content hash identifies duplicate bytes but is not an access token. Storage failures are logged and normally become 503 responses. ETag preconditions protect selected draft transitions; queue jobs use attempt IDs so older attempts cannot overwrite current work.

| Function | Input → output; route/caller and effect |
| --- | --- |
| [`json`](../api/src/functions/contributions.js#L11), [`digest`](../api/src/functions/contributions.js#L15), [`addDays`](../api/src/functions/contributions.js#L16) | Status/body/cache policy → JSON response; bytes/text → SHA-256 hex; date/days → UTC expiry timestamp. |
| [`statusCode`](../api/src/functions/contributions.js#L17), [`missingEntity`](../api/src/functions/contributions.js#L18), [`existsEntity`](../api/src/functions/contributions.js#L19) | Azure error → numeric status or missing/conflict booleans for storage handling. |
| [`safeFilename`](../api/src/functions/contributions.js#L21), [`imageFormat`](../api/src/functions/contributions.js#L28) | Supplied filename → decoded, path/control-stripped safe name; bytes → JPEG/PNG/WebP/HEIC/AVIF MIME and extension, or `null`. |
| [`imageIdFrom`](../api/src/functions/contributions.js#L40), [`draftToken`](../api/src/functions/contributions.js#L45), [`tokenMatches`](../api/src/functions/contributions.js#L50) | Request route/header → validated ID/token; row/token → timing-safe comparison against stored token hash. Invalid private access gets 404. |
| [`getEntity`](../api/src/functions/contributions.js#L57), [`privateImageResponse`](../api/src/functions/contributions.js#L62), [`sendJob`](../api/src/functions/contributions.js#L68) | Table/ID → entity or `null` on 404; bytes → no-store JPEG response; queue/message → serialized job. Other storage errors propagate. |
| [`normalizeDisplayName`](../api/src/functions/contributions.js#L72), [`normalizeSubmission`](../api/src/functions/contributions.js#L80) | Name → cleaned nonempty text at most 48 chars or validation error; body/current record/ID → public record and contributor name, including contributor tag and public asset paths. |
| [`createIntake`](../api/src/functions/contributions.js#L95) | `POST /api/intakes` raw image and optional token → 202 draft ID/token/status or 200 published duplicate. Checks length/signature, stores source privately, queues `process`; can resume same-token or expired/discarded records. Rejects inaccessible duplicate (409), bad/oversize format (400/413/415), storage/queue failure (503 with retryable state). |
| [`getIntake`](../api/src/functions/contributions.js#L213) | `GET /api/intakes/{id}` + token → private status/result/expiry or 400/404/410/503. |
| [`getIntakePreview`](../api/src/functions/contributions.js#L231) | `GET /api/intakes/{id}/preview` + token → private no-store JPEG or 400/404/503. |
| [`discardIntake`](../api/src/functions/contributions.js#L249) | `DELETE /api/intakes/{id}` + token → mark discarded with ETag retry and queue cleanup (202); published/publishing gives 409. Queue failure is reported as `cleanupQueued:false` for expiry fallback. |
| [`retryIntake`](../api/src/functions/contributions.js#L286) | `POST /api/intakes/{id}/retry` + token → new process/publish attempt (202); only `queue-failed`/`failed` states. ETag conflict 409; queue/storage failure 503. |
| [`publishIntake`](../api/src/functions/contributions.js#L312) | `POST /api/intakes/{id}/publish` + token + name/category/tags → normalize record, move to publishing, queue job (202), or already-published 200. Validation 400, state conflict 409, storage/queue/result failure 503. |
| [`getCatalogItems`](../api/src/functions/contributions.js#L344) | `GET /api/catalog-items` → published records newest first; skips malformed rows; storage failure 503. |
| [`hideCatalogItem`](../api/src/functions/contributions.js#L361) | Editor `POST /api/catalog-items/{id}/hide` → queue `remove`, mark hidden, return 200. Unauthorized 403, absent 404, storage/queue failure 503. |
| [`updateCatalogAttribution`](../api/src/functions/contributions.js#L379) | Editor `PATCH /api/catalog-items/{id}/attribution` + name → update published record/name/contributor tag, return new credit. Unauthorized 403, invalid 400, absent 404, storage/JSON failure 503. |

[`api/src/functions/tag-overrides.js`](../api/src/functions/tag-overrides.js) provides shared gallery tag edits. A save batch is processed in order; a failure response includes prior successful `results` and `failedImageId`, so clients can reconcile partial writes.

| Function | Input → output; route/caller and effect |
| --- | --- |
| [`json`](../api/src/functions/tag-overrides.js#L5), [`etagOf`](../api/src/functions/tag-overrides.js#L9) | Status/body → no-store JSON response; Azure response → ETag or `null`. |
| [`getTagOverrides`](../api/src/functions/tag-overrides.js#L13) | `GET /api/tag-overrides` → `gallery` partition rows as tags/ETags; malformed tag JSON becomes empty list; storage failure 503. |
| [`saveTagOverrides`](../api/src/functions/tag-overrides.js#L29) | Editor `POST /api/tag-overrides/save-many` → validate 1–25 updates, replace/create/delete rows using supplied ETags, return results. Unauthorized 403, invalid input 400, conflict 409, storage failure 503. |

Shared API libraries:

| Function | Input → output; effect |
| --- | --- |
| [`normalizeTags`](../api/src/lib/validation.js#L6), [`validateBatch`](../api/src/lib/validation.js#L19), [`isCatalogEditor`](../api/src/lib/validation.js#L33) | Tags → normalized unique array or error (80 maximum); batch → validated rows/ETags or error (25 maximum); base64 principal header → editor-role boolean. |
| [`required`](../api/src/lib/contribution-storage.js#L6), [`sasUrl`](../api/src/lib/contribution-storage.js#L12) | Environment key → value or missing-config error; endpoint/resource/SAS → resource URL. |
| [`getCatalogTableClient`](../api/src/lib/contribution-storage.js#L17), [`getInboxContainerClient`](../api/src/lib/contribution-storage.js#L29), [`getIntakeQueueClient`](../api/src/lib/contribution-storage.js#L41) | Lazy cached Table/Blob/Queue SAS clients; used by contribution routes; missing settings throw. |
| [`getTableClient`](../api/src/lib/table-client.js#L5) | Lazy cached `TagOverrides` Table SAS client; missing settings throw. |

[`api/src/lib/catalog-schema.js`](../api/src/lib/catalog-schema.js) exports category constants only; it declares no functions.

## Queue worker: [`worker/src/catalog-worker.js`](../worker/src/catalog-worker.js)

The worker registers `catalog-intake` and its poison queue plus a daily `03:15 UTC` draft-expiry timer. Queue trigger retries thrown processing/publishing errors according to Azure Functions queue policy; the poison handler records a terminal `failed` state with a user retry action. There is no application-level exponential backoff in these functions. An attempt ID and repeated status reads prevent stale jobs and discarded drafts from being published.

| Function | Input → output; caller/trigger and effect |
| --- | --- |
| [`required`](../worker/src/catalog-worker.js#L15), [`getTable`](../worker/src/catalog-worker.js#L21), [`getBlobService`](../worker/src/catalog-worker.js#L26) | Environment key → value or error; lazy Table/Blob clients using managed identity. |
| [`sha256`](../worker/src/catalog-worker.js#L31), [`text`](../worker/src/catalog-worker.js#L32), [`array`](../worker/src/catalog-worker.js#L33), [`uniqueTags`](../worker/src/catalog-worker.js#L34) | Hash bytes; trim/limit string; bound array; normalize/dedupe at most 40 tags. Used to constrain model output. |
| [`safeUrl`](../worker/src/catalog-worker.js#L42), [`sourceList`](../worker/src/catalog-worker.js#L46), [`normalizeWebResearch`](../worker/src/catalog-worker.js#L53) | URL → HTTP(S) URL or empty; source rows → valid bounded citation list; research object/date → bounded, normalized research including sources, prices, reviews, translations. |
| [`normalizeAgentResult`](../worker/src/catalog-worker.js#L72) | Model result + ID/filename/date → complete catalog record with safe fields, category fallback, review status, asset paths; rejects JSON above 60 KiB. |
| [`responseText`](../worker/src/catalog-worker.js#L99), [`identifyImage`](../worker/src/catalog-worker.js#L108) | Foundry response → output text or error; image/filename/context → downscaled JPEG sent to Foundry agent Responses endpoint with managed-identity token, parsed structured JSON. HTTP/auth/parse errors throw for queue retry. |
| [`normalizeImages`](../worker/src/catalog-worker.js#L133) | Source bytes → rotated JPEG/WebP public image, preview, thumbnail, display buffers and SHA-256 hashes; Sharp rejects unsupported/oversized pixel inputs. |
| [`itemId`](../worker/src/catalog-worker.js#L151), [`updateEntity`](../worker/src/catalog-worker.js#L157) | Queue message → validated type/64-hex ID/optional 32-hex attempt; table/ID/changes → merge. Invalid messages throw. |
| [`processImage`](../worker/src/catalog-worker.js#L161) | Process job → mark processing, read private source, normalize image, identify/research, upload private outputs, mark ready. Stale/expired/discarded states return; failure restores queued state and rethrows for trigger retry. |
| [`publishImage`](../worker/src/catalog-worker.js#L212) | Publish job → copy all public renditions, verify metadata and downloaded SHA-256, mark published, erase token/private blobs. Stale/already published returns; failure leaves publishing and rethrows for retry. |
| [`deletePrivateBlobs`](../worker/src/catalog-worker.js#L268), [`removePublishedImage`](../worker/src/catalog-worker.js#L273), [`discardPrivateIntake`](../worker/src/catalog-worker.js#L286) | Container/ID → delete known private paths ignoring 404; removal job deletes public and private blobs then marks hidden; discard job deletes private blobs only while state remains discarded. |
| [`expireDrafts`](../worker/src/catalog-worker.js#L298) | Timer/context → delete expired private drafts and hidden item blobs/rows; published rows are preserved. |
| [`handleCatalogQueue`](../worker/src/catalog-worker.js#L313), [`handlePoisonQueue`](../worker/src/catalog-worker.js#L321) | Valid queue job → dispatch process/publish/discard/remove; poison process/publish job → mark matching active attempt failed with retry action after repeated trigger attempts. Malformed poison messages are ignored. |

[`worker/src/catalog-schema.js`](../worker/src/catalog-schema.js) exports category, strict result-schema, and agent-instruction constants only; it declares no functions. The deployed Foundry agent must satisfy that schema for `identifyImage` to parse and `normalizeAgentResult` to store its result.

## Operational scripts

These are manually invoked tooling, not website request handlers. [`scripts/upload_assets.py`](../scripts/upload_assets.py) requires Azure CLI authentication and Blob write permission to the gallery account. It uses a transfer manifest to resume and verifies source SHA-256 against the catalog ledger and remote MD5/SHA metadata; failures are recorded and `main` exits nonzero. It expects exactly 741 originals, 741 old thumbnails, 2 previews, and 2,964 optimized renditions.

| Function | Input → output; effect |
| --- | --- |
| [`digest_file`](../scripts/upload_assets.py#L26), [`load_source_hashes`](../scripts/upload_assets.py#L38), [`gather_assets`](../scripts/upload_assets.py#L43) | File → SHA-256/base64 MD5/size; CSV ledger → path/hash map; roots/ledger → validated asset inventory or error on count/hash/manifest mismatch. |
| [`write_manifest`](../scripts/upload_assets.py#L119), [`append_manifest_update`](../scripts/upload_assets.py#L130), [`load_or_create_manifest`](../scripts/upload_assets.py#L137) | Asset list → atomic JSONL snapshot; one asset → fsynced progress row; existing/current inventory → resumed statuses while rejecting removed/changed sources. |
| [`content_type`](../scripts/upload_assets.py#L164), [`content_disposition`](../scripts/upload_assets.py#L170), [`ensure_http_headers`](../scripts/upload_assets.py#L177) | Path → MIME; path → attachment filename header; Blob client/asset/properties → verify/update MIME and optional original-photo download header, returning verification flags. |
| [`transfer_one`](../scripts/upload_assets.py#L204) | Blob service/asset → verified/uploaded status and note. Skips matching remote content, otherwise uploads and checks MD5/SHA metadata; remote errors propagate. |
| [`main`](../scripts/upload_assets.py#L234) | CLI account/root/manifests/workers/options → inventory, Azure CLI credential, bounded thread pool, incremental progress manifest and summary; return 0 only when selected assets all verify. `--headers-only` touches original headers; `--skip-download-headers` defers them. |

[`scripts/generate_gallery_renditions.cjs`](../scripts/generate_gallery_renditions.cjs) runs locally with `--shopping-root` and `sharp` from the worker installation. It uses fixed `optimized-v1` output paths and refuses mismatched source hashes or changed output at an immutable path. It exits nonzero on failures or if WebP thumbnails miss the 30% aggregate savings target.

| Function | Input → output; effect |
| --- | --- |
| [`parseCsv`](../scripts/generate_gallery_renditions.cjs#L14), [`sha256`](../scripts/generate_gallery_renditions.cjs#L37), [`argumentsFrom`](../scripts/generate_gallery_renditions.cjs#L39) | CSV → rows; bytes → hash; CLI args → shopping root/help or error. |
| [`writeManifest`](../scripts/generate_gallery_renditions.cjs#L49), [`readManifest`](../scripts/generate_gallery_renditions.cjs#L58) | Entries → sorted JSONL via rename; path → ID map, empty on missing file, error on duplicate/malformed record. |
| [`writeRendition`](../scripts/generate_gallery_renditions.cjs#L73), [`oldThumbnailBytes`](../scripts/generate_gallery_renditions.cjs#L93) | Output bytes/prior manifest → verified file metadata, refusing immutable-path drift; thumbnail directory → byte baseline after 741-file check. |
| [`main`](../scripts/generate_gallery_renditions.cjs#L104) | Validate 741 ledger rows, render JPEG/WebP thumbnail and display variants, verify/write each image and manifest, print size summary; nested `mib` formats summary byte counts in MiB. |

[`scripts/build_hero_animation.py`](../scripts/build_hero_animation.py) is manually invoked artwork tooling. Its [`main`](../scripts/build_hero_animation.py#L25) reads the plate and transparent six-pose sprite, checks fixed dimensions/background, composites 11 poses, and writes still/animated WebP assets under `assets/`. It needs Pillow and local files; invalid dimensions or missing files fail immediately. The `__main__` guard invokes it manually.
