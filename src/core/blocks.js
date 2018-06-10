var assert = require('assert');
var crypto = require('crypto');
var ip = require('ip');
var ByteBuffer = require("bytebuffer");
var async = require('async');
var ed = require('../utils/ed.js');
var bignum = require('bignumber');
var constants = require("../utils/constants.js");
var BlockStatus = require("../utils/block-status.js");
var constants = require('../utils/constants.js');
var Router = require('../utils/router.js');
var slots = require('../utils/slots.js');
var sandboxHelper = require('../utils/sandbox.js');
var PIFY = require('util').promisify

require('array.prototype.findindex'); // Old node fix

var genesisblock = null;
// Private fields
var modules, library, self, private = {}, shared = {};

private.lastBlock = {};
private.blockStatus = new BlockStatus();
private.loaded = false;
private.isActive = false;
private.blockCache = {};
private.proposeCache = {};
private.lastPropose = null;

// Constructor
function Blocks(cb, scope) {
  library = scope;
  genesisblock = library.genesisblock;
  self = this;
  self.__private = private;
  private.attachApi();

  // private.saveGenesisBlock(function (err) {
  //   setImmediate(cb, err, self);
  // });
  setImmediate(cb, null, self)
}

// Private methods
private.attachApi = function () {
  var router = new Router();

  router.use(function (req, res, next) {
    if (modules) return next();
    res.status(500).send({ success: false, error: "Blockchain is loading" });
  });

  router.map(shared, {
    "get /get": "getBlock",
    "get /full": "getFullBlock",
    "get /": "getBlocks",
    "get /getHeight": "getHeight",
    "get /getMilestone": "getMilestone",
    "get /getReward": "getReward",
    "get /getSupply": "getSupply",
    "get /getStatus": "getStatus"
  });

  router.use(function (req, res, next) {
    res.status(500).send({ success: false, error: "API endpoint not found" });
  });

  library.network.app.use('/api/blocks', router);
  library.network.app.use(function (err, req, res, next) {
    if (!err) return next();
    library.logger.error(req.url, err.toString());
    res.status(500).send({ success: false, error: err.toString() });
  });
}

private.saveGenesisBlock = function (cb) {
  library.dbLite.query("SELECT id FROM blocks WHERE id=$id", { id: genesisblock.block.id }, ['id'], function (err, rows) {
    if (err) {
      return cb(err)
    }
    var blockId = rows.length && rows[0].id;

    if (!blockId) {
      library.dbLite.query("SAVEPOINT savegenesisblock");
      private.saveBlock(genesisblock.block, function (err) {
        if (err) {
          library.logger.error('saveGenesisBlock error', err);
          library.dbLite.query("ROLLBACK TO SAVEPOINT savegenesisblock", function (rollbackErr) {
            if (rollbackErr) {
              library.logger.error("Failed to rollback savegenesisblock: " + rollBackErr);
            }
            process.exit(1);
          });
        } else {
          library.dbLite.query("RELEASE SAVEPOINT savegenesisblock", function (releaseErr) {
            if (releaseErr) {
              library.logger.error("Failed to commit genesis block: " + releaseErr);
              process.exit(1);
            } else {
              cb();
            }
          });
        }
      });
    } else {
      cb()
    }
  });
}

private.deleteBlock = function (blockId, cb) {
  library.dbLite.query("DELETE FROM blocks WHERE id = $id", { id: blockId }, function (err, res) {
    cb(err, res);
  });
}

private.list = function (filter, cb) {
  var sortFields = ['b.id', 'b.timestamp', 'b.height', 'b.prevBlockId', 'b.totalAmount', 'b.totalFee', 'b.reward', 'b.numberOfTransactions', 'b.generatorPublicKey'];
  var params = {}, fields = [], sortMethod = '', sortBy = '';
  if (filter.generatorPublicKey) {
    fields.push('lower(hex(generatorPublicKey)) = $generatorPublicKey')
    params.generatorPublicKey = filter.generatorPublicKey;
  }

  if (filter.numberOfTransactions) {
    fields.push('numberOfTransactions = $numberOfTransactions');
    params.numberOfTransactions = filter.numberOfTransactions;
  }

  if (filter.prevBlockId) {
    fields.push('prevBlockId = $prevBlockId');
    params.prevBlockId = filter.prevBlockId;
  }

  if (filter.height === 0 || filter.height > 0) {
    fields.push('height = $height');
    params.height = filter.height;
  }

  if (filter.totalAmount >= 0) {
    fields.push('totalAmount = $totalAmount');
    params.totalAmount = filter.totalAmount;
  }

  if (filter.totalFee >= 0) {
    fields.push('totalFee = $totalFee');
    params.totalFee = filter.totalFee;
  }

  if (filter.reward >= 0) {
    fields.push('reward = $reward');
    params.reward = filter.reward;
  }

  if (filter.orderBy) {
    var sort = filter.orderBy.split(':');
    sortBy = sort[0].replace(/[^\w\s]/gi, '');
    sortBy = "b." + sortBy;
    if (sort.length == 2) {
      sortMethod = sort[1] == 'desc' ? 'desc' : 'asc'
    } else {
      sortMethod = 'desc';
    }
  }


  if (sortBy) {
    if (sortFields.indexOf(sortBy) < 0) {
      return cb("Invalid sort field");
    }
  }

  if (!filter.limit) {
    filter.limit = 100;
  }

  if (!filter.offset) {
    filter.offset = 0;
  }

  params.limit = filter.limit;
  params.offset = filter.offset;

  if (filter.limit > 100) {
    return cb("Invalid limit. Maximum is 100");
  }

  library.dbLite.query("select count(b.id) " +
    "from blocks b " +
    (fields.length ? "where " + fields.join(' and ') : ''), params, { count: Number }, function (err, rows) {
      if (err) {
        return cb(err);
      }

      var count = rows[0].count;
      library.dbLite.query("select b.id, b.version, b.timestamp, b.height, b.prevBlockId, b.numberOfTransactions, b.totalAmount, b.totalFee, b.reward, b.payloadLength, lower(hex(b.payloadHash)), lower(hex(b.generatorPublicKey)), lower(hex(b.blockSignature)), (select max(height) + 1 from blocks) - b.height " +
        "from blocks b " +
        (fields.length ? "where " + fields.join(' and ') : '') + " " +
        (filter.orderBy ? 'order by ' + sortBy + ' ' + sortMethod : '') + " limit $limit offset $offset ", params, ['b_id', 'b_version', 'b_timestamp', 'b_height', 'b_prevBlockId', 'b_numberOfTransactions', 'b_totalAmount', 'b_totalFee', 'b_reward', 'b_payloadLength', 'b_payloadHash', 'b_generatorPublicKey', 'b_blockSignature', 'b_confirmations'], function (err, rows) {
          if (err) {
            library.logger.error(err);
            return cb(err);
          }

          var blocks = [];
          for (var i = 0; i < rows.length; i++) {
            blocks.push(library.base.block.dbRead(rows[i]));
          }

          var data = {
            blocks: blocks,
            count: count
          }

          cb(null, data);
        });
    });
}

private.getByField = function (field, cb) {
  var condition = "b." + field.key + " = $" + field.key;
  var values = {};
  values[field.key] = field.value;
  library.dbLite.query("select b.id, b.version, b.timestamp, b.height, b.prevBlockId, b.numberOfTransactions, b.totalAmount, b.totalFee, b.reward, b.payloadLength,  lower(hex(b.payloadHash)), lower(hex(b.generatorPublicKey)), lower(hex(b.blockSignature)), (select max(height) + 1 from blocks) - b.height " +
    "from blocks b " +
    "where " + condition, values, ['b_id', 'b_version', 'b_timestamp', 'b_height', 'b_prevBlockId', 'b_numberOfTransactions', 'b_totalAmount', 'b_totalFee', 'b_reward', 'b_payloadLength', 'b_payloadHash', 'b_generatorPublicKey', 'b_blockSignature', 'b_confirmations'], function (err, rows) {
      if (err || !rows.length) {
        return cb(err || "Block not found");
      }

      var block = library.base.block.dbRead(rows[0]);
      cb(null, block);
    });
}

private.getIdSequence2 = function (height, cb) {
  (async () => {
    try {
      let maxHeight = Math.max(height, private.lastBlock.height)
      let minHeight = Math.max(0, maxHeight - 4)
      let blocks = await app.sdb.getBlocksByHeightRange(minHeight, maxHeight)
      blocks = blocks.reverse()
      let ids = blocks.map((b) => b.id)
      return cb(null, { ids: ids, firstHeight: minHeight })
    } catch (e) {
      cb(e)
    }
  })()
}

// Public methods
Blocks.prototype.getCommonBlock = function (peer, height, cb) {
  var commonBlock = null;
  var lastBlockHeight = height;
  var count = 0;

  private.getIdSequence2(lastBlockHeight, function (err, data) {
    if (err) {
      return cb('Failed to get last block id sequence' + err)
    }
    library.logger.trace('getIdSequence=========', data)
    const params = {
      body: {
        max: lastBlockHeight,
        min: data.firstHeight,
        ids: data.ids
      }
    }
    modules.peer.request('commonBlock', params, peer, function (err, ret) {
      if (err || ret.error) {
        return cb(err || ret.error.toString());
      }

      if (!ret.common) {
        return cb('Common block not found');
      }
      cb(null, ret.common)
    });
  });
}

Blocks.prototype.getBlock = function (filter, cb) {
  shared.getBlock({ body: filter }, cb);
}

Blocks.prototype.setLastBlock = function (block) {
  private.lastBlock = block
  if (global.Config.netVersion === 'mainnet') {
    global.featureSwitch.enableLongId = private.lastBlock.height >= 1700000
    global.featureSwitch.enable1_3_0 = private.lastBlock.height >= 2920000
    global.featureSwitch.enableClubBonus = private.lastBlock.height >= 3320000
    global.featureSwitch.enableMoreLockTypes = global.featureSwitch.enableClubBonus
    global.featureSwitch.enableLockReset = private.lastBlock.height >= 4290000
  } else {
    global.featureSwitch.enableLongId = true
    global.featureSwitch.enable1_3_0 = true
    global.featureSwitch.enableClubBonus = (!!global.state.clubInfo)
    global.featureSwitch.enableMoreLockTypes = true
    global.featureSwitch.enableLockReset = true
  }
  global.featureSwitch.fixVoteNewAddressIssue = true
  if (global.Config.netVersion === 'mainnet' && private.lastBlock.height < 1854000) {
    global.featureSwitch.fixVoteNewAddressIssue = false
  }
  global.featureSwitch.enableUIA = global.featureSwitch.enableLongId
}

Blocks.prototype.getLastBlock = function () {
  return private.lastBlock;
}

Blocks.prototype.verifyBlock = async function (block, options) {
  try {
    block.id = library.base.block.getId(block);
  } catch (e) {
    throw new Error("Failed to get block id: " + e.toString());
  }

  if (typeof block.height !== 'undefined' && !!private.lastBlock.id) {
    block.height = private.lastBlock.height + 1;
  }

  library.logger.debug("verifyBlock, id: " + block.id + ", h: " + block.height);

  if (!block.prevBlockId && block.height != 0) {
    throw new Error("Previous block should not be null");
  }

  // var expectedReward = private.blockStatus.calcReward(block.height);

  // if (block.height != 1 && expectedReward !== block.reward) {
  //   return cb("Invalid block reward");
  // }

  try {
    if (!library.base.block.verifySignature(block)) {
      throw new Error("Failed to verify block signature");
    }
  } catch (e) {
    throw new Error("Got exception while verify block signature: " + e.toString());
  }

  if (block.prevBlockId != private.lastBlock.id) {
    throw new Error('Incorrect previous block hash');
  }

  // if (block.version > 0) {
  //   return cb("Invalid block version: " + block.version + ", id: " + block.id);
  // }

  if (block.height !== 0) {
    var blockSlotNumber = slots.getSlotNumber(block.timestamp);
    var lastBlockSlotNumber = slots.getSlotNumber(private.lastBlock.timestamp);

    if (blockSlotNumber > slots.getSlotNumber() + 1 || blockSlotNumber <= lastBlockSlotNumber) {
      throw new Error("Can't verify block timestamp: " + block.id);
    }
  }

  // if (block.payloadLength > constants.maxPayloadLength) {
  //   throw new Error("Can't verify payload length of block: " + block.id);
  // }

  if (block.transactions.length > constants.maxTxsPerBlock) {
    throw new Error("Invalid amount of block assets: " + block.id);
  }
  if (block.transactions.length !== block.count) {
    throw new Error('Invalid transaction count')
  }

  var payloadHash = crypto.createHash('sha256')
  var appliedTransactions = {}

  let totalFee = 0
  for (var i in block.transactions) {
    var transaction = block.transactions[i];
    totalFee += transaction.fee

    try {
      var bytes = library.base.transaction.getBytes(transaction);
    } catch (e) {
      throw new Error("Failed to get transaction bytes: " + e.toString());
    }

    if (appliedTransactions[transaction.id]) {
      throw new Error("Duplicate transaction id in block " + block.id);
    }

    appliedTransactions[transaction.id] = transaction;
    payloadHash.update(bytes);
  }

  if (totalFee !== block.fees) {
    throw new Error('Invalid total fees')
  }

  if (payloadHash.digest().toString('hex') !== block.payloadHash) {
    throw new Error("Invalid payload hash: " + block.id);
  }

  if (options.votes) {
    let votes = options.votes
    if (block.height != votes.height) {
      throw new Error("Votes height is not correct");
    }
    if (block.id != votes.id) {
      throw new Error("Votes id is not correct");
    }
    if (!votes.signatures || !library.base.consensus.hasEnoughVotesRemote(votes)) {
      throw new Error("Votes signature is not correct");
    }
    await self.verifyBlockVotes(block, votes);
  }
}

Blocks.prototype.verifyBlockVotes = async function (block, votes) {
  // FIXME
  return true
}

Blocks.prototype.applyBlock = async function (block, options) {
  app.logger.trace('enter applyblock')
  let appliedTransactions = {}

  try {
    for (let i in block.transactions) {
      let transaction = block.transactions[i]
      transaction.senderId = modules.accounts.generateAddressByPublicKey(transaction.senderPublicKey)

      if (appliedTransactions[transaction.id]) {
        throw new Error("Duplicate transaction in block: " + transaction.id)
      }

      let senderId = transaction.senderId
      let sender = await app.sdb.get('Account', senderId)
      if (!sender) {
        if (block.height === 0) {
          sender = app.sdb.create('Account', {
            address: senderId,
            name: '',
            xas: 0
          })
        } else {
          throw new Error('Sender account not found')
        }
      }
      let context = {
        trs: transaction,
        block: block,
        sender: sender
      }
      await library.base.transaction.apply(context)
      // TODO not just remove, should mark as applied
      // modules.blockchain.transactions.removeUnconfirmedTransaction(transaction.id)
      appliedTransactions[transaction.id] = transaction
    }
  } catch (e) {
    app.logger.error(e)
    await app.sdb.rollbackBlock()
    throw new Error('Failed to apply block: ' + e)
  }
}

Blocks.prototype.processBlock = async function (block, options) {
  if (!private.loaded) throw new Error('Blockchain is loading')

  app.sdb.beginBlock(block)
  if (!block.transactions) block.transactions = []
  if (!options.local) {
    try {
      block = library.base.block.objectNormalize(block)
    } catch (e) {
      library.logger.error('Failed to normalize block: ' + e, block)
      throw e
    }

    // TODO sort transactions
    // block.transactions = library.base.block.sortTransactions(block)
    await self.verifyBlock(block, options)

    library.logger.debug("verify block ok");
    if (block.height !== 0) {
      let exists = (undefined !== await app.sdb.getBlockById(block.id))
      if (exists) throw new Error('Block already exists: ' + block.id)
    }

    if (block.height !== 0) {
      try {
        await PIFY(modules.delegates.validateBlockSlot)(block)
      } catch (e) {
        library.logger.error(e)
        throw new Error("Can't verify slot: " + e)
      }
      library.logger.debug("verify block slot ok")
    }

    // TODO use bloomfilter
    for (let i in block.transactions) {
      let transaction = block.transactions[i]
      library.base.transaction.objectNormalize(transaction)
    }
    let idList = block.transactions.map((t) => t.id)
    if (await app.sdb.exists('Transaction', { id: { $in: idList } })) {
      throw new Error('Block contain already confirmed transaction')
    }

    app.logger.trace('before applyBlock')
    try {
      await self.applyBlock(block, options)
    } catch (e) {
      app.logger.error('Failed to apply block: ' + e)
      throw e
    }
  }

  try {
    self.saveBlockTransactions(block)
    await self.applyRound(block)
    await app.sdb.commitBlock()
    let trsCount = block.transactions.length
    app.logger.info('Block applied correctly with ' + trsCount + ' transactions')
    self.setLastBlock(block);

    if (options.broadcast) {
      options.votes.signatures = options.votes.signatures.slice(0, 6);
      library.bus.message('newBlock', block, options.votes);
    }
  } catch (e) {
    app.logger.error('save block error: ', e)
    await app.sdb.rollbackBlock()
    throw new Error('Failed to save block: ' + e)
  } finally {
    private.blockCache = {};
    private.proposeCache = {};
    private.lastVoteTime = null;
    library.base.consensus.clearState();
  }
}

Blocks.prototype.saveBlockTransactions = function (block) {
  app.logger.trace('Blocks#saveBlockTransactions height', block.height)
  for (let i in block.transactions) {
    let trs = block.transactions[i]
    trs.height = block.height
    trs.args = JSON.stringify(trs.args)
    trs.signatures = JSON.stringify(trs.signatures)
    app.sdb.create('Transaction', trs)
  }
  app.logger.trace('Blocks#save transactions')
}

// Blocks.prototype.processFee = function (block) {
//   if (!block || !block.transactions) return
//   for (let t of block.transactions) {
//     let feeInfo = app.getFee(t.type) || app.defaultFee
//     app.feePool.add(feeInfo.currency, t.fee)
//   }
// }

Blocks.prototype.applyRound = async function (block) {
  if (block.height === 0) {
    modules.delegates.updateBookkeeper()
    return
  }

  let delegate = app.sdb.getCached('Delegate', modules.accounts.generateAddressByPublicKey(block.delegate))
  delegate.producedBlocks += 1

  let delegates = await PIFY(modules.delegates.generateDelegateList)(block.height)

  // process fee
  let roundNumber = Math.floor((block.height + delegates.length - 1) / delegates.length)

  let round = await app.sdb.get('Round', roundNumber) ||
    app.sdb.create('Round', { fees: 0, rewards: 0, round: roundNumber })

  let transFee = 0
  for (let t of block.transactions) {
    transFee += t.fee
  }

  round.fees += transFee
  round.rewards += private.blockStatus.calcReward(block.height)

  if (block.height % 101 !== 0) return

  app.logger.debug('----------------------on round ' + roundNumber + ' end-----------------------')
  app.logger.debug('delegate length', delegates.length)

  let forgedBlocks = await app.sdb.getBlocksByHeightRange(block.height - 100, block.height - 1)
  let forgedDelegates = forgedBlocks.map(function (b) {
    // FIXME getBlocksByHeight should return clean object
    return b.delegate
  })
  forgedDelegates.push(block.delegate)
  let missedDelegates = []
  for (let fd of forgedDelegates) {
    if (delegates.indexOf(fd) == -1) {
      missedDelegates.push(fd)
    }
  }
  for (let md of missedDelegates) {
    let addr = modules.accounts.generateAddressByPublicKey(md)
    app.sdb.getCached('Delegate', addr).missedBlocks += 1
  }

  let fees = round.fees
  let rewards = round.rewards
  let ratio = 1

  let actualFees = Math.floor(fees * ratio)
  let feeAverage = Math.floor(actualFees / delegates.length)
  let feeRemainder = actualFees - feeAverage * delegates.length
  //let feeFounds = fees - actualFees

  let actualRewards = Math.floor(rewards * ratio)
  let rewardAverage = Math.floor(actualRewards / delegates.length)
  let rewardRemainder = actualRewards - rewardAverage * delegates.length
  //let rewardFounds = rewards - actualRewards

  async function updateDelegate(pk, fee, reward) {
    let addr = modules.accounts.generateAddressByPublicKey(pk)
    let delegate = app.sdb.getCached('Delegate', addr)
    delegate.fees += fee
    delegate.rewards += reward
    // TODO should account be all cached?
    let account = await app.sdb.get('Account', delegate.address)
    account.xas += (fee + reward)
  }

  for (let fd of forgedDelegates) {
    await updateDelegate(fd, feeAverage, rewardAverage)
  }
  await updateDelegate(block.delegate, feeRemainder, rewardRemainder)

  // let totalClubFounds = feeFounds + rewardFounds
  // app.logger.info('Asch witness club get new founds: ' + totalClubFounds)
  // // FIXME dapp id
  // app.balances.increase('club_dapp_id', 'XAS', totalClubFounds)

  if (block.height % 101 === 0) {
    modules.delegates.updateBookkeeper()
  }
}

Blocks.prototype.loadBlocksFromPeer = function (peer, lastCommonBlockId, cb) {
  var loaded = false;
  var count = 0;
  var lastValidBlock = null;

  async.whilst(
    function () {
      return !loaded && count < 30;
    },
    function (next) {
      count++;
      const params = {
        body: {
          lastBlockId: lastCommonBlockId,
          limit: 200
        }
      }
      modules.peer.request('blocks', params, peer, function (err, ret) {
        if (err || ret.error) {
          return next(err || ret.error.toString());
        }
        const contact = peer[1]
        const peerStr = contact.hostname + ':' + contact.port
        const blocks = ret.blocks;
        library.logger.log('Loading ' + blocks.length + ' blocks from', peerStr);
        if (blocks.length == 0) {
          loaded = true;
          next();
        } else {
          (async function () {
            try {
              for (let block of blocks) {
                await self.processBlock(block, { syncing: true })
                lastCommonBlockId = block.id;
                lastValidBlock = block;
                library.logger.log('Block ' + block.id + ' loaded from ' + peerStr + ' at', block.height);
              }
              next()
            } catch (e) {
              library.logger.error('Failed to process synced block', e)
              return cb(e)
            }
          })()
        }
      });
    },
    function (err) {
      setImmediate(cb, err, lastValidBlock);
    }
  )
}

Blocks.prototype.generateBlock = async function (keypair, timestamp) {
  let unconfirmedList = modules.transactions.getUnconfirmedTransactionList()
  let payloadHash = crypto.createHash('sha256')
  let payloadLength = 0
  let fees = 0
  for (let i in unconfirmedList) {
    let transaction = unconfirmedList[i]
    fees += transaction.fee
    let bytes = library.base.transaction.getBytes(transaction)
    // TODO check payload length when process remote block
    if ((payloadLength + bytes.length) > 8 * 1024 * 1024) {
      throw new Error('Playload length outof range')
    }
    payloadHash.update(bytes)
    payloadLength += bytes.length
  }
  var block = {
    version: 0,
    delegate: keypair.publicKey.toString("hex"),
    height: private.lastBlock.height + 1,
    prevBlockId: private.lastBlock.id,
    timestamp: timestamp,
    transactions: unconfirmedList,
    count: unconfirmedList.length,
    fees: fees,
    payloadHash: payloadHash.digest().toString("hex")
  }

  block.signature = library.base.block.sign(block, keypair)
  block.id = library.base.block.getId(block)

  let activeKeypairs
  try {
    activeKeypairs = await PIFY(modules.delegates.getActiveDelegateKeypairs)(block.height)
  } catch (e) {
    throw new Error('Failed to get active delegate keypairs: ' + e)
  }

  var height = block.height;
  var id = block.id;
  assert(activeKeypairs && activeKeypairs.length > 0, "Active keypairs should not be empty");
  library.logger.info("get active delegate keypairs len: " + activeKeypairs.length);
  var localVotes = library.base.consensus.createVotes(activeKeypairs, block);
  if (library.base.consensus.hasEnoughVotes(localVotes)) {
    modules.transactions.clearUnconfirmed()
    await this.processBlock(block, { local: true, broadcast: true, votes: localVotes })
    library.logger.log('Forged new block id: ' + id +
      ' height: ' + height +
      ' round: ' + modules.round.calc(height) +
      ' slot: ' + slots.getSlotNumber(block.timestamp) +
      ' reward: ' + private.blockStatus.calcReward(block.height));
  } else {
    if (!library.config.publicIp) {
      return next("No public ip");
    }
    var serverAddr = library.config.publicIp + ':' + library.config.port;
    var propose;
    try {
      propose = library.base.consensus.createPropose(keypair, block, serverAddr);
    } catch (e) {
      return next("Failed to create propose: " + e.toString());
    }
    library.base.consensus.setPendingBlock(block);
    library.base.consensus.addPendingVotes(localVotes);
    private.proposeCache[propose.hash] = true;
    library.bus.message("newPropose", propose, true);
  }
}

Blocks.prototype.sandboxApi = function (call, args, cb) {
  sandboxHelper.callMethod(shared, call, args, cb);
}

// Events
Blocks.prototype.onReceiveBlock = function (block, votes) {
  if (modules.loader.syncing() || !private.loaded) {
    return;
  }

  if (private.blockCache[block.id]) {
    return;
  }
  private.blockCache[block.id] = true;

  library.sequence.add(function receiveBlock(cb) {
    if (block.prevBlockId == private.lastBlock.id && private.lastBlock.height + 1 == block.height) {
      library.logger.info('Received new block id: ' + block.id + ' height: ' + block.height + ' round: ' + modules.round.calc(modules.blocks.getLastBlock().height) + ' slot: ' + slots.getSlotNumber(block.timestamp));

      (async function () {
        let pendingTrsMap = new Map()
        try {
          const pendingTrs = modules.transactions.getUnconfirmedTransactionList()
          for (let t of pendingTrs) {
            pendingTrsMap.set(t.id, t)
          }
          modules.transactions.clearUnconfirmed()
          await app.sdb.rollbackBlock()
          await self.processBlock(block, { votes: votes, broadcast: true })
        } catch (e) {
          library.logger.error('Failed to process received block', e)
        } finally {
          for (let t of block.transactions) {
            pendingTrsMap.delete(t.id)
          }
          try {
            await modules.transactions.applyTransactionsAsync([...pendingTrsMap.values()])
          } catch (e) {
            library.logger.error('Failed to redo unconfirmed transactions', e)
          }
          cb()
        }
      })()
    } else if (block.prevBlockId != private.lastBlock.id && private.lastBlock.height + 1 == block.height) {
      // Fork: Same height but different previous block id
      modules.delegates.fork(block, 1);
      cb("Fork");
    } else if (block.prevBlockId == private.lastBlock.prevBlockId && block.height == private.lastBlock.height && block.id != private.lastBlock.id) {
      // Fork: Same height and previous block id, but different block id
      modules.delegates.fork(block, 5);
      cb("Fork");
    } else if (block.height > private.lastBlock.height + 1) {
      library.logger.info("receive discontinuous block height " + block.height);
      modules.loader.startSyncBlocks();
      cb();
    } else {
      cb();
    }
  });
}

Blocks.prototype.onReceivePropose = function (propose) {
  if (modules.loader.syncing() || !private.loaded) {
    return;
  }
  if (private.proposeCache[propose.hash]) {
    return;
  }
  private.proposeCache[propose.hash] = true;

  library.sequence.add(function receivePropose(cb) {
    if (private.lastPropose && private.lastPropose.height == propose.height &&
      private.lastPropose.generatorPublicKey == propose.generatorPublicKey &&
      private.lastPropose.id != propose.id) {
      library.logger.warn("generate different block with the same height, generator: " + propose.generatorPublicKey);
      return setImmediate(cb);
    }
    if (propose.height != private.lastBlock.height + 1) {
      library.logger.debug("invalid propose height", propose);
      if (propose.height > private.lastBlock.height + 1) {
        library.logger.info("receive discontinuous propose height " + propose.height);
        modules.loader.startSyncBlocks();
      }
      return setImmediate(cb);
    }
    if (private.lastVoteTime && Date.now() - private.lastVoteTime < 5 * 1000) {
      library.logger.debug("ignore the frequently propose");
      return setImmediate(cb);
    }
    library.logger.info("receive propose height " + propose.height + " bid " + propose.id);
    library.bus.message("newPropose", propose, true);
    async.waterfall([
      function (next) {
        modules.delegates.validateProposeSlot(propose, function (err) {
          if (err) {
            next("Failed to validate propose slot: " + err);
          } else {
            next();
          }
        });
      },
      function (next) {
        library.base.consensus.acceptPropose(propose, function (err) {
          if (err) {
            next("Failed to accept propose: " + err);
          } else {
            next();
          }
        });
      },
      function (next) {
        modules.delegates.getActiveDelegateKeypairs(propose.height, function (err, activeKeypairs) {
          if (err) {
            next("Failed to get active keypairs: " + err);
          } else {
            next(null, activeKeypairs);
          }
        });
      },
      function (activeKeypairs, next) {
        if (activeKeypairs && activeKeypairs.length > 0) {
          var votes = library.base.consensus.createVotes(activeKeypairs, propose);
          library.logger.debug("send votes height " + votes.height + " id " + votes.id + " sigatures " + votes.signatures.length);
          modules.transport.sendVotes(votes, propose.address);
          private.lastVoteTime = Date.now();
          private.lastPropose = propose;
        }
        setImmediate(next);
      }
    ], function (err) {
      if (err) {
        library.logger.error("onReceivePropose error: " + err);
      }
      library.logger.debug("onReceivePropose finished");
      cb();
    });
  });
}

Blocks.prototype.onReceiveVotes = function (votes) {
  if (modules.loader.syncing() || !private.loaded) {
    return;
  }
  library.sequence.add(function receiveVotes(cb) {
    var totalVotes = library.base.consensus.addPendingVotes(votes);
    if (totalVotes && totalVotes.signatures) {
      library.logger.debug("receive new votes, total votes number " + totalVotes.signatures.length);
    }
    if (library.base.consensus.hasEnoughVotes(totalVotes)) {
      var block = library.base.consensus.getPendingBlock();
      var height = block.height;
      var id = block.id;
      (async function () {
        try {
          modules.transactions.clearUnconfirmed()
          await self.processBlock(block, { votes: totalVotes, local: true, broadcast: true })
          library.logger.log('Forged new block id: ' + id +
            ' height: ' + height +
            ' round: ' + modules.round.calc(height) +
            ' slot: ' + slots.getSlotNumber(block.timestamp) +
            ' reward: ' + private.blockStatus.calcReward(block.height));
        } catch (e) {
          library.logger.error("Failed to process confirmed block height: " + height + " id: " + id + " error: " + err);
        }
        cb()
      })()
    } else {
      setImmediate(cb);
    }
  });
}

Blocks.prototype.getSupply = function () {
  let height = private.lastBlock.height
  return private.blockStatus.calcSupply(height)
}

Blocks.prototype.getCirculatingSupply = function () {
  let height = private.lastBlock.height
  return private.blockStatus.calcSupply(height)
}

Blocks.prototype.onBind = function (scope) {
  modules = scope;

  private.loaded = true;

  (async () => {
    try {
      let count = app.sdb.blocksCount
      app.logger.info('Blocks found:', count)
      if (!count) {
        await self.processBlock(genesisblock.block, {})
      } else {
        let block = await app.sdb.getBlockByHeight(count - 1)
        self.setLastBlock(block)
      }
      library.bus.message('blockchainReady')
    } catch (e) {
      app.logger.error('Failed to prepare local blockchain', e)
      process.exit(0)
    }
  })()
}

Blocks.prototype.cleanup = function (cb) {
  private.loaded = false;
  cb();
}

// Shared
shared.getBlock = function (req, cb) {
  if (!private.loaded) {
    return cb("Blockchain is loading")
  }
  var query = req.body;
  library.scheme.validate(query, {
    type: "object",
    properties: {
      id: {
        type: 'string',
        minLength: 1
      },
      height: {
        type: 'integer',
        minimum: 1
      }
    }
  }, function (err) {
    if (err) {
      return cb(err[0].message);
    }

    (async function () {
      try {
        let block
        if (query.id) {
          block = await app.sdb.getBlockById(query.id)
        } else if (query.height) {
          block = await app.sdb.getBlockByHeight(query.height)
        }

        if (!block) {
          return cb('Block not found')
        }
        block.reward = private.blockStatus.calcReward(block.height)
        return cb(null, { block })
      } catch (e) {
        library.logger.error(e)
        return cb('Server error')
      }
    })()
  });
}

shared.getFullBlock = function (req, cb) {
  if (!private.loaded) {
    return cb("Blockchain is loading")
  }
  var query = req.body;
  library.scheme.validate(query, {
    type: "object",
    properties: {
      id: {
        type: 'string',
        minLength: 1
      },
      height: {
        type: 'integer',
        minimum: 1
      }
    }
  }, function (err) {
    if (err) {
      return cb(err[0].message);
    }

    (async function () {
      try {
        let block
        if (query.id) {
          block = await app.getBlockById(query.id, true)
        } else if (query.height) {
          block = await app.getBlock(query.height, true)
        }

        if (!block) return cb('Block not found')
        return cb(null, { block: block })
      } catch (e) {
        library.logger.error('Failed to find block', e)
        return cb('Server error')
      }
    })()

  });
}

shared.getBlocks = function (req, cb) {
  if (!private.loaded) {
    return cb("Blockchain is loading")
  }
  var query = req.body;
  library.scheme.validate(query, {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 0,
        maximum: 100
      },
      offset: {
        type: "integer",
        minimum: 0
      },
      generatorPublicKey: {
        type: "string",
        format: "publicKey"
      }
    }
  }, function (err) {
    if (err) {
      return cb(err[0].message);
    }

    (async function () {
      try {
        let offset = query.offset ? Number(query.offset) : 0
        let limit = query.limit ? Number(query.limit) : 20
        let minHeight
        let maxHeight
        if (query.orderBy === 'height:desc') {
          maxHeight = private.lastBlock.height - offset
          minHeight = maxHeight - limit + 1
        } else {
          minHeight = offset
          maxHeight = offset + limit - 1
        }

        //TODO: get by delegate ??
        // if (query.generatorPublicKey) {
        //   condition.delegate = query.generatorPublicKey
        // }
        let count = app.sdb.blocksCount
        if (!count) throw new Error('Failed to get blocks count')

        let blocks = await app.sdb.getBlocksByHeightRange(minHeight, maxHeight)
        if (!blocks || !blocks.length) return cb('No blocks')
        return cb(null, { count, blocks })
      } catch (e) {
        library.logger.error('Failed to find blocks', e)
        return cb('Server error')
      }
    })()
  });
}

shared.getHeight = function (req, cb) {
  if (!private.loaded) {
    return cb("Blockchain is loading")
  }
  var query = req.body;
  cb(null, { height: private.lastBlock.height });
}

shared.getMilestone = function (req, cb) {
  if (!private.loaded) {
    return cb("Blockchain is loading")
  }
  var query = req.body, height = private.lastBlock.height;
  cb(null, { milestone: private.blockStatus.calcMilestone(height) });
}

shared.getReward = function (req, cb) {
  if (!private.loaded) {
    return cb("Blockchain is loading")
  }
  var query = req.body, height = private.lastBlock.height;
  cb(null, { reward: private.blockStatus.calcReward(height) });
}

shared.getSupply = function (req, cb) {
  if (!private.loaded) {
    return cb("Blockchain is loading")
  }
  var query = req.body, height = private.lastBlock.height;
  cb(null, { supply: private.blockStatus.calcSupply(height) });
}

shared.getStatus = function (req, cb) {
  if (!private.loaded) {
    return cb("Blockchain is loading")
  }
  var query = req.body, height = private.lastBlock.height;
  cb(null, {
    height: height,
    fee: library.base.block.calculateFee(),
    milestone: private.blockStatus.calcMilestone(height),
    reward: private.blockStatus.calcReward(height),
    supply: private.blockStatus.calcSupply(height)
  });
}

// Export
module.exports = Blocks;
