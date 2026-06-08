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
import { FEEDBACK } from "./poll-config.js";

const PORT = Number(process.env.PORT ?? 3001);

type Phase = "starting" | "funding" | "deploying" | "ready" | "error";
let phase: Phase = "starting";
let phaseDetail = "";
let service: VotingService | null = null;
const submitted = new Set<string>();

async function bootstrap() {
  try {
    const keys = deriveKeys(Buffer.from(randomBytes(32)).toString("hex"));
    const wallet = await initWallet(keys);
    const synced = await wallet.waitForSyncedState();
    const addr = MidnightBech32m.encode(NETWORK_ID, synced.unshielded.address).asString();

    phase = "funding";
    phaseDetail = "배포 지갑 펀딩 + DUST 등록";
    await fundFromGenesis(addr);
    await waitForNight(wallet, 10_000_000_000n);
    await registerDust(wallet, keys.unshieldedKeystore);
    if ((await waitForDust(wallet)) === 0n) throw new Error("DUST 0 — 수수료 불가");

    phase = "deploying";
    phaseDetail = "피드백 컨트랙트 배포";
    service = await VotingService.create(wallet, keys);
    await service.deploy(FEEDBACK.choiceOptions.length, FEEDBACK.ratingMax);
    console.log(`[boot] deployed at ${service.address}`);

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

const notReady = (res: express.Response) =>
  res.status(503).json({ phase, detail: phaseDetail });

app.get("/api/status", (_req, res) => {
  res.json({ phase, detail: phaseDetail, contractAddress: service?.address ?? null, network: NETWORK_ID });
});

app.get("/api/config", (_req, res) => {
  res.json({ ...FEEDBACK, phase, contractAddress: service?.address ?? null, network: NETWORK_ID });
});

app.get("/api/results", async (_req, res) => {
  if (phase !== "ready" || !service) return notReady(res);
  try {
    res.json({ ...(await service.readResults()), registeredCount: service.registeredCount });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// Public on-chain artifacts for the privacy visualization.
app.get("/api/chain", async (_req, res) => {
  if (phase !== "ready" || !service) return notReady(res);
  try {
    res.json(await service.readChain());
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/register", async (_req, res) => {
  if (phase !== "ready" || !service) return notReady(res);
  try {
    const voterId = Buffer.from(randomBytes(8)).toString("hex");
    const view = await service.registerVoter(voterId);
    res.json({ voterId, ...view });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.post("/api/submit", async (req, res) => {
  if (phase !== "ready" || !service) return notReady(res);
  const { voterId, rating, choice, feedback } = req.body ?? {};
  if (
    typeof voterId !== "string" ||
    typeof rating !== "number" ||
    typeof choice !== "number"
  ) {
    return res.status(400).json({ error: "voterId, rating, choice required" });
  }
  if (submitted.has(voterId)) {
    return res.status(409).json({ error: "이미 제출했습니다 (already submitted)" });
  }
  try {
    const view = await service.submit(
      voterId,
      rating,
      choice,
      typeof feedback === "string" ? feedback : "",
    );
    submitted.add(voterId);
    res.json({ ok: true, ...view, results: await service.readResults() });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  void bootstrap();
});
