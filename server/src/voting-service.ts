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

export interface PollState {
  optionCount: number;
  totalVotes: number;
  tallies: number[];
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

  /** Deploy a fresh poll with `numOptions` options. */
  async deploy(numOptions: number): Promise<string> {
    const providers = this.buildProviders("admin");
    // The deployer needs a private state too; a throwaway voter identity works.
    const deployerState = createVoterState();
    const deployed = await deployContract(providers as never, {
      compiledContract: this.compiled() as never,
      privateStateId: "admin",
      initialPrivateState: deployerState,
      args: [BigInt(numOptions)],
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

  /** Register a new eligible voter; returns the opaque voter id. */
  async registerVoter(voterId: string): Promise<void> {
    if (this.voters.has(voterId))
      throw new Error(`Voter ${voterId} already registered`);
    const state = createVoterState();
    const deployed = await this.connectAs(voterId, state);
    await (deployed as any).callTx.register();
    this.voters.set(voterId, state);
  }

  /** Cast a vote for `option` as a registered voter. */
  async castVote(voterId: string, option: number): Promise<void> {
    const state = this.voters.get(voterId);
    if (!state) throw new Error(`Unknown voter ${voterId}`);
    const deployed = await this.connectAs(voterId, state);
    await (deployed as any).callTx.vote(BigInt(option));
  }

  /** Read the public poll state (option count, total votes, per-option tallies). */
  async readPoll(): Promise<PollState> {
    if (!this.contractAddress) throw new Error("Contract not deployed yet");
    const provider = indexerPublicDataProvider(INDEXER_HTTP, INDEXER_WS);
    const state = await provider.queryContractState(this.contractAddress);
    if (!state) throw new Error("Contract state not found");
    const l = votingLedger(state.data);
    const optionCount = Number(l.optionCount);
    const tallies: number[] = [];
    for (let i = 0; i < optionCount; i++) {
      tallies.push(l.tallies.member(BigInt(i)) ? Number(l.tallies.lookup(BigInt(i)).read()) : 0);
    }
    return { optionCount, totalVotes: Number(l.totalVotes), tallies };
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
