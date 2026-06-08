import type { Config, Results } from "./api.ts";

export function ResultsView({ config, results }: { config: Config; results: Results }) {
  const maxChoice = Math.max(1, ...results.choiceTallies);
  const maxRating = Math.max(1, ...results.ratingDistribution);
  return (
    <div className="card">
      <div className="results-head">
        <h2>실시간 결과</h2>
        <div className="stat">
          <span className="big">{results.ratingAverage.toFixed(1)}</span>
          <span className="muted"> / {results.ratingMax} 평균 만족도 · {results.totalSubmissions}명 제출</span>
        </div>
      </div>

      <h4>{config.ratingQuestion}</h4>
      <div className="rating-dist">
        {results.ratingDistribution.map((n, i) => (
          <div className="rcol" key={i}>
            <div className="rbar-wrap">
              <div className="rbar" style={{ height: `${(n / maxRating) * 100}%` }}>
                <span className="rn">{n}</span>
              </div>
            </div>
            <div className="rstar">{"★".repeat(i + 1)}</div>
          </div>
        ))}
      </div>

      <h4>{config.choiceQuestion}</h4>
      <ul className="options">
        {config.choiceOptions.map((opt, i) => {
          const c = results.choiceTallies[i] ?? 0;
          const pct = results.totalSubmissions > 0 ? Math.round((c / results.totalSubmissions) * 100) : 0;
          return (
            <li key={i}>
              <div className="opt-head">
                <span className="opt-name">{opt}</span>
                <span className="opt-count">{c} · {pct}%</span>
              </div>
              <div className="bar-bg">
                <div className="bar-fill" style={{ width: `${(c / maxChoice) * 100}%` }} />
              </div>
            </li>
          );
        })}
      </ul>

      <h4>{config.freeTextPrompt} · 익명 피드백 월</h4>
      <div className="wall">
        {results.feedbacks.length === 0 && <div className="muted">아직 의견이 없습니다.</div>}
        {results.feedbacks.map((f, i) => (
          <div className="note-card" key={i}>{f || <span className="muted">(빈 의견)</span>}</div>
        ))}
      </div>
    </div>
  );
}
