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
}
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

  const [rating, setRating] = useState(0);
  const [choice, setChoice] = useState(-1);
  const [feedback, setFeedback] = useState("");

  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [reveal, setReveal] = useState(false);
  const [msg, setMsg] = useState("");

  const addr = config?.contractAddress ?? null;

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
    const id = setInterval(refresh, 3500);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    setMe(loadSaved(addr));
  }, [addr]);

  async function register() {
    if (!addr) return;
    setBusy(true);
    setMsg("등록 중. commitment 생성 후 트리에 합류합니다.");
    try {
      const v = await api.register();
      const saved: Saved = { voterId: v.voterId!, commitment: v.commitment, nullifier: v.nullifier, done: false };
      localStorage.setItem(savedKey(addr), JSON.stringify(saved));
      setMe(saved);
      setMsg("등록 완료. 이제 익명으로 작성할 수 있습니다.");
      void refresh();
    } catch (e) {
      setMsg(`등록 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const ceremonyTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function submit() {
    if (!me || !addr) return;
    if (rating < 1 || choice < 0) {
      setMsg("만족도와 객관식 항목을 선택하세요.");
      return;
    }
    setBusy(true);
    setStep(0);
    setMsg("");
    ceremonyTimer.current = setInterval(() => setStep((s) => (s < 3 ? s + 1 : s)), 1800);
    try {
      const r = await api.submit({ voterId: me.voterId, rating, choice, feedback });
      if (ceremonyTimer.current) clearInterval(ceremonyTimer.current);
      setStep(4);
      const saved: Saved = { ...me, nullifier: r.nullifier, commitment: r.commitment, done: true };
      localStorage.setItem(savedKey(addr), JSON.stringify(saved));
      setMe(saved);
      setResults(r.results);
      setChain(await api.chain());
      setMsg("");
    } catch (e) {
      if (ceremonyTimer.current) clearInterval(ceremonyTimer.current);
      setStep(0);
      const m = (e as Error).message;
      if (m.includes("Unknown voter")) {
        localStorage.removeItem(savedKey(addr));
        setMe(null);
        setMsg("세션이 초기화됐습니다. 다시 등록하세요.");
      } else {
        setMsg(`제출 실패: ${m}`);
      }
    } finally {
      setBusy(false);
    }
  }

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
  const submitting = busy && step < 4 && !me?.done && rating >= 1;

  const actionContent = submitting ? (
    <div className="card">
      <div className="block-title">영지식 증명 생성</div>
      <ZkCeremony step={step} commitment={me?.commitment ?? ""} nullifier={me?.nullifier ?? ""} />
      <p className="muted sm">실제 ZK 증명을 생성하는 단계라 수십 초가 걸립니다.</p>
    </div>
  ) : !me ? (
    <div className="card">
      <div className="block-title">익명으로 시작</div>
      <p className="lead">먼저 익명 신분(commitment)을 만듭니다. 신원은 체인에 기록되지 않습니다.</p>
      <button className="primary" disabled={busy} onClick={register}>익명으로 시작</button>
      {msg && <div className="msg">{msg}</div>}
    </div>
  ) : !me.done ? (
    <div className="card">
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
      <button className="primary" disabled={busy} onClick={submit}>익명으로 제출</button>
      <div className={`hintline ${rating >= 1 && choice >= 0 ? "ok" : ""}`}>
        {rating < 1 ? "만족도를 선택하세요." : choice < 0 ? "객관식 항목을 선택하세요." : "제출 준비 완료. 신원은 노출되지 않습니다."}
      </div>
      {msg && <div className="msg">{msg}</div>}
    </div>
  ) : (
    <div className="card">
      <div className="block-title done">제출 완료</div>
      <p className="lead">익명으로 기록됐습니다. 신원은 체인에 남지 않았습니다. 오른쪽에서 직접 확인해 보세요.</p>
    </div>
  );

  const dashboardContent = (
    <>
      {me && (
        <DualPanel
          rating={me.done ? rating || 5 : rating}
          choiceLabel={me.done ? (choice >= 0 ? choiceLabel : "제출됨") : choiceLabel}
          feedback={feedback}
          commitment={me.commitment}
          nullifier={me.nullifier}
        />
      )}
      {me?.done && (
        <FindYourVote chain={chain} myNullifier={me.nullifier} reveal={reveal} onReveal={() => setReveal(true)} />
      )}
      {results && <ResultsView config={config} results={results} />}
      <DomainSeparation commitment={me?.commitment ?? ""} nullifier={me?.nullifier ?? ""} />
    </>
  );

  const dashboardLocked = !me;
  return (
    <div className="wrap wide">
      <Header config={config} />
      <div className={`layout${dashboardLocked ? " pre" : ""}`}>
        <section className="col col-action">
          <div className="col-tag">참여</div>
          {actionContent}
        </section>
        <section className={`col col-dashboard${dashboardLocked ? " locked" : ""}`}>
          <div className="col-tag">결과 · 검증</div>
          {dashboardLocked && (
            <div className="lock-overlay">
              <div className="lock-tag">LOCKED</div>
              <div className="lock-text">왼쪽에서 참여를 시작하면 활성화됩니다.</div>
            </div>
          )}
          <div className="dash-body">{dashboardContent}</div>
        </section>
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

function Header({ config }: { config: Config | null }) {
  return (
    <header>
      <h1>{config?.title ?? "비공개 피드백"}</h1>
      <p className="sub">{config?.subtitle ?? "Midnight · commitment/nullifier 영지식 패턴"}</p>
    </header>
  );
}
