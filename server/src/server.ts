import "./ws-polyfill.js";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import express from "express";
import cors from "cors";
import { MidnightBech32m } from "@midnight-ntwrk/wallet-sdk-address-format";
import {
  deriveKeys,
  initWallet,
  fundFromGenesis,
  registerDust,
  waitForNight,
  waitForDust,
  NETWORK_ID,
} from "./wallet.js";
import { VotingService } from "./voting-service.js";
import { POLL } from "./poll-config.js";

const PORT = Number(process.env.PORT ?? 3001);

type Phase = "starting" | "funding" | "deploying" | "ready" | "error";
let phase: Phase = "starting";
let phaseDetail = "";
let service: VotingService | null = null;

// Map a public voterId -> whether they have already voted (server-side guard;
// the contract's nullifier is the real enforcement).
const voted = new Set<string>();

async function bootstrap() {
  try {
    const deployerSeed = Buffer.from(randomBytes(32)).toString("hex");
    const keys = deriveKeys(deployerSeed);
    const wallet = await initWallet(keys);
    const synced = await wallet.waitForSyncedState();
    const addr = MidnightBech32m.encode(
      NETWORK_ID,
      synced.unshielded.address,
    ).asString();

    phase = "funding";
    phaseDetail = "Funding deployer from genesis + registering DUST";
    console.log(`[boot] funding ${addr.slice(0, 24)}...`);
    await fundFromGenesis(addr);
    await waitForNight(wallet, 10_000_000_000n);
    await registerDust(wallet, keys.unshieldedKeystore);
    const dust = await waitForDust(wallet);
    if (dust === 0n) throw new Error("DUST balance is 0 — cannot pay fees");

    phase = "deploying";
    phaseDetail = `Deploying poll with ${POLL.options.length} options`;
    console.log("[boot] deploying poll contract...");
    service = await VotingService.create(wallet, keys);
    const address = await service.deploy(POLL.options.length);
    console.log(`[boot] poll deployed at ${address}`);

    phase = "ready";
    phaseDetail = "";
  } catch (e) {
    phase = "error";
    phaseDetail = (e as Error).message;
    console.error("[boot] failed:", e);
  }
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/status", (_req, res) => {
  res.json({
    phase,
    detail: phaseDetail,
    contractAddress: service?.address ?? null,
    network: NETWORK_ID,
  });
});

app.get("/api/poll", async (_req, res) => {
  if (phase !== "ready" || !service) {
    return res.status(503).json({ phase, detail: phaseDetail });
  }
  try {
    const state = await service.readPoll();
    res.json({
      question: POLL.question,
      options: POLL.options,
      tallies: state.tallies,
      totalVotes: state.totalVotes,
      registeredCount: service.registeredCount,
      contractAddress: service.address,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Register a new anonymous voter; returns a private token the client keeps.
app.post("/api/register", async (_req, res) => {
  if (phase !== "ready" || !service) {
    return res.status(503).json({ phase, detail: phaseDetail });
  }
  try {
    const voterId = Buffer.from(randomBytes(8)).toString("hex");
    await service.registerVoter(voterId);
    res.json({ voterId });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/vote", async (req, res) => {
  if (phase !== "ready" || !service) {
    return res.status(503).json({ phase, detail: phaseDetail });
  }
  const { voterId, option } = req.body ?? {};
  if (typeof voterId !== "string" || typeof option !== "number") {
    return res.status(400).json({ error: "voterId (string) and option (number) required" });
  }
  if (voted.has(voterId)) {
    return res.status(409).json({ error: "이미 투표했습니다 (already voted)" });
  }
  try {
    await service.castVote(voterId, option);
    voted.add(voterId);
    const state = await service.readPoll();
    res.json({ ok: true, tallies: state.tallies, totalVotes: state.totalVotes });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  void bootstrap();
});
