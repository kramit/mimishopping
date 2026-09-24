# Azure deployment

## Resources

- Subscription: Visual Studio B Dev Essentials.
- Resource group: `webapps`, West Europe.
- Azure Static Web Apps: Free plan, West Europe managed API, source `main` from this repository.
- Storage: StorageV2, Standard LRS, Hot tier, HTTPS only, TLS 1.2; `gallery` Blob container exposes anonymous blob reads but not container listing. The `TagOverrides` Table is private.
- The photos and the catalog/research text are public. Do not store credentials or private notes in `catalog-data.js`.

Provision the resource group, then run `infra/main.bicep` with the storage and Static Web App names. Grant the deploying user `Storage Blob Data Contributor` on the storage account. Set `TABLE_ENDPOINT` and `TABLE_SAS_TOKEN` in the Static Web App's API application settings; neither belongs in this repository. The Function SAS must be scoped to `TagOverrides`, HTTPS-only, and limited to read/query, add, update, and delete.

## GitHub deployment

Add the Static Web Apps deployment token as the Actions secret `AZURE_STATIC_WEB_APPS_API_TOKEN`. The workflow deploys the repository root and `api/` on pushes to `main`. It does not deploy from pull requests.

## Editor

Invite Mimi's Microsoft Entra account to the `catalog_editor` role in Static Web Apps Role Management. Static Web Apps role names allow letters, digits, and underscores, so this uses an underscore. The app's edit API also checks the role from the Static Web Apps principal header. Anonymous visitors can browse the catalog and read tag overrides but cannot write them.

The `/.auth/login/aad` route signs an editor in; `/.auth/logout` signs out. Import an existing local edit backup after signing in. Product photos and research remain static; only tag overrides sync through Table Storage.

## Resumable asset upload

Run `scripts/upload_assets.py` from a Python environment with `requirements-assets.txt` installed and an Azure CLI login. It checks photo SHA-256 values against the catalog move manifest, uploads originals, thumbnails, and HEIC JPEG previews, records a private JSONL checkpoint outside this repository, and verifies each Blob's SHA-256 metadata and stored MD5. The transfer manifest is private operational data and must not be committed.

## Rotate the Table SAS

The Static Web Apps managed Functions API has no managed identity. Generate a replacement service SAS for the `TagOverrides` Table with permissions `raud`, HTTPS-only, and a new expiry; update `TABLE_SAS_TOKEN` in Static Web Apps API application settings and confirm `GET /api/tag-overrides` works. Do not print, commit, or add the token to GitHub Actions. Rotate before expiry. If secret rotation is undesirable, migrate to Static Web Apps Standard with a linked Consumption Function and managed identity.

## Cost controls

Static Web Apps Free has a 100 GB monthly bandwidth allowance per subscription. Blob internet egress and storage transactions are billed separately. Keep the Blob tier Hot for gallery browsing, retain LRS, and review a £5 monthly resource-group budget alert. A budget is an alert, not a spending cap.
