import {
  persistentHash,
  persistentCommit,
  CompactTypeVector,
  CompactTypeBytes,
} from "@midnight-ntwrk/compact-runtime";
import { Buffer } from "node:buffer";

// Mirror the contract's `Vector<2, Bytes<32>>` argument type so we can compute
// the SAME commitment / nullifier the circuit produces — for the privacy
// visualization. These are the real values that land on-chain (verified against
// the ledger's nullifier set in the integration test).
const VEC2_BYTES32 = new CompactTypeVector(2, new CompactTypeBytes(32));

/** Compact's pad(n, s): UTF-8 bytes of `s`, right zero-padded to `n` bytes. */
function pad(n: number, s: string): Uint8Array {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length > n) throw new Error(`pad: "${s}" exceeds ${n} bytes`);
  const out = new Uint8Array(n);
  out.set(bytes, 0);
  return out;
}

// Domain separators — MUST match voting.compact exactly.
const COMMIT_DOMAIN = pad(32, "vote:commit:::");
const NULLIFIER_DOMAIN = pad(32, "vote:nullify::");

/** commitment = persistentCommit([("commit::"), secret], randomness). Goes into the tree. */
export function computeCommitment(
  secret: Uint8Array,
  randomness: Uint8Array,
): Uint8Array {
  return persistentCommit(VEC2_BYTES32, [COMMIT_DOMAIN, secret], randomness);
}

/** nullifier = persistentHash([("nullify::"), secret]). Published to block re-submission. */
export function computeNullifier(secret: Uint8Array): Uint8Array {
  return persistentHash(VEC2_BYTES32, [NULLIFIER_DOMAIN, secret]);
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
