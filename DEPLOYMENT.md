# Azure deployment

## Resources

- Subscription: Visual Studio B Dev Essentials.
- Resource group: `webapps`, West Europe.
- Azure Static Web Apps: Free plan, West Europe managed API, source `main` from this repository.
- Storage: StorageV2, Standard LRS, Hot tier, HTTPS only, TLS 1.2; `gallery` Blob container exposes anonymous blob reads but not container listing. Its default Blob REST version is pinned to `2023-11-03`, so anonymous downloads return each original's `Content-Disposition` header. The `TagOverrides` Table is private.
- The photos and the catalog/research text are public. Do not store credentials or private notes in `catalog-data.js`.

## Custom domain

The public gallery is also available at `https://mimishop.michaelwhitehouse.net`. The Static Web App custom-domain binding is represented by `siteCustomDomain` in `infra/main.bicep`; set `customDomainName` when deploying a different hostname. The `michaelwhitehouse.net` Azure DNS zone is in the Visual Studio A subscription, resource group `mikenet`, while the Static Web App is in the Visual Studio B subscription, resource group `webapps`. Its `mimishop` CNAME points to the Static Web App's `defaultHostname` output. Keep the DNS record and custom-domain binding when redeploying; Azure provisions the HTTPS certificate after validation.

Provision the resource group, then run `infra/main.bicep` with the storage and Static Web App names. The template can create a monthly resource-group budget of 5 billing-currency units with 80% and 100% notifications by setting `enableCostBudget=true` and supplying `budgetContactEmail`. Azure rejected budgets for this Visual Studio subscription's offer type, so the feature defaults off here. Grant the deploying user `Storage Blob Data Contributor` on the storage account. Set `TABLE_ENDPOINT` and `TABLE_SAS_TOKEN` in the Static Web App's API application settings; neither belongs in this repository. The Function SAS must be scoped to `TagOverrides`, HTTPS-only, and limited to read/query, add, update, and delete.

## GitHub deployment

Add the Static Web Apps deployment token as the Actions secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. The workflow deploys the repository root and `api/` on pushes to `main` or when manually started from Actions. Pull requests do not deploy.

## Editor

Invite Mimi's Microsoft Entra account to the `catalog_editor` role in Static Web Apps Role Management. Static Web Apps role names allow letters, digits, and underscores, so this uses an underscore. The app's edit API also checks the role from the Static Web Apps principal header. Anonymous visitors can browse the catalog and read tag overrides but cannot write them.

The `/.auth/login/aad` route signs an editor in; `/.auth/logout` signs out. Import an existing local edit backup after signing in. Product photos and research remain static; only tag overrides sync through Table Storage.

## Resumable asset upload

Generate optimized display images from the unchanged originals with `scripts/generate_gallery_renditions.cjs --shopping-root "<Japan shopping folder>"`. It checks every original against `Catalog/move-manifest.csv`, writes immutable `Catalog/optimized-v1/` WebP and JPEG files (480 px thumbnails and 1600 px detail renditions), and checkpoints each image in `Catalog/optimized-v1-manifest.jsonl`. The generator requires `sharp` from `worker/` dependencies and checks that aggregate WebP thumbnail bytes are at least 30% below the existing JPEG thumbnail set. Inspect packaging text at full resolution before switching the catalog.

Run `scripts/upload_assets.py` from a Python environment with `requirements-assets.txt` installed and an Azure CLI login. It checks all original photo SHA-256 values against the catalog move manifest, uploads originals, old rollback assets, HEIC JPEG previews, and the new 2,964 versioned renditions, then records a private JSONL checkpoint outside this repository. It safely merges newly added rendition paths into the existing verified transfer manifest. Blob SHA-256 metadata and stored MD5 are checked remotely. Upload display assets before deploying the catalog so every new image URL exists when the site switches. Use `--skip-download-headers` during that upload so the still-live old gallery keeps its current inline behavior; after the optimized site is live, run the same command with `--headers-only` to set and verify `Content-Disposition: attachment` on original photos while preserving their bytes and other HTTP headers. The transfer manifest is private operational data and must not be committed.

The static catalog maps each image to JPEG fallback and WebP display paths and separately retains its exact source path for **Save Image**. HEIC sources display from JPEG renditions but download as HEIC. Old `photos/`, `thumbnails/`, and `previews/` paths remain available for rollback; `optimized-v1/` is immutable and versioned for cache safety. Community contributions publish their sanitized JPEG plus the same four renditions under the `contributions` container. Their full sanitized JPEG uses attachment headers. Older contribution records without rendition paths continue to use their existing photo and thumbnail fields.

## Rotate the Table SAS

The Static Web Apps managed Functions API has no managed identity. Generate a replacement service SAS for the `TagOverrides` Table with permissions `raud`, HTTPS-only, and a new expiry; update `TABLE_SAS_TOKEN` in Static Web Apps API application settings and confirm `GET /api/tag-overrides` works. Do not print, commit, or add the token to GitHub Actions. Rotate before expiry. If secret rotation is undesirable, migrate to Static Web Apps Standard with a linked Consumption Function and managed identity.

## Cost controls

Static Web Apps Free has a 100 GB monthly bandwidth allowance per subscription. Blob internet egress and storage transactions are billed separately. Keep the Blob tier Hot for gallery browsing, retain LRS, and review a £5 monthly resource-group budget alert. A budget is an alert, not a spending cap.

## Public photo contributions

The upload form is public and does not require sign-in. It accepts one JPEG, PNG, WebP, HEIC, or AVIF image up to 24 MiB. The browser sends the original bytes directly to the Static Web Apps managed API. The API keeps the original in the private `contribution-inbox` container, stores a SHA-256 keyed draft row in `CatalogItems`, and enqueues analysis. The browser generates an unguessable 256-bit draft token, keeps it only in its session, and sends it in a dedicated request header; Table Storage stores only its SHA-256 hash. Do not log or share a draft token. Unsubmitted drafts and their private files are deleted after 30 days.

The queue-triggered Node 22 Function App uses its managed identity for the private inbox, queue, catalog Table, public contribution container, and Foundry agent. The worker resizes and re-encodes images before calling Foundry, which removes EXIF/location metadata. Foundry returns the structured identification, Japanese-to-English translations, and web research. The complete result remains private until the visitor supplies a public contributor name and selects **Add to catalog**. Publishing copies the sanitized photo and thumbnail into `contributions`, verifies their SHA-256 hashes, and makes the matching Table row available to the public gallery. A duplicate upload cannot take over another visitor's private draft. Editors can hide a contribution; this removes its public photo and hides its catalog row.

The public app uses the following Static Web Apps API settings for intake: `CATALOG_TABLE_ENDPOINT`, `CATALOG_TABLE_NAME`, `CATALOG_TABLE_SAS`, `CATALOG_BLOB_ENDPOINT`, `CATALOG_INTAKE_CONTAINER`, `CATALOG_INTAKE_BLOB_SAS`, `CATALOG_QUEUE_ENDPOINT`, `CATALOG_QUEUE_NAME`, and `CATALOG_QUEUE_SAS`. Set the Table SAS to `rau` on only `CatalogItems`, the Blob container SAS to `rcw` on only `contribution-inbox` (read for token-gated previews; create/write for uploads), and the Queue SAS to `a` on only `catalog-intake`; all should require HTTPS and have an expiry. The API does not need permission to process queue messages or delete Table entities. Keep every SAS in server-side Static Web Apps API settings. Never put one in the app bundle, GitHub, or deployment logs. Keep the existing `TABLE_ENDPOINT` and `TABLE_SAS_TOKEN` settings for tag overrides.

The worker app settings are managed by Bicep: `CATALOG_TABLE_ENDPOINT`, `CATALOG_TABLE_NAME`, `CATALOG_BLOB_ENDPOINT`, `CATALOG_INTAKE_CONTAINER`, `CATALOG_PUBLIC_CONTAINER`, `CATALOG_QUEUE_NAME`, `CatalogQueue__queueServiceUri`, `CatalogQueue__credential`, `FOUNDRY_PROJECT_ENDPOINT`, and `FOUNDRY_AGENT_NAME`. The worker uses managed identity for these services, not SAS keys. Assign **Foundry Agent Consumer** to the Function App identity at the individual `mimishopping` agent scope. Keep the agent version pinned to a tested version; never route the production endpoint to `latest` automatically.

The API writes plain JSON through the Azure Storage Queues JavaScript SDK. `worker/host.json` sets `extensions.queues.messageEncoding` to `none` to match those messages; the Queue extension defaults to `base64` and rejects raw messages before the function handler runs. Keep the producer and host setting aligned. Each processing or publication attempt also has a random ID stored on the draft; the worker checks it so a stale poison message cannot mark a newer retry as failed or overwrite a ready result.

### First deployment and verification

1. Build and inspect the Bicep change, then deploy the infrastructure in `webapps` with the existing gallery Storage and Static Web App names and a dedicated Flex Consumption Function App plus host-storage account. The template creates the inbox, public contributions container, Table, queues, Function App, and scoped storage role assignments. Confirm the what-if does not delete or replace the existing gallery assets.
2. Assign **Foundry Agent Consumer** to the Function App managed identity at the `mimishopping` agent scope. Deploy `worker/` to the Flex Consumption app with Azure Functions Core Tools (`func azure functionapp publish <function-app-name>`) or zip `host.json`, `package.json`, `package-lock.json`, and `src/` from `worker/`, then run `az functionapp deployment source config-zip -g webapps -n <function-app-name> --src <package.zip> --build-remote true`. Check that the registered functions include the queue processor, poison-queue handler, and daily draft cleanup timer.
3. Generate the three short-scope, HTTPS-only SAS tokens described above, then set them only as Static Web Apps API app settings. Do not print tokens in the terminal or save them in the repository. Verify the settings by testing anonymous API requests rather than reading secret values back.
4. Deploy the root site and `api/` through the existing GitHub Actions workflow. Confirm the API is available before making the upload link public, then pin the production Foundry endpoint to the tested structured-output version.
5. Test without sign-in: upload an in-person Japanese store photo, verify the private status and token-gated preview, check the translated result and research sources, and confirm a blank contributor name cannot publish. Submit with a name, then verify the sanitized photo and catalog row become public. Also test token denial, duplicate-draft denial, editor-only hide, expiry cleanup, and a phone-sized viewport. Keep any test contribution unpublished and delete its private draft after the test.

Static Web Apps managed API requests have a 45-second duration limit; image analysis therefore runs in the queue worker. The app enforces a 24 MiB upload cap to leave room below the platform request limit. Public upload has no CAPTCHA, per-IP limit, or daily quota, so anonymous AI use and Blob traffic can vary. The 30-day cleanup applies to private, unsubmitted drafts; published contributions remain until an editor hides them.
