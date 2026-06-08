/** Session feedback form. Questions/labels live off-chain; the contract stores
 *  only anonymous tallies + free text. Multiple-choice options are easy to tweak
 *  right before the session (here + the contract's choiceCount stays >= options). */
export const FEEDBACK = {
  title: "오늘 세션 피드백",
  subtitle: "Midnight 방식으로 — 익명이지만 1인 1회. 누가 썼는지는 체인에 남지 않습니다.",
  ratingQuestion: "오늘 세션, 얼마나 만족하셨나요?",
  ratingMax: 5,
  choiceQuestion: "가장 인상 깊었던 부분은?",
  choiceOptions: [
    "Midnight 개요",
    "기술 아키텍처",
    "Expert로 즉석 DApp 빌드",
    "프라이버시(ZK) 데모",
  ],
  freeTextPrompt: "자유 피드백 (익명)",
} as const;
