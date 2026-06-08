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

const OPTIONS = ["Midnight", "Ethereum", "Solana"];

async function main() {
  console.log("=== Private Voting — integration test ===\n");

  // 1. Deployer wallet
  const deployerSeed = Buffer.from(randomBytes(32)).toString("hex");
  console.log(`Deployer seed: ${deployerSeed.slice(0, 12)}...`);
  const keys = deriveKeys(deployerSeed);
  const wallet = await initWallet(keys);

  try {
    const synced = await wallet.waitForSyncedState();
    const addr = (await import("@midnight-ntwrk/wallet-sdk-address-format")).MidnightBech32m.encode(
      "undeployed",
      synced.unshielded.address,
    ).asString();
    console.log(`Deployer address: ${addr.slice(0, 24)}...`);

    // 2. Fund + DUST
    console.log("\nFunding deployer from genesis (10,000 NIGHT)...");
    const fundTx = await fundFromGenesis(addr);
    console.log(`  fund tx: ${fundTx.slice(0, 16)}...`);
    const night = await waitForNight(wallet, 10_000_000_000n);
    console.log(`  NIGHT balance: ${night}`);
    console.log("Registering DUST...");
    const dustTx = await registerDust(wallet, keys.unshieldedKeystore);
    console.log(`  dust tx: ${dustTx.slice(0, 16)}...`);
    const dust = await waitForDust(wallet);
    console.log(`  DUST balance: ${dust}`);
    if (dust === 0n) throw new Error("No DUST — cannot pay fees");

    // 3. Deploy poll
    console.log(`\nDeploying poll with ${OPTIONS.length} options...`);
    const svc = await VotingService.create(wallet, keys);
    const address = await svc.deploy(OPTIONS.length);
    console.log(`  contract: ${address}`);

    // 4. Register voters
    console.log("\nRegistering voters alice, bob...");
    await svc.registerVoter("alice");
    await svc.registerVoter("bob");
    console.log(`  registered: ${svc.registeredCount}`);

    // 5. Votes
    console.log("\nCasting votes: alice -> Midnight(0), bob -> Ethereum(1)...");
    await svc.castVote("alice", 0);
    await svc.castVote("bob", 1);

    // 6. Read tallies
    const poll = await svc.readPoll();
    console.log("\nPoll state:");
    poll.tallies.forEach((c, i) => console.log(`  ${OPTIONS[i]}: ${c}`));
    console.log(`  total: ${poll.totalVotes}`);
    if (poll.totalVotes !== 2 || poll.tallies[0] !== 1 || poll.tallies[1] !== 1) {
      throw new Error("Unexpected tally");
    }

    // 7. Double-vote must be rejected
    console.log("\nAlice attempts to vote again (must be rejected)...");
    let rejected = false;
    try {
      await svc.castVote("alice", 2);
    } catch (e) {
      rejected = true;
      console.log(`  correctly rejected: ${(e as Error).message?.slice(0, 70)}`);
    }
    if (!rejected) throw new Error("Double vote was NOT rejected!");

    const finalPoll = await svc.readPoll();
    console.log(`\nFinal total (unchanged): ${finalPoll.totalVotes}`);
    if (finalPoll.totalVotes !== 2) throw new Error("Double vote leaked into tally");

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
