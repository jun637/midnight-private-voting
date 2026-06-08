/**
 * E2E test: diagnose NotNormalized (error 117) on callTx
 *
 * Phase 1 - BUGGY walletProvider (no signTransactionIntents):
 *   deploy -> callTx -> expect NotNormalized / RpcError 1010
 *
 * Phase 2 - FIXED walletProvider (with signTransactionIntents on baseTransaction):
 *   deploy -> callTx -> expect success
 *
 * Run via: node --import tsx <path>
 * from /mnt/d/Jun/midnight-private-voting
 */

// WebSocket polyfill - must be first
import WebSocket from 'ws';
(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { firstValueFrom, filter as rxFilter } from 'rxjs';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { WalletFacade, WalletEntrySchema } from '@midnight-ntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnight-ntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnight-ntwrk/wallet-sdk-dust-wallet';
import { InMemoryTransactionHistoryStorage } from '@midnight-ntwrk/wallet-sdk-abstractions';
import { HDWallet, Roles } from '@midnight-ntwrk/wallet-sdk-hd';
import { MidnightBech32m, UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

// ─── Contract types ───────────────────────────────────────────────────────────
// Absolute path to the compiled counter contract artifacts
const ZK_CONFIG_PATH = '/mnt/d/Jun/midnight-private-voting/.midnight-expert/verify/sdk-workspace/jobs/bc9164e6-cee3-49da-aa95-b572e5a586d0/counter-contract/managed';

// ─── Constants ────────────────────────────────────────────────────────────────
const NETWORK_ID       = 'undeployed' as const;
const INDEXER_HTTP     = 'http://127.0.0.1:8088/api/v3/graphql';
const INDEXER_WS       = 'ws://127.0.0.1:8088/api/v3/graphql/ws';
const NODE_URL         = 'ws://127.0.0.1:9944';
const PROOF_SERVER     = 'http://127.0.0.1:6300';
const GENESIS_SEED_HEX = '0000000000000000000000000000000000000000000000000000000000000001';
const NIGHT_TOKEN_TYPE = ledger.nativeToken().raw;

// ─── HD key derivation ────────────────────────────────────────────────────────
function deriveKeys(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  if (hd.type !== 'seedOk') throw new Error(`HDWallet.fromSeed failed: ${hd.type}`);
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
    .deriveKeysAt(0);
  if (derived.type !== 'keysDerived') throw new Error(`deriveKeysAt failed: ${derived.type}`);
  hd.hdWallet.clear();
  const keys = derived.keys as Record<number, Uint8Array>;
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], NETWORK_ID);
  return { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

type DerivedKeys = ReturnType<typeof deriveKeys>;

// ─── Wallet init ──────────────────────────────────────────────────────────────
async function initWallet(keys: DerivedKeys, additionalFeeOverhead?: bigint): Promise<WalletFacade> {
  const config = {
    networkId: NETWORK_ID,
    costParameters: { feeBlocksMargin: 5, ...(additionalFeeOverhead !== undefined ? { additionalFeeOverhead } : {}) },
    relayURL: new URL(NODE_URL),
    provingServerUrl: new URL(PROOF_SERVER),
    indexerClientConnection: { indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };
  const wallet = await WalletFacade.init({
    configuration: config,
    shielded: (cfg: any) => ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg: any) => UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(keys.unshieldedKeystore)),
    dust: (cfg: any) => DustWallet(cfg).startWithSecretKey(keys.dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(keys.shieldedSecretKeys, keys.dustSecretKey);
  return wallet;
}

// ─── Build providers ──────────────────────────────────────────────────────────
// Phase 1: BUGGY — current voting-service.ts: balanceUnbound + finalizeRecipe only
// Phase 2: FIXED via wallet.signRecipe() — the testkit/bboard canonical pattern
//           (works because wallet-sdk-unshielded-wallet 3.1.0 fixed the pre-proof bug)

function inspectTx(label: string, tx: any) {
  try {
    const intents = tx.intents;
    const segmentIds = intents ? Array.from(intents.keys()) : [];
    const isSorted = segmentIds.every((v: number, i: number) => i === 0 || segmentIds[i-1] <= v);
    const guaranteed = tx.guaranteed_coins;
    const fallible = tx.fallible_coins;
    const fallibleKeys = fallible ? Array.from(fallible.keys ? fallible.keys() : []) : [];
    console.log(`  [INSPECT ${label}] intents segments: [${segmentIds}] sorted=${isSorted}`);
    console.log(`  [INSPECT ${label}] guaranteed_coins: ${guaranteed ? 'present' : 'null'}`);
    console.log(`  [INSPECT ${label}] fallible_coins keys: [${fallibleKeys}]`);
    // Try to check each intent for dust actions
    if (intents) {
      for (const [seg, intent] of intents.entries()) {
        const da = (intent as any).dustActions;
        if (da) {
          console.log(`  [INSPECT ${label}] seg ${seg} DustActions: spends=${da.spends?.length ?? 0}, regs=${da.registrations?.length ?? 0}`);
        }
      }
    }
  } catch (e: any) {
    console.log(`  [INSPECT ${label}] error: ${e.message}`);
  }
}

function makeWalletProvider(
  wallet: WalletFacade,
  keys: DerivedKeys,
  variant: 'buggy' | 'signRecipe',
) {
  return {
    getCoinPublicKey: () => keys.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => keys.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date): Promise<ledger.FinalizedTransaction> {
      inspectTx(`${variant}:provenTx`, tx);

      // Deep-dive fee diagnostics on the proven tx
      try {
        const ledgerParams = ledger.LedgerParameters.initialParameters();
        const fee5 = tx.feesWithMargin(ledgerParams, 5);
        const fee0 = tx.feesWithMargin(ledgerParams, 0);
        console.log(`  [FEE-DIAG ${variant}] feesWithMargin(5)=${fee5}, feesWithMargin(0)=${fee0}`);
        const imb = tx.imbalances(0, fee5);
        for (const [tt, v] of imb.entries()) {
          console.log(`  [FEE-DIAG ${variant}] imbalances(0, fee5)[${tt.tag ?? JSON.stringify(tt)}] = ${v}`);
        }
        if (imb.size === 0) {
          console.log(`  [FEE-DIAG ${variant}] imbalances map is EMPTY`);
        }
        // Also check imbalances with fee=0 to see base balance
        const imb0 = tx.imbalances(0, 0n);
        for (const [tt, v] of imb0.entries()) {
          console.log(`  [FEE-DIAG ${variant}] imbalances(0, 0)[${tt.tag ?? JSON.stringify(tt)}] = ${v}`);
        }
        if (imb0.size === 0) {
          console.log(`  [FEE-DIAG ${variant}] imbalances(0, 0) map is EMPTY`);
        }
      } catch (e: any) {
        console.log(`  [FEE-DIAG ${variant}] error: ${e.message}`);
      }

      const recipe = await (wallet as any).balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: keys.shieldedSecretKeys, dustSecretKey: keys.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      inspectTx(`${variant}:baseTransaction`, recipe.baseTransaction);
      if (recipe.balancingTransaction) {
        inspectTx(`${variant}:balancingTransaction`, recipe.balancingTransaction);
      }
      let result: ledger.FinalizedTransaction;
      if (variant === 'signRecipe') {
        const signed = await wallet.signRecipe(recipe, (p: Uint8Array) => keys.unshieldedKeystore.signData(p));
        result = await wallet.finalizeRecipe(signed);
      } else {
        result = await wallet.finalizeRecipe(recipe);
      }
      inspectTx(`${variant}:finalizedTx`, result);
      return result;
    },
    submitTx: (tx: any) => wallet.submitTransaction(tx as never),
  };
}

function buildProvider(wallet: WalletFacade, keys: DerivedKeys, storeId: string, variant: 'buggy' | 'signRecipe') {
  const zkConfigProvider = new NodeZkConfigProvider(ZK_CONFIG_PATH);
  const walletProvider = makeWalletProvider(wallet, keys, variant);
  return {
    walletProvider,
    midnightProvider: walletProvider,
    publicDataProvider: indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS),
    privateStateProvider: levelPrivateStateProvider<string, {}>({
      privateStateStoreName: `counter-${storeId}-${variant}`,
      privateStoragePasswordProvider: () => 'Voting-Dev-Pa55word!',
      accountId: storeId,
    }),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
  };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== NotNormalized E2E Diagnostic Test ===');
  console.log('Versions: midnight-js-contracts@4.1.1 / wallet-sdk-facade@4.0.1 / ledger-v8@8.1.0\n');

  setNetworkId(NETWORK_ID);

  const keys = deriveKeys(GENESIS_SEED_HEX);
  console.log('Initializing genesis wallet (connecting to devnet)...');
  const wallet = await initWallet(keys);
  console.log('Wallet initialized.');

  try {
    console.log('Waiting for sync...');
    const state = await wallet.waitForSyncedState();
    console.log('Synced.');
    const night = (state as any).unshielded?.balances?.[NIGHT_TOKEN_TYPE] ?? 0n;
    const dust = (state as any).dust?.balance(new Date()) ?? 0n;
    console.log(`Genesis wallet: NIGHT=${night}, DUST=${dust}`);

    if (night === 0n) throw new Error('Genesis wallet has no NIGHT');

    const { Contract } = await import(path.resolve(ZK_CONFIG_PATH, 'contract/index.js') as any);
    // Counter has no witnesses - pass empty object {}
    // Must also pipe withWitnesses({}) and withCompiledFileAssets to wire up ZK key paths
    const compiledContract = CompiledContract.make('counter', Contract).pipe(
      CompiledContract.withWitnesses({}),
      CompiledContract.withCompiledFileAssets(ZK_CONFIG_PATH),
    );
    console.log('Counter contract loaded.\n');

    // Helper: deploy + callTx for a given provider variant
    async function runPhase(label: string, variant: 'buggy' | 'signRecipe', storeId: string, additionalFeeOverhead?: bigint) {
      console.log(`\n--- ${label} ---`);
      // For phases with additionalFeeOverhead, create a separate wallet with that config
      let phaseWallet = wallet;
      if (additionalFeeOverhead !== undefined) {
        console.log(`  Creating wallet with additionalFeeOverhead=${additionalFeeOverhead}`);
        phaseWallet = await initWallet(keys, additionalFeeOverhead);
        await phaseWallet.waitForSyncedState();
        console.log(`  Phase wallet synced.`);
      }
      const p = buildProvider(phaseWallet, keys, storeId, variant);
      let deploy: string | null = null, deployErr: string | null = null;
      let callOk = false, callErr: string | null = null, callTxId: string | null = null;

      try {
        console.log('  Deploying...');
        const d = await deployContract(p as any, {
          compiledContract: compiledContract as any,
          privateStateId: storeId,
          initialPrivateState: {},
          args: [],
        } as any);
        deploy = (d as any).deployTxData.public.contractAddress;
        console.log(`  Deploy OK: ${deploy}`);
      } catch (e: any) {
        deployErr = String(e.message ?? e).slice(0, 200);
        console.log(`  Deploy FAILED: ${deployErr}`);
      }

      if (deploy) {
        try {
          console.log('  Calling increment()...');
          const found = await findDeployedContract(p as any, {
            contractAddress: deploy,
            compiledContract: compiledContract as any,
            privateStateId: storeId,
            initialPrivateState: {},
          } as any);
          const result = await (found as any).callTx.increment();
          callTxId = result?.public?.txId ?? result?.txId ?? JSON.stringify(result).slice(0, 80);
          callOk = true;
          console.log(`  callTx OK: txId=${callTxId}, blockHeight=${result?.public?.blockHeight ?? '?'}`);
        } catch (e: any) {
          callErr = String(e.message ?? e).slice(0, 300);
          console.log(`  callTx FAILED: ${callErr}`);
        }
      }
      const result = { variant, deployOk: !!deploy, deployError: deployErr, callOk, callError: callErr, callTxId, contractAddress: deploy };
      if (additionalFeeOverhead !== undefined) {
        await phaseWallet.stop().catch(() => {});
      }
      return result;
    }

    const r1 = await runPhase('PHASE 1: BUGGY (balanceUnbound + finalizeRecipe only)', 'buggy', 'p1');
    const r2 = await runPhase('PHASE 2: FIXED (balanceUnbound + signRecipe + finalizeRecipe)', 'signRecipe', 'p2');
    // ── Results ───────────────────────────────────────────────────────────────
    const bugReproduced = r1.deployOk && !r1.callOk;
    const fixConfirmed  = r3.deployOk && r3.callOk;

    console.log('\n=== RESULTS ===');
    console.log(JSON.stringify({
      versions: { 'midnight-js-contracts': '4.1.1', 'wallet-sdk-facade': '4.0.1', 'ledger-v8': '8.1.0', 'wallet-sdk-unshielded-wallet': '3.1.0' },
      phase1_buggy: r1,
      phase2_signRecipe: r2,
      phase3_additionalFee: r3,
      bugReproduced,
      fixConfirmed,
    }, null, 2));

  } finally {
    await wallet.stop();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
