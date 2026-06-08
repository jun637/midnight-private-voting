import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ChainState, type Config, type Results } from "./api.ts";
import { DomainSeparation, DualPanel, FindYourVote, ZkCeremony } from "./Privacy.tsx";
import { ResultsView } from "./Results.tsx";

const PHASE_LABEL: Record<string, string> = {
  starting: "지갑 초기화 중",
  funding: "배포 지갑 펀딩, DUST 등록 중",
  deploying: "피드백 컨트랙트 배포 중",
  ready: "준비 완료",
  error: "오류",
};

interface Saved {
  voterId: string;
  commitment: string;
  nullifier: string;
  done: boolean;
  rating: number;
  choice: number;
  feedback: string;
}
type Stage = "vote" | "submitting" | "explain" | "results";

const savedKey = (addr: string) => `pv-feedback:${addr}`;
const loadSaved = (addr: string | null): Saved | null => {
  if (!addr) return null;
  try {
    return JSON.parse(localStorage.getItem(savedKey(addr)) ?? "null");
  } catch {
    return null;
  }
};

export function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [chain, setChain] = useState<ChainState | null>(null);
  const [me, setMe] = useState<Saved | null>(null);
  const [stage, setStage] = useState<Stage>("vote");

  const [rating, setRating] = useState(0);
  const [choice, setChoice] = useState(-1);
  const [feedback, setFeedback] = useState("");

  const [step, setStep] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [msg, setMsg] = useState("");

  const addr = config?.contractAddress ?? null;
  const regRef = useRef<Promise<Saved> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const c = await api.config();
      setConfig(c);
      if (c.phase === "ready") {
        setResults(await api.results());
        setChain(await api.chain());
      }
    } catch {
      /* server warming up */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, [refresh]);

  // Restore prior session for this contract; jump straight to results if done.
  useEffect(() => {
    const saved = loadSaved(addr);
    setMe(saved);
    if (saved) {
      setRating(saved.rating);
      setChoice(saved.choice);
      setFeedback(saved.feedback);
      if (saved.done) setStage("results");
    }
  }, [addr]);

  // Register quietly in the background while the user fills the form.
  function ensureRegistered(): Promise<Saved> {
    if (me) return Promise.resolve(me);
    if (!regRef.current) {
      regRef.current = (async () => {
        const v = await api.register();
        const saved: Saved = {
          voterId: v.voterId!, commitment: v.commitment, nullifier: v.nullifier,
          done: false, rating: 0, choice: -1, feedback: "",
        };
        if (addr) localStorage.setItem(savedKey(addr), JSON.stringify(saved));
        setMe(saved);
        return saved;
      })().catch((e) => { regRef.current = null; throw e; });
    }
    return regRef.current;
  }

  useEffect(() => {
    if (config?.phase === "ready" && !me && stage === "vote") void ensureRegistered().catch(() => {});
  }, [config?.phase, me, stage]); // eslint-disable-line

  const ceremonyTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function submit() {
    if (rating < 1 || choice < 0) {
      setMsg("만족도와 객관식 항목을 선택하세요.");
      return;
    }
    setMsg("");
    setStage("submitting");
    setStep(0);
    ceremonyTimer.current = setInterval(() => setStep((s) => (s < 3 ? s + 1 : s)), 1800);
    try {
      const who = await ensureRegistered();
      const r = await api.submit({ voterId: who.voterId, rating, choice, feedback });
      if (ceremonyTimer.current) clearInterval(ceremonyTimer.current);
      setStep(4);
      const saved: Saved = { ...who, rating, choice, feedback, commitment: r.commitment, nullifier: r.nullifier, done: true };
      if (addr) localStorage.setItem(savedKey(addr), JSON.stringify(saved));
      setMe(saved);
      setResults(r.results);
      setChain(await api.chain());
      setTimeout(() => setStage("explain"), 700); // let the final step land
    } catch (e) {
      if (ceremonyTimer.current) clearInterval(ceremonyTimer.current);
      setStep(0);
      const m = (e as Error).message;
      if (m.includes("Unknown voter")) {
        if (addr) localStorage.removeItem(savedKey(addr));
        setMe(null);
        regRef.current = null;
        setMsg("세션이 초기화됐습니다. 다시 시도하세요.");
      } else {
        setMsg(`제출 실패: ${m}`);
      }
      setStage("vote");
    }
  }

  // ─── Not ready ───
  if (!config || config.phase !== "ready") {
    return (
      <div className="wrap">
        <Header config={config} />
        <div className="card status">
          <div className="spinner" />
          <div>
            <strong>{config ? PHASE_LABEL[config.phase] : "서버 연결 중"}</strong>
            <div className="detail">{config?.phase === "error" ? "서버 로그를 확인하세요." : "잠시만 기다려 주세요."}</div>
          </div>
        </div>
      </div>
    );
  }

  const choiceLabel = choice >= 0 ? config.choiceOptions[choice] : "(미선택)";
  const wide = stage === "explain" || stage === "results";

  return (
    <div className={`wrap${wide ? " wide" : ""}`}>
      <Header config={config} />
      <StageDots stage={stage} />

      <div className="stage" key={stage}>
        {stage === "vote" && (
          <div className="card vote-card">
            <div className="block-title">{config.title}</div>
            <div className="q">{config.ratingQuestion}</div>
            <div className="stars">
              {Array.from({ length: config.ratingMax }, (_, i) => (
                <button key={i} className={`star ${rating >= i + 1 ? "on" : ""}`} onClick={() => setRating(i + 1)} aria-label={`${i + 1}점`}>★</button>
              ))}
            </div>
            <div className="q">{config.choiceQuestion}</div>
            <div className="choices">
              {config.choiceOptions.map((opt, i) => (
                <button key={i} className={`choice ${choice === i ? "on" : ""}`} onClick={() => setChoice(i)}>{opt}</button>
              ))}
            </div>
            <div className="q">{config.freeTextPrompt}</div>
            <textarea className="freetext" rows={3} placeholder="자유롭게 남겨주세요 (선택)" value={feedback} onChange={(e) => setFeedback(e.target.value)} />
            <button className="primary" onClick={submit}>익명으로 제출</button>
            <div className={`hintline ${rating >= 1 && choice >= 0 ? "ok" : ""}`}>
              {rating < 1 ? "만족도를 선택하세요." : choice < 0 ? "객관식 항목을 선택하세요." : "제출하면 신원 없이 익명으로 기록됩니다."}
            </div>
            {msg && <div className="msg">{msg}</div>}
          </div>
        )}

        {stage === "submitting" && (
          <div className="card vote-card">
            <div className="block-title">영지식 증명 생성</div>
            <ZkCeremony step={step} commitment={me?.commitment ?? ""} nullifier={me?.nullifier ?? ""} />
            <p className="muted sm">실제 ZK 증명을 생성하는 단계라 수십 초가 걸립니다.</p>
          </div>
        )}

        {stage === "explain" && me && (
          <div className="explain-stage">
            <div className="stage-head">
              <div className="block-title">방금 무슨 일이 일어났나</div>
              <p className="muted sm">당신의 제출이 어떻게 익명으로 처리됐는지 실제 값으로 보여줍니다.</p>
            </div>
            <DualPanel rating={rating || me.rating} choiceLabel={choice >= 0 ? choiceLabel : config.choiceOptions[me.choice] ?? "제출됨"} feedback={feedback || me.feedback} commitment={me.commitment} nullifier={me.nullifier} />
            <div className="explain-grid">
              <DomainSeparation commitment={me.commitment} nullifier={me.nullifier} />
              <FindYourVote chain={chain} myNullifier={me.nullifier} reveal={reveal} onReveal={() => setReveal(true)} />
            </div>
            <div className="stage-cta">
              <button className="primary" onClick={() => setStage("results")}>결과 보기</button>
            </div>
          </div>
        )}

        {stage === "results" && results && (
          <div className="results-stage">
            <ResultsView config={config} results={results} />
            {me?.done && (
              <div className="stage-cta">
                <button className="ghost" onClick={() => setStage("explain")}>내 익명 증명 다시 보기</button>
              </div>
            )}
          </div>
        )}
      </div>

      <footer>
        {config.contractAddress && (
          <div className="addr">contract <code>{config.contractAddress}</code> · {config.network}</div>
        )}
        <div className="note">로컬 devnet. 서버가 증명을 대행하며, 온체인에는 익명 commitment와 nullifier만 기록됩니다.</div>
      </footer>
    </div>
  );
}

function StageDots({ stage }: { stage: Stage }) {
  const order: Stage[] = ["vote", "explain", "results"];
  const labels: Record<string, string> = { vote: "작성", explain: "작동 방식", results: "결과" };
  const idx = stage === "submitting" ? 0 : order.indexOf(stage);
  return (
    <div className="stage-dots">
      {order.map((s, i) => (
        <div key={s} className={`sdot2 ${i === idx ? "on" : i < idx ? "past" : ""}`}>{labels[s]}</div>
      ))}
    </div>
  );
}

function Header({ config }: { config: Config | null }) {
  return (
    <header>
      <h1>{config?.title ?? "비공개 피드백"}</h1>
      <p className="sub">{config?.subtitle ?? "Midnight · commitment/nullifier 영지식 패턴"}</p>
    </header>
  );
}
