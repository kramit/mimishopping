# Mimi's Japan shopping

A public photo and product catalog for Mimi's Japan shopping. Visitors can submit a store photo without signing in, review the identification and web research, then publish it with a required public contributor name. Photo originals, thumbnails, and browser-ready previews are served from Azure Blob Storage; shared tag overrides are stored in Azure Table Storage and writable only by an invited `catalog_editor`.

## Deploy

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Azure layout, deployment workflow, editor setup, asset transfer, and SAS rotation steps. The public catalog source is `catalog-data.js`. Do not add photo originals, thumbnails, local SQLite files, OCR output, product-research work files, or secrets to this repository.

## Local API tests

```sh
cd api
npm ci
npm test
```

The existing catalog and its product research are included in this public repository. New contributions are processed asynchronously by a queue-triggered Function App, held privately until the contributor chooses **Add to catalog**, and then added to the public gallery. Only tag edits are writable by editors; photo review checks remain browser-local. See [DEPLOYMENT.md](DEPLOYMENT.md) for the contribution architecture, privacy, deployment, and verification steps.
