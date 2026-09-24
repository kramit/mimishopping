const {AzureSASCredential} = require('@azure/core-auth');
const {TableClient} = require('@azure/data-tables');

let cachedClient;
function getTableClient() {
  if (cachedClient) return cachedClient;
  const endpoint = process.env.TABLE_ENDPOINT;
  const sas = process.env.TABLE_SAS_TOKEN?.replace(/^\?/, '');
  if (!endpoint || !sas) throw new Error('Table API configuration is missing.');
  cachedClient = new TableClient(endpoint, 'TagOverrides', new AzureSASCredential(sas));
  return cachedClient;
}

module.exports = {getTableClient};
