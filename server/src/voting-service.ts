import "./ws-polyfill.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { filter, firstValueFrom, map } from "rxjs";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  deployContract,
  findDeployedContract,
} from "@midnight-ntwrk/midnight-js-contracts";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { CompiledContract } from "@midnight-ntwrk/compact-js";
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import * as ledgerSdk from "@midnight-ntwrk/ledger-v8";

import { Contract, ledger as votingLedger } from "@private-voting/contract";
import {
  votingWitnesses,
  createVoterState,
  type VoterPrivateState,
} from "./witnesses.js";
import { computeCommitment, computeNullifier, toHex } from "./crypto.js";
import {
  INDEXER_HTTP,
  INDEXER_WS,
  PROOF_SERVER,
  NETWORK_ID,
  type DerivedKeys,
} from "./wallet.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZK_CONFIG_PATH = path.resolve(
  __dirname,
  "../../contract/src/managed/voting",
);

export interface ResultsState {
  choiceCount: number;
  ratingMax: number;
  totalSubmissions: number;
  ratingDistribution: number[]; // index 0 => rating 1, etc.
  ratingAverage: number;
  choiceTallies: number[];
  feedbacks: string[];
}

/** Public on-chain artifacts, for the privacy visualization. */
export interface ChainState {
  contractAddress: string;
  merkleRoot: string; // hex
  treeSize: number; // number of registered commitments
  nullifiers: string[]; // hex — public set, unlinkable to commitments
  submissionCount: number;
}

/** What a voter privately holds + the values they put on-chain (computed). */
export interface VoterView {
  commitment: string; // hex — went into the Merkle tree at register
  nullifier: string; // hex — published at submit, unlinkable to commitment
}

/**
 * Sign all unshielded offers in a transaction's intents, using the correct
 * proof marker. Works around a wallet-SDK bug where `signRecipe` hardcodes the
 * 'pre-proof' marker — which fails for proven (UnboundTransaction) intents that
 * carry 'proof' data, leaving the transaction unsigned and the node rejecting it
 * with error 117 (NotNormalized). Mirrors the canonical midnightntwrk/example-counter.
 */
function signTransactionIntents(
  tx: { intents?: Map<number, any> },
  signFn: (payload: Uint8Array) => any,
  proofMarker: "proof" | "pre-proof",
): void {
  if (!tx.intents || tx.intents.size === 0) return;
  for (const segment of tx.intents.keys()) {
    const intent = tx.intents.get(segment);
    if (!intent) continue;
    const cloned = (ledgerSdk as any).Intent.deserialize(
      "signature",
      proofMarker,
      "pre-binding",
      intent.serialize(),
    );
    const signature = signFn(cloned.signatureData(segment));
    if (cloned.fallibleUnshieldedOffer) {
      const sigs = cloned.fallibleUnshieldedOffer.inputs.map(
        (_: any, i: number) =>
          cloned.fallibleUnshieldedOffer.signatures.at(i) ?? signature,
      );
      cloned.fallibleUnshieldedOffer =
        cloned.fallibleUnshieldedOffer.addSignatures(sigs);
    }
    if (cloned.guaranteedUnshieldedOffer) {
      const sigs = cloned.guaranteedUnshieldedOffer.inputs.map(
        (_: any, i: number) =>
          cloned.guaranteedUnshieldedOffer.signatures.at(i) ?? signature,
      );
      cloned.guaranteedUnshieldedOffer =
        cloned.guaranteedUnshieldedOffer.addSignatures(sigs);
    }
    tx.intents.set(segment, cloned);
  }
}

/**
 * Holds a funded devnet wallet and a deployed Private Voting contract.
 * Acts as a proving service: it stores each voter's secret material and, for
 * every operation, reconnects to the contract with that voter's private state
 * so the witnesses produce the correct commitment / nullifier inside the ZK proof.
 */
export class VotingService {
  private contractAddress: string | null = null;
  private readonly voters = new Map<string, VoterPrivateState>();
  private readonly walletProvider;
  private readonly basePassword = "Voting-Dev-Pa55word!";

  private constructor(
    private readonly facade: WalletFacade,
    walletProvider: WalletProvider,
  ) {
    this.walletProvider = walletProvider;
  }

  static async create(
    facade: WalletFacade,
    keys: DerivedKeys,
  ): Promise<VotingService> {
    setNetworkId(NETWORK_ID);
    const synced = await firstValueFrom(
      facade.state().pipe(filter((s) => s.isSynced)),
    );
    const walletProvider: WalletProvider = {
      getCoinPublicKey: () => synced.shielded.coinPublicKey.toHexString(),
      getEncryptionPublicKey: () =>
        synced.shielded.encryptionPublicKey.toHexString(),
      balanceTx: async (tx: unknown, ttl?: Date) => {
        const recipe = await (facade as any).balanceUnboundTransaction(
          tx,
          {
            shieldedSecretKeys: keys.shieldedSecretKeys,
            dustSecretKey: keys.dustSecretKey,
          },
          { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
        );
        // Sign the contract-call intents with the correct proof markers so the
        // transaction normalizes (else the node rejects calls with error 117).
        // baseTransaction is proven ('proof'); the balancing tx is 'pre-proof'.
        const signFn = (p: Uint8Array) => keys.unshieldedKeystore.signData(p);
        signTransactionIntents((recipe as any).baseTransaction, signFn, "proof");
        if ((recipe as any).balancingTransaction) {
          signTransactionIntents(
            (recipe as any).balancingTransaction,
            signFn,
            "pre-proof",
          );
        }
        return await facade.finalizeRecipe(recipe);
      },
      submitTx: (tx: unknown) => facade.submitTransaction(tx as never),
    };
    return new VotingService(facade, walletProvider);
  }

  private buildProviders(privateStateId: string) {
    const zkConfigProvider = new NodeZkConfigProvider(ZK_CONFIG_PATH);
    return {
      walletProvider: this.walletProvider,
      midnightProvider: this.walletProvider,
      publicDataProvider: indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS),
      privateStateProvider: levelPrivateStateProvider<string, VoterPrivateState>(
        {
          privateStateStoreName: `voting-${privateStateId}`,
          privateStoragePasswordProvider: () => this.basePassword,
          accountId: privateStateId,
        },
      ),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(PROOF_SERVER, zkConfigProvider),
    };
  }

  private compiled(witnesses = votingWitnesses) {
    return CompiledContract.make("voting", Contract).pipe(
      CompiledContract.withWitnesses(witnesses),
      CompiledContract.withCompiledFileAssets(ZK_CONFIG_PATH),
    );
  }

  /** Deploy a fresh feedback poll. */
  async deploy(numChoices: number, ratingMax: number): Promise<string> {
    const providers = this.buildProviders("admin");
    const deployerState = createVoterState();
    const deployed = await deployContract(providers as never, {
      compiledContract: this.compiled() as never,
      privateStateId: "admin",
      initialPrivateState: deployerState,
      args: [BigInt(numChoices), BigInt(ratingMax)],
    } as never);
    this.contractAddress = (deployed as any).deployTxData.public.contractAddress;
    return this.contractAddress!;
  }

  /** Connect to the existing contract under a specific voter's private state. */
  private async connectAs(privateStateId: string, state: VoterPrivateState) {
    if (!this.contractAddress) throw new Error("Contract not deployed yet");
    const providers = this.buildProviders(privateStateId);
    return await findDeployedContract(providers as never, {
      contractAddress: this.contractAddress,
      compiledContract: this.compiled() as never,
      privateStateId,
      initialPrivateState: state,
    } as never);
  }

  /** Register a new attendee; returns their commitment (the value put in the tree). */
  async registerVoter(voterId: string): Promise<VoterView> {
    if (this.voters.has(voterId))
      throw new Error(`Voter ${voterId} already registered`);
    const state = createVoterState();
    const deployed = await this.connectAs(voterId, state);
    await (deployed as any).callTx.register();
    this.voters.set(voterId, state);
    return {
      commitment: toHex(computeCommitment(state.secret, state.randomness)),
      nullifier: toHex(computeNullifier(state.secret)),
    };
  }

  /** Submit feedback (rating + choice + free text) as a registered attendee. */
  async submit(
    voterId: string,
    rating: number,
    choice: number,
    feedback: string,
  ): Promise<VoterView> {
    const state = this.voters.get(voterId);
    if (!state) throw new Error(`Unknown voter ${voterId}`);
    const deployed = await this.connectAs(voterId, state);
    await (deployed as any).callTx.submit(BigInt(rating), BigInt(choice), feedback);
    return {
      commitment: toHex(computeCommitment(state.secret, state.randomness)),
      nullifier: toHex(computeNullifier(state.secret)),
    };
  }

  /** The commitment/nullifier a registered voter holds (no chain call). */
  voterView(voterId: string): VoterView | null {
    const state = this.voters.get(voterId);
    if (!state) return null;
    return {
      commitment: toHex(computeCommitment(state.secret, state.randomness)),
      nullifier: toHex(computeNullifier(state.secret)),
    };
  }

  private async readLedger() {
    if (!this.contractAddress) throw new Error("Contract not deployed yet");
    const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);
    const state = await provider.queryContractState(this.contractAddress);
    if (!state) throw new Error("Contract state not found");
    return votingLedger(state.data);
  }

  /** Public results: rating distribution + average, choice tallies, free text. */
  async readResults(): Promise<ResultsState> {
    const l = await this.readLedger();
    const ratingMax = Number(l.ratingMax);
    const choiceCount = Number(l.choiceCount);
    const ratingDistribution: number[] = [];
    let ratingSum = 0;
    let ratingN = 0;
    for (let r = 1; r <= ratingMax; r++) {
      const n = l.ratingTally.member(BigInt(r))
        ? Number(l.ratingTally.lookup(BigInt(r)).read())
        : 0;
      ratingDistribution.push(n);
      ratingSum += r * n;
      ratingN += n;
    }
    const choiceTallies: number[] = [];
    for (let c = 0; c < choiceCount; c++) {
      choiceTallies.push(
        l.choiceTally.member(BigInt(c))
          ? Number(l.choiceTally.lookup(BigInt(c)).read())
          : 0,
      );
    }
    const feedbacks: string[] = [];
    for (const [, text] of l.feedbacks) feedbacks.push(text);
    return {
      choiceCount,
      ratingMax,
      totalSubmissions: Number(l.totalSubmissions),
      ratingDistribution,
      ratingAverage: ratingN > 0 ? ratingSum / ratingN : 0,
      choiceTallies,
      feedbacks,
    };
  }

  /** Public on-chain artifacts for the privacy visualization. */
  async readChain(): Promise<ChainState> {
    const l = await this.readLedger();
    const nullifiers: string[] = [];
    for (const n of l.usedNullifiers) nullifiers.push(toHex(n));
    const digest = l.registeredVoters.root();
    const merkleRoot =
      typeof (digest as any).field === "bigint"
        ? (digest as any).field.toString(16)
        : String((digest as any).field ?? digest);
    return {
      contractAddress: this.contractAddress!,
      merkleRoot,
      treeSize: Number(l.registeredVoters.firstFree()),
      nullifiers,
      submissionCount: Number(l.totalSubmissions),
    };
  }

  get address(): string | null {
    return this.contractAddress;
  }

  get registeredCount(): number {
    return this.voters.size;
  }
}

interface WalletProvider {
  getCoinPublicKey: () => string;
  getEncryptionPublicKey: () => string;
  balanceTx: (tx: unknown, ttl?: Date) => Promise<unknown>;
  submitTx: (tx: unknown) => Promise<string>;
}

// Re-export for the integration test's balance helper.
export { ledgerSdk };
