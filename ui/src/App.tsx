import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ChainState, type Config, type Results } from "./api.ts";
import { DomainSeparation, DualPanel, FindYourVote, ZkCeremony } from "./Privacy.tsx";
import { ResultsView } from "./Results.tsx";

const PHASE_LABEL: Record<string, string> = {
  starting: "지갑 초기화 중…",
  funding: "배포 지갑 펀딩 + DUST 등록 중…",
  deploying: "피드백 컨트랙트 배포 중…",
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
  const [step, setStep] = useState(0); // ZK ceremony step
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

  // Load my saved registration for the current contract (auto-discards stale ones).
  useEffect(() => {
    setMe(loadSaved(addr));
  }, [addr]);

  async function register() {
    if (!addr) return;
    setBusy(true);
    setMsg("참여자 등록 중… (commitment 생성 + 트리 합류)");
    try {
      const v = await api.register();
      const saved: Saved = {
        voterId: v.voterId!,
        commitment: v.commitment,
        nullifier: v.nullifier,
        done: false,
      };
      localStorage.setItem(savedKey(addr), JSON.stringify(saved));
      setMe(saved);
      setMsg("등록 완료 — 이제 익명으로 피드백을 남길 수 있어요.");
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
      setMsg("만족도와 객관식 항목을 선택해주세요.");
      return;
    }
    setBusy(true);
    setStep(0);
    setMsg("");
    // Animate the ZK ceremony while the real proof is generated server-side.
    ceremonyTimer.current = setInterval(() => {
      setStep((s) => (s < 3 ? s + 1 : s));
    }, 1800);
    try {
      const r = await api.submit({ voterId: me.voterId, rating, choice, feedback });
      if (ceremonyTimer.current) clearInterval(ceremonyTimer.current);
      setStep(4);
      const saved: Saved = { ...me, nullifier: r.nullifier, commitment: r.commitment, done: true };
      localStorage.setItem(savedKey(addr), JSON.stringify(saved));
      setMe(saved);
      setResults(r.results);
      setChain(await api.chain());
      setMsg("제출 완료! 당신의 신원은 체인에 남지 않았습니다.");
    } catch (e) {
      if (ceremonyTimer.current) clearInterval(ceremonyTimer.current);
      setStep(0);
      const m = (e as Error).message;
      if (m.includes("Unknown voter")) {
        localStorage.removeItem(savedKey(addr));
        setMe(null);
        setMsg("세션이 초기화됐어요(서버 재시작). 다시 등록해주세요.");
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
            <strong>{config ? PHASE_LABEL[config.phase] : "서버 연결 중…"}</strong>
            <div className="detail">{config?.phase === "error" ? "오류 — 서버 로그 확인" : "잠시만요…"}</div>
          </div>
        </div>
      </div>
    );
  }

  const choiceLabel = choice >= 0 ? config.choiceOptions[choice] : "(미선택)";
  const submitting = busy && step < 4 && !me?.done && rating >= 1;

  return (
    <div className="wrap">
      <Header config={config} />

      {/* ─── Submitting: ZK ceremony takes over ─── */}
      {submitting ? (
        <div className="card">
          <h2>영지식 증명 생성 중…</h2>
          <ZkCeremony step={step} commitment={me?.commitment ?? ""} nullifier={me?.nullifier ?? ""} />
          <p className="muted">실제 ZK 증명을 만드는 중이라 수십 초 걸립니다. 이게 진짜 Midnight 연산이에요.</p>
        </div>
      ) : !me ? (
        /* ─── Not registered: intro + domain separation + join ─── */
        <>
          <div className="card actions">
            <p className="lead">이 피드백은 <b>Midnight 방식</b>으로 받습니다. 먼저 참여자로 등록하면 당신의 익명 신분(commitment)이 만들어집니다.</p>
            <button className="primary" disabled={busy} onClick={register}>참여 시작 (익명 등록)</button>
            {msg && <div className="msg">{msg}</div>}
          </div>
          <DomainSeparation commitment="" nullifier="" />
        </>
      ) : !me.done ? (
        /* ─── Registered, not submitted: form + live dual panel + domain sep ─── */
        <>
          <div className="card">
            <h2>{config.title}</h2>
            <h4>{config.ratingQuestion}</h4>
            <div className="stars">
              {Array.from({ length: config.ratingMax }, (_, i) => (
                <button
                  key={i}
                  className={`star ${rating >= i + 1 ? "on" : ""}`}
                  onClick={() => setRating(i + 1)}
                  aria-label={`${i + 1}점`}
                >★</button>
              ))}
            </div>

            <h4>{config.choiceQuestion}</h4>
            <div className="choices">
              {config.choiceOptions.map((opt, i) => (
                <button
                  key={i}
                  className={`choice ${choice === i ? "on" : ""}`}
                  onClick={() => setChoice(i)}
                >{opt}</button>
              ))}
            </div>

            <h4>{config.freeTextPrompt}</h4>
            <textarea
              className="freetext"
              rows={3}
              placeholder="자유롭게 남겨주세요 (선택)"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
            />

            <button className="primary" disabled={busy} onClick={submit}>익명으로 제출</button>
            {msg && <div className="msg">{msg}</div>}
          </div>

          <DualPanel
            rating={rating}
            choiceLabel={choiceLabel}
            feedback={feedback}
            commitment={me.commitment}
            nullifier={me.nullifier}
          />
          <DomainSeparation commitment={me.commitment} nullifier={me.nullifier} />
        </>
      ) : (
        /* ─── Submitted: confirmation + find-your-vote + dual panel ─── */
        <>
          <div className="card done-card">
            <div className="done">✅ 제출 완료 (익명)</div>
            <div className="muted">{msg || "당신의 신원은 체인에 남지 않았습니다."}</div>
          </div>
          <FindYourVote chain={chain} myNullifier={me.nullifier} reveal={reveal} onReveal={() => setReveal(true)} />
          <DualPanel
            rating={rating || 5}
            choiceLabel={choice >= 0 ? choiceLabel : "제출됨"}
            feedback={feedback}
            commitment={me.commitment}
            nullifier={me.nullifier}
          />
        </>
      )}

      {/* ─── Live results always visible (presenter-friendly) ─── */}
      {results && <ResultsView config={config} results={results} />}

      <footer>
        {config.contractAddress && (
          <div className="addr">컨트랙트 <code>{config.contractAddress}</code> · {config.network}</div>
        )}
        <div className="note">로컬 devnet · 서버가 증명을 대행합니다. 온체인엔 익명 commitment와 nullifier만 기록됩니다.</div>
      </footer>
    </div>
  );
}

function Header({ config }: { config: Config | null }) {
  return (
    <header>
      <h1>🗳️ {config?.title ?? "비공개 피드백"}</h1>
      <p className="sub">{config?.subtitle ?? "Midnight · commitment/nullifier 영지식 패턴"}</p>
    </header>
  );
}
