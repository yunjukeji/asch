module.exports = {
  table: 'gateways',
  tableFields: [
    { name: 'name', type: 'String', length: 10, primary_key: true },
    { name: 'desc', type: 'Text' },
    { name: 'updateInterval', type: 'Number' },
    { name: 'minimumMembers', type: 'Number' },
    { name: 'lastUpdateHeight', type: 'BigInt' },
    { name: 'revoked', type: 'Number', default: 0 },
  ]
}
