import { randomBytes } from "node:crypto";
import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import type { Witnesses, Ledger } from "@private-voting/contract";

/**
 * Per-voter private state. These bytes never leave the server's process and are
 * never written on-chain — the ZK proof system consumes them inside the circuit
 * to derive the commitment and nullifier without revealing the raw values.
 */
export interface VoterPrivateState {
  readonly secret: Uint8Array;
  readonly randomness: Uint8Array;
}

/** Generate a fresh voter identity (secret + blinding randomness). */
export function createVoterState(): VoterPrivateState {
  return {
    secret: new Uint8Array(randomBytes(32)),
    randomness: new Uint8Array(randomBytes(32)),
  };
}

/**
 * Witness implementations matching the `voting.compact` declarations.
 * - voter_secret / voter_randomness: read from private state.
 * - get_voter_path: look up the Merkle membership proof for a commitment
 *   directly from the on-chain ledger state (the runtime injects `ledger`).
 */
export const votingWitnesses: Witnesses<VoterPrivateState> = {
  voter_secret: ({
    privateState,
  }: WitnessContext<Ledger, VoterPrivateState>): [
    VoterPrivateState,
    Uint8Array,
  ] => [privateState, privateState.secret],

  voter_randomness: ({
    privateState,
  }: WitnessContext<Ledger, VoterPrivateState>): [
    VoterPrivateState,
    Uint8Array,
  ] => [privateState, privateState.randomness],

  get_voter_path: (
    { privateState, ledger }: WitnessContext<Ledger, VoterPrivateState>,
    commitment: Uint8Array,
  ): [
    VoterPrivateState,
    {
      leaf: Uint8Array;
      path: { sibling: { field: bigint }; goes_left: boolean }[];
    },
  ] => {
    const merklePath = ledger.registeredVoters.findPathForLeaf(commitment);
    if (!merklePath) {
      throw new Error("Voter commitment not found in the registration tree");
    }
    return [privateState, merklePath];
  },
};
