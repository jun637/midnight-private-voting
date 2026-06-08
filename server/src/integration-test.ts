import "./ws-polyfill.js";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  deriveKeys,
  initWallet,
  fundFromGenesis,
  registerDust,
  waitForNight,
  waitForDust,
} from "./wallet.js";
import { VotingService } from "./voting-service.js";
import { FEEDBACK } from "./poll-config.js";

async function main() {
  console.log("=== Private Feedback — integration test ===\n");

  const deployerSeed = Buffer.from(randomBytes(32)).toString("hex");
  const keys = deriveKeys(deployerSeed);
  const wallet = await initWallet(keys);

  try {
    const synced = await wallet.waitForSyncedState();
    const addr = (
      await import("@midnight-ntwrk/wallet-sdk-address-format")
    ).MidnightBech32m.encode("undeployed", synced.unshielded.address).asString();

    console.log("Funding deployer from genesis...");
    await fundFromGenesis(addr);
    await waitForNight(wallet, 10_000_000_000n);
    await registerDust(wallet, keys.unshieldedKeystore);
    const dust = await waitForDust(wallet);
    if (dust === 0n) throw new Error("No DUST — cannot pay fees");

    console.log(`Deploying feedback (${FEEDBACK.choiceOptions.length} choices, rating 1..${FEEDBACK.ratingMax})...`);
    const svc = await VotingService.create(wallet, keys);
    const address = await svc.deploy(FEEDBACK.choiceOptions.length, FEEDBACK.ratingMax);
    console.log(`  contract: ${address}`);

    console.log("\nRegistering alice, bob...");
    const aliceReg = await svc.registerVoter("alice");
    await svc.registerVoter("bob");
    console.log(`  alice commitment: ${aliceReg.commitment.slice(0, 16)}…`);
    console.log(`  alice nullifier(pred): ${aliceReg.nullifier.slice(0, 16)}…`);

    console.log("\nSubmitting feedback...");
    await svc.submit("alice", 5, 2, "Expert 빌드가 인상적이었어요");
    await svc.submit("bob", 4, 3, "ZK 데모 최고");

    const results = await svc.readResults();
    console.log("\nResults:");
    console.log(`  rating avg: ${results.ratingAverage.toFixed(2)} dist=${JSON.stringify(results.ratingDistribution)}`);
    console.log(`  choices: ${JSON.stringify(results.choiceTallies)}`);
    console.log(`  feedbacks: ${JSON.stringify(results.feedbacks)}`);
    console.log(`  total: ${results.totalSubmissions}`);
    if (results.totalSubmissions !== 2) throw new Error("Unexpected submission count");
    if (results.feedbacks.length !== 2) throw new Error("Feedback texts missing");

    // Verify the computed nullifier really is the one on-chain (authentic viz values).
    const chain = await svc.readChain();
    console.log(`\nChain: treeSize=${chain.treeSize}, nullifiers=${chain.nullifiers.length}, root=${chain.merkleRoot.slice(0, 12)}…`);
    if (!chain.nullifiers.includes(aliceReg.nullifier)) {
      throw new Error("Computed nullifier NOT found on-chain — viz values would be fake!");
    }
    console.log("  ✓ computed nullifier matches on-chain set (viz values are real)");

    console.log("\nAlice re-submits (must be rejected)...");
    let rejected = false;
    try {
      await svc.submit("alice", 1, 0, "double");
    } catch (e) {
      rejected = true;
      console.log(`  correctly rejected: ${(e as Error).message?.slice(0, 60)}`);
    }
    if (!rejected) throw new Error("Double submission was NOT rejected!");

    const finalResults = await svc.readResults();
    if (finalResults.totalSubmissions !== 2) throw new Error("Double submission leaked");

    console.log("\n=== ALL CHECKS PASSED ===");
  } finally {
    await wallet.stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("\nIntegration test FAILED:", e);
    process.exit(1);
  });
