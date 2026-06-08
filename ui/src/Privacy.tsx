import type { ChainState } from "./api.ts";

export const short = (hex: string, head = 10, tail = 6) =>
  !hex ? "" : hex.length <= head + tail ? hex : `${hex.slice(0, head)}…${hex.slice(-tail)}`;
const placeholder = "·";

/* Domain separation: one secret, two unlinkable hashes. */
export function DomainSeparation({
  commitment,
  nullifier,
}: {
  commitment: string;
  nullifier: string;
}) {
  return (
    <div className="card viz">
      <div className="block-title">익명인데 중복은 막히는 이유</div>
      <div className="domain">
        <div className="secret-node">당신의 비밀<br /><code>0x••••••••</code><br /><span className="faint">당신만 보유</span></div>
        <div className="forks">
          <div className="fork">
            <div className="fork-label">"commit::" 도메인</div>
            <div className="hash-node commit">
              commitment
              <code>{short(commitment) || placeholder}</code>
              <span className="faint">Merkle 트리에 기록</span>
            </div>
          </div>
          <div className="fork">
            <div className="fork-label">"nullify::" 도메인</div>
            <div className="hash-node nullify">
              nullifier
              <code>{short(nullifier) || placeholder}</code>
              <span className="faint">중복 제출 차단</span>
            </div>
          </div>
        </div>
      </div>
      <p className="explain">
        같은 비밀에서 나왔지만 <b>다른 도메인</b>으로 해싱되므로, 비밀을 모르면 둘을 연결할 수
        없습니다. 그래서 <b>익명</b>이면서도 <b>1인 1회</b>가 동시에 성립합니다.
      </p>
    </div>
  );
}

/* ZK ceremony shown during submission, tied to the real proof time. */
const CEREMONY = [
  "비밀값으로 commitment 생성",
  "Merkle 트리 멤버십 영지식 증명",
  "nullifier 공개 (신원과 분리)",
  "온체인 기록, 작성자 정보 없음",
];
export function ZkCeremony({
  step,
  commitment,
  nullifier,
}: {
  step: number;
  commitment: string;
  nullifier: string;
}) {
  return (
    <div className="ceremony">
      {CEREMONY.map((label, i) => {
        const state = step > i ? "done" : step === i ? "active" : "todo";
        return (
          <div key={i} className={`cstep ${state}`}>
            <span className="cmark">{state === "done" ? "✓" : state === "active" ? "•" : "○"}</span>
            <span className="clabel">{label}</span>
            {i === 0 && step > 0 && commitment && <code>{short(commitment)}</code>}
            {i === 2 && step > 2 && nullifier && <code>{short(nullifier)}</code>}
          </div>
        );
      })}
    </div>
  );
}

/* Dual panel: what only you know vs what the chain sees. */
export function DualPanel({
  rating,
  choiceLabel,
  feedback,
  commitment,
  nullifier,
}: {
  rating: number;
  choiceLabel: string;
  feedback: string;
  commitment: string;
  nullifier: string;
}) {
  return (
    <div className="dual">
      <div className="pane you">
        <div className="pane-h">당신만 아는 것</div>
        <Row k="신원" v="당신 (로컬에만)" />
        <Row k="비밀값" v="0x•••• (전송 안 됨)" />
        <Row k="만족도" v={"★".repeat(rating) + "☆".repeat(Math.max(0, 5 - rating))} />
        <Row k="선택" v={choiceLabel} />
        <Row k="자유의견" v={feedback || placeholder} />
      </div>
      <div className="pane chain">
        <div className="pane-h">온체인 (공개)</div>
        <Row k="commitment" v={short(commitment) || placeholder} mono />
        <Row k="nullifier" v={short(nullifier) || placeholder} mono />
        <Row k="집계" v={`${choiceLabel} +1, ★${rating}`} />
        <Row k="작성자" v="없음" />
      </div>
    </div>
  );
}
function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="drow">
      <span className="dk">{k}</span>
      <span className={`dv${mono ? " mono" : ""}`}>{v}</span>
    </div>
  );
}

/* Find your vote: the public state where you cannot be found. */
export function FindYourVote({
  chain,
  myNullifier,
  reveal,
  onReveal,
}: {
  chain: ChainState | null;
  myNullifier: string;
  reveal: boolean;
  onReveal: () => void;
}) {
  if (!chain) return null;
  return (
    <div className="card viz">
      <div className="block-title">공개 기록에서 내 제출 찾기</div>
      <div className="chainstate">
        <div className="cs-block">
          <div className="cs-h">commitment 트리 · {chain.treeSize}명 등록</div>
          <div className="cs-note">개별 commitment는 공개 상태에서 열거되지 않고 root만 보입니다.</div>
          <code className="root">root {short(chain.merkleRoot, 12, 8)}</code>
        </div>
        <div className="cs-block">
          <div className="cs-h">nullifier 집합 · {chain.nullifiers.length}건 제출</div>
          <div className="nullifier-grid">
            {chain.nullifiers.map((n) => (
              <code key={n} className={reveal && n === myNullifier ? "nf mine" : "nf"}>
                {short(n, 8, 4)}
                {reveal && n === myNullifier && <span className="you-tag"> 당신</span>}
              </code>
            ))}
            {chain.nullifiers.length === 0 && <span className="faint">아직 제출 없음</span>}
          </div>
        </div>
      </div>
      <p className="explain">
        당신의 commitment와 nullifier는 <b>같은 비밀</b>에서 나왔지만, 어느 것이 짝인지
        <b> 수학적으로 찾을 수 없습니다.</b>
      </p>
      {myNullifier && !reveal && (
        <button className="ghost" onClick={onReveal}>내 nullifier 표시</button>
      )}
    </div>
  );
}
