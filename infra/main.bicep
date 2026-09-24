targetScope = 'resourceGroup'

@description('Azure region; use West Europe for the managed Static Web Apps API and Table service.')
param location string = resourceGroup().location
@minLength(3)
@maxLength(24)
param storageAccountName string
param staticWebAppName string
@description('Globally unique Function App name for asynchronous catalog work.')
param catalogFunctionAppName string
@description('Globally unique LRS storage account used only for Function host and deployment data.')
param functionHostStorageAccountName string
@description('Microsoft Foundry project endpoint containing the mimishopping prompt agent.')
param foundryProjectEndpoint string
@description('Agent name in the Foundry project.')
param foundryAgentName string = 'mimishopping'
@minValue(1)
@maxValue(20)
param workerMaximumInstanceCount int = 4
@description('Enable a Cost Management budget where the subscription offer supports budgets.')
param enableCostBudget bool = false
@description('Email address for monthly resource-group budget alerts when enabled.')
param budgetContactEmail string = ''

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  tags: { application: 'MimisJapanShopping', managedBy: 'Bicep' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: true
    allowSharedKeyAccess: true
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource contributionsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'contributions'
  properties: { publicAccess: 'Blob', defaultEncryptionScope: '$account-encryption-key', denyEncryptionScopeOverride: false }
}

resource intakeContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'contribution-inbox'
  properties: { publicAccess: 'None', defaultEncryptionScope: '$account-encryption-key', denyEncryptionScopeOverride: false }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource tagOverrides 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'TagOverrides'
}

resource catalogItems 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'CatalogItems'
}

resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource intakeQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'catalog-intake'
}

resource poisonQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'catalog-intake-poison'
}

resource workerHostStorage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: functionHostStorageAccountName
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  tags: { application: 'MimisJapanShoppingWorker', managedBy: 'Bicep' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    supportsHttpsTrafficOnly: true
  }
}

resource workerHostBlobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: workerHostStorage
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: false, allowPermanentDelete: false } }
}

resource deploymentContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: workerHostBlobService
  name: 'function-deployment'
  properties: { publicAccess: 'None', defaultEncryptionScope: '$account-encryption-key', denyEncryptionScopeOverride: false }
}

resource site 'Microsoft.Web/staticSites@2022-09-01' existing = {
  name: staticWebAppName
}

resource workerPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${catalogFunctionAppName}-plan'
  location: location
  kind: 'functionapp'
  sku: { tier: 'FlexConsumption', name: 'FC1' }
  properties: { reserved: true }
  tags: { application: 'MimisJapanShoppingWorker', managedBy: 'Bicep' }
}

resource worker 'Microsoft.Web/sites@2024-04-01' = {
  name: catalogFunctionAppName
  location: location
  kind: 'functionapp,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: workerPlan.id
    httpsOnly: true
    siteConfig: { minTlsVersion: '1.2' }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${workerHostStorage.properties.primaryEndpoints.blob}${deploymentContainer.name}'
          authentication: { type: 'SystemAssignedIdentity' }
        }
      }
      runtime: { name: 'node', version: '22' }
      scaleAndConcurrency: {
        maximumInstanceCount: workerMaximumInstanceCount
        instanceMemoryMB: 2048
      }
    }
  }
  tags: { application: 'MimisJapanShoppingWorker', managedBy: 'Bicep' }
}

resource workerSettings 'Microsoft.Web/sites/config@2024-04-01' = {
  parent: worker
  name: 'appsettings'
  properties: {
    AzureWebJobsStorage__accountName: workerHostStorage.name
    AzureWebJobsStorage__credential: 'managedidentity'
    FUNCTIONS_EXTENSION_VERSION: '~4'
    CATALOG_TABLE_ENDPOINT: storage.properties.primaryEndpoints.table
    CATALOG_TABLE_NAME: catalogItems.name
    CATALOG_BLOB_ENDPOINT: storage.properties.primaryEndpoints.blob
    CATALOG_INTAKE_CONTAINER: intakeContainer.name
    CATALOG_PUBLIC_CONTAINER: contributionsContainer.name
    CATALOG_QUEUE_NAME: intakeQueue.name
    CatalogQueue__queueServiceUri: storage.properties.primaryEndpoints.queue
    CatalogQueue__credential: 'managedidentity'
    FOUNDRY_PROJECT_ENDPOINT: foundryProjectEndpoint
    FOUNDRY_AGENT_NAME: foundryAgentName
  }
}

var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var blobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var queueDataContributorRoleId = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var tableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

resource workerHostBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workerHostStorage.id, worker.id, blobDataOwnerRoleId)
  scope: workerHostStorage
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataOwnerRoleId)
    principalId: worker.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerDeploymentBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(deploymentContainer.id, worker.id, blobDataContributorRoleId)
  scope: deploymentContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: worker.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerInboxBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(intakeContainer.id, worker.id, blobDataContributorRoleId)
  scope: intakeContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: worker.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerContributionsBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(contributionsContainer.id, worker.id, blobDataContributorRoleId)
  scope: contributionsContainer
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDataContributorRoleId)
    principalId: worker.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerIntakeQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(intakeQueue.id, worker.id, queueDataContributorRoleId)
  scope: intakeQueue
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributorRoleId)
    principalId: worker.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerPoisonQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(poisonQueue.id, worker.id, queueDataContributorRoleId)
  scope: poisonQueue
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueDataContributorRoleId)
    principalId: worker.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerCatalogTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(catalogItems.id, worker.id, tableDataContributorRoleId)
  scope: catalogItems
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableDataContributorRoleId)
    principalId: worker.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource monthlyBudget 'Microsoft.Consumption/budgets@2018-10-01' = if (enableCostBudget) {
  name: 'mimi-shopping-monthly-cost-alert'
  properties: {
    category: 'Cost'
    amount: 5
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: '2026-09-01T00:00:00Z'
      endDate: '2027-09-30T00:00:00Z'
    }
    notifications: {
      Actual_GreaterThan_80_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        contactEmails: [budgetContactEmail]
      }
      Actual_GreaterThan_100_Percent: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        contactEmails: [budgetContactEmail]
      }
    }
  }
}

output storageName string = storage.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob
output tableEndpoint string = storage.properties.primaryEndpoints.table
output staticWebAppName string = site.name
output staticWebAppHostname string = site.properties.defaultHostname
output catalogFunctionAppName string = worker.name
output workerPrincipalId string = worker.identity.principalId
output functionHostStorageName string = workerHostStorage.name
