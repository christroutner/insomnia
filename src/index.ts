import { config } from './config';
import fs from 'fs';
import { Cluster } from 'electrum-cash';
import express from 'express';
import bodyParser from 'body-parser';
import bitcore from 'bitcore-lib-cash';
import {
  GenesisParseResult,
  MintParseResult,
  SendParseResult,
  parseSLP
} from 'slp-parser';
import morgan from 'morgan';
import rateLimit from "express-rate-limit";


const electrum = new Cluster(
  config.electrum.application,
  config.electrum.version,
  config.electrum.confidence,
  config.electrum.distribution,
  Cluster.ORDER.PRIORITY
);

for (const server of config.electrum.servers) {
  const [host, port] = server.split(':');
  if (typeof(host) === 'undefined' || typeof(port) === 'undefined') {
    throw new Error("server field has bad format (should be host:port)");
  }
  electrum.addServer(host, port);
}

const apiLimiter = rateLimit({
  ...config.ratelimit,
  ...{
    message: {
      success: false,
      message: "Too many requests"
    }
  }
});

const app = express();
app.use(bodyParser.text({ limit: '100kb' }));
app.disable('x-powered-by');
app.use('/v1/', apiLimiter);

app.use(express.static('public'));

app.use(morgan('dev', {
  // skip: (req, res) => res.statusCode < 400
}));

const router = express.Router();
app.use('/v1', router);

router.get('/tx/data/:txid', async (req, res) => {
  const transactionID = req.params.txid;
  const verbose = req.query.verbose || false;
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.get', transactionID, false);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  let response = null;
  if (! verbose) {
    response = electrumResponse;
  } else {
    try {
      const tx = new bitcore.Transaction(electrumResponse);
      response = tx.toJSON();
      if (response.outputs.length > 0) {
        try {
          const parsed = parseSLP(response.outputs[0].script);
          const fmtd: any = parsed;
          if (parsed.transactionType === "GENESIS") {
            let o = parsed.data as GenesisParseResult;
            fmtd.data.ticker       = o.ticker.toString('hex');
            fmtd.data.name         = o.ticker.toString('hex');
            fmtd.data.documentUri  = o.documentUri.toString('hex');
            fmtd.data.documentHash = o.documentHash.toString('hex');
          }
          else if (parsed.transactionType === "MINT") {
            let o = parsed.data as MintParseResult;
            fmtd.data.tokenid = o.tokenid.toString('hex');
          }
          else if (parsed.transactionType === "SEND") {
            let o = parsed.data as SendParseResult;
            fmtd.data.tokenid  = o.tokenid.toString('hex');
          }

          response.slp = parsed;
        } catch (e) {
          response.slp = {
            error: e.message
          }
        }
      }
    } catch (e) {
      return res.status(500).send({
        success: false,
        message: e.message,
      });
    }
  }

  return res.send({
    success: true,
    tx:      response,
  });
});

router.get('/tx/merkle/:txid/:height', async (req, res) => {
  const transactionID = req.params.txid;
  const blockHeight = req.params.height;
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.get_merkle', transactionID, blockHeight);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    merkle: electrumResponse.merkle,
  });
});

router.post('/tx/broadcast', async (req, res) => {
  const transactionHex = req.body;
  try {
    var electrumResponse = await electrum.request('blockchain.transaction.broadcast', transactionHex);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  if (! electrumResponse.match(/[a-f0-9]{64}/)) {
    return res.status(400).send({
      success: false,
      message: electrumResponse,
    });
  }

  return res.send({
    success: true,
    txid: electrumResponse,
  });
});

router.get('/block/headers/:height', async (req, res) => {
  const blockHeight = req.params.height;
  const count = req.query.count || 1;
  const cpHeight = req.query.cp_height || 0;
  try {
    var electrumResponse = await electrum.request('blockchain.block.headers', blockHeight, count, cpHeight);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    headers: electrumResponse.hex.match(/.{160}/g),
  });
});


const addressToScripthash = (addrstr: string) => {
  const address = bitcore.Address.fromString(addrstr)
  const script = bitcore.Script.buildPublicKeyHashOut(address);
  const scripthash = bitcore.crypto.Hash.sha256(script.toBuffer()).reverse().toString('hex');

  return scripthash;
}

router.get('/address/balance/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_balance', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    confirmed: electrumResponse.confirmed,
    unconfirmed: electrumResponse.unconfirmed,
  });
});

router.get('/address/history/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_history', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    txs: electrumResponse,
  });
});

router.get('/address/mempool/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.get_mempool', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    txs: electrumResponse,
  });
});

router.get('/address/utxos/:address', async (req, res) => {
  try {
    var scripthash = addressToScripthash(req.params.address);
  } catch (e) {
    return res.status(400).send({
      success: false,
      message: 'could not decode address',
    });
  }

  try {
    var electrumResponse = await electrum.request('blockchain.scripthash.listunspent', scripthash);
  } catch (e) {
    return res.status(500).send({
      success: false,
      message: e.message,
    });
  }

  if (electrumResponse.hasOwnProperty("code")) {
    return res.status(400).send({
      success: false,
      message: electrumResponse.message,
    });
  }

  return res.send({
    success: true,
    utxos: electrumResponse,
  });
});


(async () => {
  await electrum.ready();
  app.listen(config.port);
  console.log('listening on port', config.port);

  process.on('beforeExit', async () => {
    await electrum.shutdown();
    process.exit(0);
  });
})();
