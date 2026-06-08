import "./ws-polyfill.js";
import { Buffer } from "node:buffer";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import {
  WalletFacade,
  WalletEntrySchema,
  type DefaultConfiguration,
  type CombinedTokenTransfer,
  type UtxoWithMeta,
} from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  UnshieldedWallet,
  createKeystore,
  PublicKey,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { InMemoryTransactionHistoryStorage } from "@midnight-ntwrk/wallet-sdk-abstractions";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import {
  MidnightBech32m,
  UnshieldedAddress,
} from "@midnight-ntwrk/wallet-sdk-address-format";
import { firstValueFrom } from "rxjs";
import { filter, timeout } from "rxjs/operators";

// ─── Local devnet endpoints ──────────────────────────────────────────────────
export const NETWORK_ID = "undeployed" as const;
export const INDEXER_HTTP = "http://127.0.0.1:8088/api/v3/graphql";
export const INDEXER_WS = "ws://127.0.0.1:8088/api/v3/graphql/ws";
export const NODE_URL = "ws://127.0.0.1:9944";
export const PROOF_SERVER = "http://127.0.0.1:6300";

// The dev preset's chain spec pre-mints NIGHT to the wallet derived from this seed.
const GENESIS_SEED_HEX =
  "0000000000000000000000000000000000000000000000000000000000000001";

// 10,000 NIGHT. Funding below ~10k triggers DUST-registration error 138
// (BalanceCheckOverspend) — established empirically on this devnet.
const DEFAULT_FUND_AMOUNT = 10_000_000_000n;
const BALANCE_WAIT_MS = 90_000;

export type DerivedKeys = ReturnType<typeof deriveKeys>;

export function deriveKeys(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, "hex"));
  if (hd.type !== "seedOk") throw new Error(`HDWallet.fromSeed failed: ${hd.type}`);
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust] as const)
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived")
    throw new Error(`deriveKeysAt failed: ${derived.type}`);
  hd.hdWallet.clear();
  const keys = derived.keys as Record<number, Uint8Array>;
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], NETWORK_ID);
  return { shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
}

function buildConfiguration(): DefaultConfiguration {
  return {
    networkId: NETWORK_ID,
    // additionalFeeOverhead is REQUIRED on local devnet: fee prices are ~0, so a
    // proven contract callTx computes a 0-SPECK fee, which makes balancing emit
    // empty DustActions and the node rejects the tx with error 117 (NotNormalized).
    // Forcing a non-zero fee overhead makes balancing produce real dust spends.
    // (Deploy happens to work without it because ContractDeploy has a min cost.)
    costParameters: {
      feeBlocksMargin: 5,
      additionalFeeOverhead: 300_000_000_000_000n,
    },
    relayURL: new URL(NODE_URL),
    provingServerUrl: new URL(PROOF_SERVER),
    indexerClientConnection: {
      indexerHttpUrl: INDEXER_HTTP,
      indexerWsUrl: INDEXER_WS,
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema),
  };
}

export async function initWallet(keys: DerivedKeys): Promise<WalletFacade> {
  const wallet = await WalletFacade.init({
    configuration: buildConfiguration(),
    shielded: (cfg) =>
      ShieldedWallet(cfg).startWithSecretKeys(keys.shieldedSecretKeys),
    unshielded: (cfg) =>
      UnshieldedWallet(cfg).startWithPublicKey(
        PublicKey.fromKeyStore(keys.unshieldedKeystore),
      ),
    dust: (cfg) =>
      DustWallet(cfg).startWithSecretKey(
        keys.dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });
  await wallet.start(keys.shieldedSecretKeys, keys.dustSecretKey);
  return wallet;
}

export const NIGHT_TOKEN_TYPE = ledger.nativeToken().raw;

/** Transfer NIGHT from the genesis wallet to `recipientUnshieldedAddr`. */
export async function fundFromGenesis(
  recipientUnshieldedAddr: string,
  amount: bigint = DEFAULT_FUND_AMOUNT,
): Promise<string> {
  const genKeys = deriveKeys(GENESIS_SEED_HEX);
  const sender = await initWallet(genKeys);
  try {
    await sender.waitForSyncedState();
    const recipient: UnshieldedAddress = MidnightBech32m.parse(
      recipientUnshieldedAddr,
    ).decode(UnshieldedAddress, NETWORK_ID);

    const outputs: CombinedTokenTransfer[] = [
      {
        type: "unshielded",
        outputs: [
          { type: NIGHT_TOKEN_TYPE, receiverAddress: recipient, amount },
        ],
      },
    ];
    const ttl = new Date(Date.now() + 60 * 60 * 1000);
    const recipe = await sender.transferTransaction(
      outputs,
      { shieldedSecretKeys: genKeys.shieldedSecretKeys, dustSecretKey: genKeys.dustSecretKey },
      { ttl },
    );
    const signed = await sender.signRecipe(recipe, (p) =>
      genKeys.unshieldedKeystore.signData(p),
    );
    const finalized = await sender.finalizeRecipe(signed);
    return await sender.submitTransaction(finalized);
  } finally {
    await sender.stop();
  }
}

/** Register the wallet's NIGHT UTXOs so they generate DUST (needed to pay fees). */
export async function registerDust(
  wallet: WalletFacade,
  keystore: DerivedKeys["unshieldedKeystore"],
): Promise<string> {
  const state = await wallet.waitForSyncedState();
  const nightUtxos: readonly UtxoWithMeta[] =
    state.unshielded.availableCoins.filter(
      (c) =>
        c.utxo.type === NIGHT_TOKEN_TYPE &&
        c.meta.registeredForDustGeneration === false,
    );
  if (nightUtxos.length === 0)
    throw new Error("No NIGHT UTXOs to register — fund the wallet first.");
  const recipe = await wallet.registerNightUtxosForDustGeneration(
    nightUtxos,
    keystore.getPublicKey(),
    (p) => keystore.signData(p),
  );
  const finalized = await wallet.finalizeRecipe(recipe);
  return await wallet.submitTransaction(finalized);
}

/** Wait until the wallet's NIGHT balance reaches `min`. */
export async function waitForNight(
  wallet: WalletFacade,
  min: bigint,
): Promise<bigint> {
  try {
    const s = await firstValueFrom(
      wallet.state().pipe(
        filter((s) => (s.unshielded.balances[NIGHT_TOKEN_TYPE] ?? 0n) >= min),
        timeout(BALANCE_WAIT_MS),
      ),
    );
    return s.unshielded.balances[NIGHT_TOKEN_TYPE] ?? 0n;
  } catch {
    const s = await wallet.waitForSyncedState();
    return s.unshielded.balances[NIGHT_TOKEN_TYPE] ?? 0n;
  }
}

/** Wait until DUST balance is positive (fees are payable). */
export async function waitForDust(wallet: WalletFacade): Promise<bigint> {
  try {
    const s = await firstValueFrom(
      wallet.state().pipe(
        filter((s) => s.dust.balance(new Date()) > 0n),
        timeout(BALANCE_WAIT_MS),
      ),
    );
    return s.dust.balance(new Date());
  } catch {
    return 0n;
  }
}
