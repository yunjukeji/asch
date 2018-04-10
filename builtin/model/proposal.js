module.exports = {
  table: 'proposals',
  tableFields: [
    { name: 'tid', type: 'String', length: 64, primary_key: true },
    { name: 'title', type: 'String', length: 256 },
    { name: 'desc', type: 'Text' },
    { name: 'topic', type: 'String', length: 256 },
    { name: 'content', type: 'Text' },
    { name: 'activated', type: 'Number', default: 0 },
    { name: 'height', type: 'BigInt' }
  ]
}