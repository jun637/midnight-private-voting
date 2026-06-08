import { useCallback, useEffect, useState } from "react";

interface PollData {
  question: string;
  options: string[];
  tallies: number[];
  totalVotes: number;
  registeredCount: number;
  contractAddress: string;
}

interface Status {
  phase: "starting" | "funding" | "deploying" | "ready" | "error";
  detail: string;
  contractAddress: string | null;
  network: string;
}

const PHASE_LABEL: Record<Status["phase"], string> = {
  starting: "지갑 초기화 중…",
  funding: "배포 지갑 펀딩 + DUST 등록 중…",
  deploying: "투표 컨트랙트 배포 중…",
  ready: "준비 완료",
  error: "오류",
};

// Voter ids are scoped to a contract address: if the server is restarted and
// redeploys a fresh poll, old registrations no longer exist and must be discarded.
const voterKey = (contractAddress: string) => `pv-voter:${contractAddress}`;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [poll, setPoll] = useState<PollData | null>(null);
  const [voterId, setVoterId] = useState<string | null>(null);
  const [hasVoted, setHasVoted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>("");

  const contractAddress = poll?.contractAddress ?? status?.contractAddress ?? null;

  // Load the voter id registered against the CURRENT contract (if any). When the
  // server redeploys (new address), this yields null and the UI shows "register".
  useEffect(() => {
    if (!contractAddress) return;
    setVoterId(localStorage.getItem(voterKey(contractAddress)));
  }, [contractAddress]);

  const refreshStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/status");
      setStatus(await r.json());
    } catch {
      /* server not up yet */
    }
  }, []);

  const refreshPoll = useCallback(async () => {
    try {
      const r = await fetch("/api/poll");
      if (r.ok) setPoll(await r.json());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const id = setInterval(refreshStatus, 3000);
    return () => clearInterval(id);
  }, [refreshStatus]);

  useEffect(() => {
    if (status?.phase === "ready") {
      void refreshPoll();
      const id = setInterval(refreshPoll, 4000);
      return () => clearInterval(id);
    }
  }, [status?.phase, refreshPoll]);

  async function register() {
    setBusy(true);
    setMsg("유권자 등록 중… (영지식 commitment 생성)");
    try {
      const r = await fetch("/api/register", { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? "등록 실패");
      if (contractAddress) {
        localStorage.setItem(voterKey(contractAddress), data.voterId);
      }
      setVoterId(data.voterId);
      setHasVoted(false);
      setMsg("등록 완료 — 이제 익명으로 투표할 수 있어요.");
    } catch (e) {
      setMsg(`등록 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function vote(option: number) {
    if (!voterId) return;
    setBusy(true);
    setMsg(`투표 제출 중… (nullifier 영지식 증명 생성, 수십 초 소요)`);
    try {
      const r = await fetch("/api/vote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voterId, option }),
      });
      const data = await r.json();
      if (!r.ok) {
        // Stale registration (server redeployed / restarted): drop it and re-register.
        if (typeof data.error === "string" && data.error.includes("Unknown voter")) {
          if (contractAddress) localStorage.removeItem(voterKey(contractAddress));
          setVoterId(null);
          setMsg("세션이 초기화됐어요(서버 재시작). 다시 등록한 뒤 투표해주세요.");
          return;
        }
        throw new Error(data.error ?? "투표 실패");
      }
      setHasVoted(true);
      setMsg("투표 완료! 당신의 신원은 체인에 남지 않았습니다.");
      void refreshPoll();
    } catch (e) {
      setMsg(`투표 실패: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const ready = status?.phase === "ready" && poll;
  const maxTally = poll ? Math.max(1, ...poll.tallies) : 1;

  return (
    <div className="wrap">
      <header>
        <h1>🗳️ 비공개 투표</h1>
        <p className="sub">
          Midnight · commitment/nullifier 영지식 패턴 — 누가 투표했는지 체인에
          남지 않고, 중복 투표는 차단됩니다.
        </p>
      </header>

      {!ready ? (
        <div className="card status">
          <div className="spinner" />
          <div>
            <strong>{status ? PHASE_LABEL[status.phase] : "서버 연결 중…"}</strong>
            {status?.detail && <div className="detail">{status.detail}</div>}
            {status?.phase === "error" && (
              <div className="detail err">{status.detail}</div>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>{poll.question}</h2>
            <ul className="options">
              {poll.options.map((opt, i) => {
                const count = poll.tallies[i] ?? 0;
                const pct =
                  poll.totalVotes > 0
                    ? Math.round((count / poll.totalVotes) * 100)
                    : 0;
                return (
                  <li key={i}>
                    <div className="opt-head">
                      <span className="opt-name">{opt}</span>
                      <span className="opt-count">
                        {count}표 · {pct}%
                      </span>
                    </div>
                    <div className="bar-bg">
                      <div
                        className="bar-fill"
                        style={{ width: `${(count / maxTally) * 100}%` }}
                      />
                    </div>
                    {voterId && !hasVoted && (
                      <button
                        className="vote-btn"
                        disabled={busy}
                        onClick={() => vote(i)}
                      >
                        이 항목에 투표
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="totals">
              총 {poll.totalVotes}표 · 등록 유권자 {poll.registeredCount}명
            </div>
          </div>

          <div className="card actions">
            {!voterId ? (
              <button className="primary" disabled={busy} onClick={register}>
                유권자로 등록하기
              </button>
            ) : hasVoted ? (
              <div className="done">✅ 투표를 완료했습니다 (익명)</div>
            ) : (
              <div className="hint">위 항목 중 하나를 선택해 투표하세요.</div>
            )}
            {msg && <div className="msg">{msg}</div>}
          </div>
        </>
      )}

      <footer>
        {status?.contractAddress && (
          <div className="addr">
            컨트랙트: <code>{status.contractAddress}</code> · 네트워크:{" "}
            {status?.network}
          </div>
        )}
        <div className="note">
          이 데모는 로컬 devnet에서 서버가 증명을 대행합니다. 온체인에는 익명
          commitment와 nullifier만 기록되어 투표자 신원과 연결되지 않습니다.
        </div>
      </footer>
    </div>
  );
}
