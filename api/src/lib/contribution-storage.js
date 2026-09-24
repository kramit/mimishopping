const {AzureSASCredential} = require('@azure/core-auth');
const {TableClient} = require('@azure/data-tables');
const {ContainerClient} = require('@azure/storage-blob');
const {QueueClient} = require('@azure/storage-queue');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

function sasUrl(endpoint, resource, sas) {
  return `${endpoint.replace(/\/+$/, '')}/${resource}?${sas.replace(/^\?/, '')}`;
}

let tableClient;
function getCatalogTableClient() {
  if (!tableClient) {
    tableClient = new TableClient(
      required('CATALOG_TABLE_ENDPOINT'),
      process.env.CATALOG_TABLE_NAME || 'CatalogItems',
      new AzureSASCredential(required('CATALOG_TABLE_SAS'))
    );
  }
  return tableClient;
}

let inboxClient;
function getInboxContainerClient() {
  if (!inboxClient) {
    inboxClient = new ContainerClient(sasUrl(
      required('CATALOG_BLOB_ENDPOINT'),
      process.env.CATALOG_INTAKE_CONTAINER || 'contribution-inbox',
      required('CATALOG_INTAKE_BLOB_SAS')
    ));
  }
  return inboxClient;
}

let queueClient;
function getIntakeQueueClient() {
  if (!queueClient) {
    queueClient = new QueueClient(sasUrl(
      required('CATALOG_QUEUE_ENDPOINT'),
      process.env.CATALOG_QUEUE_NAME || 'catalog-intake',
      required('CATALOG_QUEUE_SAS')
    ));
  }
  return queueClient;
}

module.exports = {getCatalogTableClient, getInboxContainerClient, getIntakeQueueClient};
