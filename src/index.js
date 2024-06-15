import {
  Connection,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SendTransactionError,
  TransactionExpiredBlockheightExceededError,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getBase58Decoder } from '@solana/codecs-strings';
import {
  encoding,
} from '@wormhole-foundation/sdk';
import { searcherClient } from '@jito/jito-ts/dist/sdk/block-engine/searcher.js';
import { JitoRpcConnection } from '@jito/jito-ts/dist/sdk/rpc/connection.js';
import { Bundle } from '@jito/jito-ts/dist/sdk/block-engine/types.js';
import solanaSDK from '@wormhole-foundation/sdk/solana';
const solSDK = await solanaSDK();
const SolanaPlatform = solSDK.Platform;


// Add priority fee according to 90th percentile of recent fees paid
const DEFAULT_PRIORITY_FEE_PERCENTILE = 0.9;

// initialize the Jito client
const jitoClient = searcherClient(
    process.env.JITO_BLOCK_ENGINE_URL || "amsterdam.mainnet.block-engine.jito.wtf",
    undefined
);

// returns a SignOnlySigner for the Solana platform
async function getSolanaSigner(rpc, privateKey) {
  const [_, chain] = await SolanaPlatform.chainFromRpc(rpc);
  return new SolanaSigner(
    chain,
    Keypair.fromSecretKey(encoding.b58.decode(privateKey)),
    rpc,
  );
}

// returns a SignAndSendSigner for the Solana platform
async function getSolanaSignAndSendSigner(rpc, privateKey, opts) {
  const [_, chain] = await SolanaPlatform.chainFromRpc(rpc);

  const kp = typeof privateKey === 'string'
    ? Keypair.fromSecretKey(encoding.b58.decode(privateKey))
    : privateKey;

  if (opts?.priorityFeePercentile && opts?.priorityFeePercentile > 1.0)
    throw new Error('priorityFeePercentile must be a number between 0 and 1');

  return new SolanaSendSigner(
    rpc,
    chain,
    kp,
    opts?.debug ?? false,
    opts?.priorityFeePercentile ?? 0,
    opts?.sendOpts,
  );
}

class SolanaSigner {
  constructor(chain, keypair, rpc, debug = false) {
    this._chain = chain;
    this._keypair = keypair;
    this._rpc = rpc;
    this._debug = debug;
  }

  chain() {
    return this._chain;
  }

  address() {
    return this._keypair.publicKey.toBase58();
  }

  async sign(txs) {
    const { blockhash } = await SolanaPlatform.latestBlock(this._rpc);

    const signed = [];
    for (const txn of txs) {
      const { description, transaction: { transaction, signers: extraSigners } } = txn;

      console.log(`Signing: ${description} for ${this.address()}`);

      if (this._debug) logTxDetails(transaction);

      transaction.recentBlockhash = blockhash;
      transaction.partialSign(this._keypair, ...(extraSigners ?? []));
      signed.push(transaction.serialize());
    }
    return signed;
  }
}

class SolanaSendSigner {
  constructor(rpc, chain, keypair, debug = false, priorityFeePercentile = 0.0, sendOpts) {
    this._rpc = new JitoRpcConnection(
        process.env.SOL_RPC_HTTPS_URL || rpc._rpcEndpoint,
        rpc._commitment,
    );
    this._chain = chain;
    this._keypair = keypair;
    this._debug = debug;
    this._priorityFeePercentile = priorityFeePercentile;
    this._sendOpts = sendOpts ?? { preflightCommitment: this._rpc.commitment };
  }

  chain() {
    return this._chain;
  }

  address() {
    return this._keypair.publicKey.toBase58();
  }

  retryable(e) {
    if (e instanceof TransactionExpiredBlockheightExceededError) return true;
    if (!(e instanceof SendTransactionError)) return false;
    if (!e.message.includes('Transaction simulation failed')) return false;
    if (e.message.includes('Blockhash not found')) return true;

    const loggedErr = e.logs?.find((log) => log.startsWith('Program log: Error: '));
    if (!loggedErr) return false;
    if (loggedErr.includes('Not enough bytes')) return true;
    if (loggedErr.includes('Unexpected length of input')) return true;

    return false;
  }

  async signAndSendJitoBundle(txs) {
    // get tip account
    const tipAccount = new PublicKey(
        (await jitoClient.getTipAccounts())[0]
    );

    // get latest block
    let { blockhash, lastValidBlockHeight } = await SolanaPlatform.latestBlock(this._rpc);

    // TODO split txs array into multiple bundles if it exceeds 4 txs (tip tx is #5)
    const txids = [];
    const bundle = new Bundle([], 5);

    for await (const txn of txs) {
      const { description, transaction: { transaction, signers: extraSigners } } = txn;

      if (this._debug) logTxDetails(transaction);

      // already a versioned tx, add it to jito bundle
      if (isVersionedTransaction(transaction)) {
        transaction.recentBlockhash = blockhash;

        // throw if tx simulation fails
        const sim = await this._rpc.simulateTransaction(transaction);
        if (sim.value.err) {
          throw new Error(`Error simulating transaction: ${sim.value.err}`);
        }

        // add tx to jito bundle
        bundle.addTransactions(transaction);
        const txid = getSignatureFromTransaction(transaction)[0];
        txids.push(txid);
      }

      // not a versioned tx: create a versioned tx and bundle it
      else {
        // create a versioned tx
        const messageV0 = new TransactionMessage({
          payerKey: this._keypair.publicKey,
          recentBlockhash: blockhash,
          instructions: transaction.instructions,
        }).compileToV0Message();

          // sign the tx
        const versionedTransaction = new VersionedTransaction(messageV0);
        if (extraSigners) {
            versionedTransaction.sign([this._keypair, ...extraSigners]);
        } else {
            versionedTransaction.sign([this._keypair]);
        }

        // throw if tx simulation fails
        const sim = await this._rpc.simulateTransaction(versionedTransaction);
        if (sim.value.err) {
          throw new Error(`Error simulating transaction: ${sim.value.err}`);
        }

        // add tx to jito bundle
        bundle.addTransactions(versionedTransaction);
        const txid = getSignatureFromTransaction(versionedTransaction)[0];
        txids.push(txid);
      }
    }

    // add tip tx to bundle
    const maybeBundle = bundle.addTipTx(
      this._keypair,
      50_000,
      tipAccount,
      blockhash
    );

    // send bundle
    console.log("sending bundle");
    const bundleResp = await jitoClient.sendBundle(maybeBundle);
    console.log('bundleResp:', bundleResp);
    console.log('txids:', txids);

    const results = await Promise.all(
      txids.map((signature) =>
        this._rpc.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          this._rpc.commitment,
        ),
      ),
    );

    const erroredTxs = results
      .filter((result) => result.value.err)
      .map((result) => result.value.err);

    if (erroredTxs.length > 0)
      throw new Error(`Failed to confirm transaction: ${erroredTxs}`);

    return txids;
  }

  /* Send to Jito if the next leader is within 50 slots.
   * Send with priority fee if the next leader is not within 50 slots.
   * Returns an array of txids.
   */
  async signAndSend(txs) {
    const {
        currentSlot,
        nextLeaderSlot,
        nextLeaderIdentity
      } = await jitoClient.getNextScheduledLeader();

      // send to Jito if the next leader is within 50 slots
      let txids = [];
      if (nextLeaderSlot <= currentSlot + 50) {
          txids = await this.signAndSendJitoBundle(txs);
      }
      // send with priority fee otherwise
      else {
          txids = await this.signAndSendPriorityFee(txs);
      }

      return txids;
  }

  async signAndSendPriorityFee(txs) {
    let { blockhash, lastValidBlockHeight } = await SolanaPlatform.latestBlock(this._rpc);

    const txids = [];
    for (const txn of txs) {
      const { description, transaction: { transaction, signers: extraSigners } } = txn;

      console.log(`Signing: ${description} for ${this.address()}`);

      if (this._priorityFeePercentile && this._priorityFeePercentile > 0)
        transaction.add(
          ...(await createPriorityFeeInstructions(
            this._rpc,
            transaction,
            [],
            this._priorityFeePercentile,
          )),
        );

      if (this._debug) logTxDetails(transaction);

      const maxRetries = 5;
      for (let i = 0; i < maxRetries; i++) {
        try {
          transaction.recentBlockhash = blockhash;
          transaction.partialSign(this._keypair, ...(extraSigners ?? []));

          const txid = await this._rpc.sendRawTransaction(
            transaction.serialize(),
            this._sendOpts,
          );
          txids.push(txid);
          break;
        } catch (e) {
          if (i === maxRetries - 1) throw e;
          if (!this.retryable(e)) throw e;

          const { blockhash: newBlockhash, lastValidBlockHeight: newBlockHeight } = await SolanaPlatform.latestBlock(this._rpc);

          lastValidBlockHeight = newBlockHeight;
          blockhash = newBlockhash;
        }
      }
    }

    const results = await Promise.all(
      txids.map((signature) =>
        this._rpc.confirmTransaction(
          { signature, blockhash, lastValidBlockHeight },
          this._rpc.commitment,
        ),
      ),
    );

    const erroredTxs = results
      .filter((result) => result.value.err)
      .map((result) => result.value.err);

    if (erroredTxs.length > 0)
      throw new Error(`Failed to confirm transaction: ${erroredTxs}`);

    return txids;
  }
}

function logTxDetails(transaction) {
  console.log(transaction.signatures);
  console.log(transaction.feePayer);
  transaction.instructions.forEach((ix) => {
    console.log('Program', ix.programId.toBase58());
    console.log('Data: ', ix.data.toString('hex'));
    console.log(
      'Keys: ',
      ix.keys.map((k) => [k, k.pubkey.toBase58()]),
    );
  });
}

async function createPriorityFeeInstructions(connection, transaction, lockedWritableAccounts = [], feePercentile = DEFAULT_PRIORITY_FEE_PERCENTILE, minPriorityFee = 0) {
  if (lockedWritableAccounts.length === 0) {
    lockedWritableAccounts = transaction.instructions
      .flatMap((ix) => ix.keys)
      .map((k) => (k.isWritable ? k.pubkey : null))
      .filter((k) => k !== null);
  }
  return await determineComputeBudget(
    connection,
    transaction,
    lockedWritableAccounts,
    feePercentile,
    minPriorityFee,
  );
}

async function determineComputeBudget(connection, transaction, lockedWritableAccounts = [], feePercentile = DEFAULT_PRIORITY_FEE_PERCENTILE, minPriorityFee = 0) {
  let computeBudget = 250000;
  let priorityFee = 1;

  try {
    const simulateResponse = await connection.simulateTransaction(transaction);

    if (simulateResponse.value.err) {
      console.error(`Error simulating Solana transaction: ${simulateResponse.value.err}`);
    }

    if (simulateResponse?.value?.unitsConsumed) {
      computeBudget = Math.round(simulateResponse.value.unitsConsumed * 1.2);
    }
  } catch (e) {
    console.error(`Failed to calculate compute unit limit for Solana transaction: ${e}`);
  }

  try {
    priorityFee = await determinePriorityFee(
      connection,
      lockedWritableAccounts,
      feePercentile,
    );
  } catch (e) {
    console.error(`Failed to calculate compute unit price for Solana transaction: ${e}`);
    return [];
  }
  priorityFee = Math.max(priorityFee, minPriorityFee);

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeBudget }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
  ];
}

async function determinePriorityFee(connection, lockedWritableAccounts = [], percentile) {
  let fee = 1;

  try {
    const recentFeesResponse = await connection.getRecentPrioritizationFees({ lockedWritableAccounts });

    if (recentFeesResponse) {
      const recentFees = recentFeesResponse
        .map((dp) => dp.prioritizationFee)
        .filter((dp) => dp > 0)
        .sort((a, b) => a - b);

      if (recentFees.length > 0) {
        const medianFee = recentFees[Math.floor(recentFees.length * percentile)];
        fee = Math.max(fee, medianFee);
      }
    }
  } catch (e) {
    console.error('Error fetching Solana recent fees', e);
  }

  return fee;
}

function isVersionedTransaction(tx) {
  return (
    tx.signatures !== undefined &&
    tx.message !== undefined
  );
}

function getSignatureFromTransaction(transaction) {
    let base58Decoder = getBase58Decoder();

    // We have ordered signatures from the compiled message accounts
    // first signature is the fee payer
    const signatureBytes = Object.values(transaction.signatures)[0];
    const transactionSignature = base58Decoder.decode(signatureBytes);
    return transactionSignature;
}

export {
  getSolanaSigner,
  getSolanaSignAndSendSigner,
  SolanaSigner,
  SolanaSendSigner,
  logTxDetails,
  createPriorityFeeInstructions,
};
