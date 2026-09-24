targetScope = 'resourceGroup'

@description('Azure region; use West Europe for the managed Static Web Apps API and Table service.')
param location string = resourceGroup().location
@minLength(3)
@maxLength(24)
param storageAccountName string
param staticWebAppName string
@description('Email address for the monthly resource-group cost budget alerts.')
param budgetContactEmail string

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

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource galleryContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'gallery'
  properties: { publicAccess: 'Blob' }
}

resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}

resource tagOverrides 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'TagOverrides'
}

resource site 'Microsoft.Web/staticSites@2022-09-01' = {
  name: staticWebAppName
  location: location
  sku: { name: 'Free', tier: 'Free' }
  tags: { application: 'MimisJapanShopping', managedBy: 'Bicep' }
}

resource monthlyBudget 'Microsoft.Consumption/budgets@2018-10-01' = {
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
