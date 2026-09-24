# Mimi's Japan shopping

A public, read-only photo and product catalog for Mimi's Japan shopping. Photo originals, thumbnails, and browser-ready previews are served from Azure Blob Storage; shared tag overrides are stored in Azure Table Storage and writable only by an invited `catalog_editor`.

## Deploy

See [DEPLOYMENT.md](DEPLOYMENT.md) for the Azure layout, deployment workflow, editor setup, asset transfer, and SAS rotation steps. The public catalog source is `catalog-data.js`. Do not add photo originals, thumbnails, local SQLite files, OCR output, product-research work files, or secrets to this repository.

## Local API tests

```sh
cd api
npm ci
npm test
```

The public data and product research are included in this public repository. Only tag edits are written back at runtime; photo review checks remain browser-local.
