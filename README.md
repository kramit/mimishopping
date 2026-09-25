# Mimi's Shopping Encyclopedia

A public catalog of Japan travel finds. Visitors can browse photos and identified products, search packaging text and research, filter by category, tag, trip, year, or research status, and save source images. Anyone can privately upload a photo for product identification and web research, then review the result before choosing whether to publish it with a contributor name. Invited editors can maintain shared tags and moderate published contributions.

The existing gallery and research records ship in `catalog-data.js`. Published community items load separately from `/api/catalog-items`; private drafts never appear in that public response. Photo assets are served from Azure Blob Storage.

## Repository map

| Path | Role |
| --- | --- |
| `index.html`, `styles.css` | Public page and presentation |
| `app.js` | Browse, search, product grouping, detail dialogs, review checks, and editor tools |
| `contributions.js` | Private upload, progress, review, retry, discard, and publication UI |
| `catalog-data.js`, `assets-config.js` | Shipped catalog and public asset base URLs |
| `api/` | Azure Static Web Apps managed Functions API and tests |
| `worker/` | Queue, poison queue, and expiry Functions plus tests |
| `infra/main.bicep` | Azure storage, queue, Function App, identity, and site definitions |
| `scripts/` | Gallery rendition and upload utilities |

## Local setup

Use Node.js 22 for the Functions projects. A static file server is enough to preview the page layout and bundled catalog:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. The page requests public Azure Blob assets using `assets-config.js`. A plain static server **does not provide** `/.auth/*` or `/api/*`; shared tags, community catalog loading, and the upload/publish flow require a configured Azure Static Web Apps environment. Do not treat a static preview as an end-to-end API test.

Run the automated tests independently:

```sh
cd api && npm ci && npm test
cd ../worker && npm ci && npm test
```

The API uses server-side settings `TABLE_ENDPOINT`, `TABLE_SAS_TOKEN`, `CATALOG_TABLE_ENDPOINT`, `CATALOG_TABLE_NAME`, `CATALOG_TABLE_SAS`, `CATALOG_BLOB_ENDPOINT`, `CATALOG_INTAKE_CONTAINER`, `CATALOG_INTAKE_BLOB_SAS`, `CATALOG_QUEUE_ENDPOINT`, `CATALOG_QUEUE_NAME`, and `CATALOG_QUEUE_SAS`. The worker uses `CATALOG_TABLE_ENDPOINT`, `CATALOG_TABLE_NAME`, `CATALOG_BLOB_ENDPOINT`, `CATALOG_INTAKE_CONTAINER`, `CATALOG_PUBLIC_CONTAINER`, `CATALOG_QUEUE_NAME`, `CatalogQueue__queueServiceUri`, `CatalogQueue__credential`, `FOUNDRY_PROJECT_ENDPOINT`, and `FOUNDRY_AGENT_NAME`, plus Azure Functions host settings. Configure these only in the appropriate Azure app settings or a private local configuration file. Never commit SAS tokens, credentials, draft tokens, source photos, private research files, or generated transfer manifests.

## Guides

- [User guide](docs/user-guide.md): browsing, private contributions, review, and editor controls.
- [Architecture](docs/architecture.md): data flow, state transitions, access, and retention.
- [Functions reference](docs/functions.md): HTTP and background Function behavior.
- [Deployment](DEPLOYMENT.md): infrastructure, secrets, publishing, and live checks.
