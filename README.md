# 🗳️ Private Voting on Midnight

익명·중복불가 투표 DApp. Midnight의 **commitment / nullifier 영지식 패턴**으로,
누가 투표했는지 체인에 남기지 않으면서 1인 1표를 강제합니다.

> 학습/데모 목적으로 로컬 devnet에서 처음부터 끝까지 만든 풀스택 예제입니다.

## 동작 원리 (프라이버시 모델)

- **등록**: 유권자는 비밀값으로부터 만든 **commitment**를 Merkle 트리에 넣습니다.
  누가 자격이 있는지, commitment가 누구 것인지 알 수 없습니다.
- **투표**: 같은 비밀값으로 (영지식으로) 트리 멤버십을 증명하고, **다른 도메인**에서
  파생한 **nullifier**를 공개합니다. nullifier는 재투표를 막지만 commitment와
  암호학적으로 연결 불가 — 그래서 투표는 익명입니다.
- **집계**: 옵션별 표수는 공개되지만, 개별 표는 신원과 연결되지 않습니다.

핵심 컨트랙트: [`contract/src/voting.compact`](contract/src/voting.compact)

## 구조

```
contract/   Compact 스마트컨트랙트 + 컴파일 산출물 (ZK 회로의 프라이버시 코어)
server/     devnet 지갑 보유 · 컨트랙트 배포 · 증명 대행 · REST API (Express)
ui/         React + Vite 브라우저 화면 (서버 REST와 통신, 온체인 작업 없음)
```

## 사전 준비

- Node 20+, npm
- 로컬 Midnight devnet 가동 (node `:9944`, indexer `:8088`, proof-server `:6300`)
- Compact CLI (컨트랙트 재컴파일 시): `compact compile`

## 실행

```bash
# 1) 의존성 설치 (워크스페이스)
npm install

# 2) (선택) 컨트랙트 재컴파일
npm --workspace contract run build

# 3) 서버 기동 — 부팅 시 지갑 펀딩 + DUST 등록 + 컨트랙트 배포 (수십 초)
npm --workspace server run dev      # http://localhost:3001

# 4) UI 기동
npm --workspace ui run dev          # http://localhost:5173
```

브라우저에서 `http://localhost:5173` 접속 → "유권자로 등록" → 항목 선택 투표.
서버가 `ready`가 될 때까지 화면이 초기화 상태를 표시합니다.

엔드투엔드 검증만 빠르게 보려면:

```bash
npm --workspace server run test:integration
```

(배포 → 2명 등록 → 각자 투표 → 집계 확인 → 동일인 재투표 거부)

## 알려진 이슈 (Known Issues)

이 프로젝트를 로컬 devnet에서 검증하며 마주친, **SDK/환경 레벨의 실제 블로커**입니다
(코드 자체는 컴파일·타입체크·배포까지 통과):

1. **컨트랙트 콜의 `NotNormalized` (error 117).**
   최신 통합 SDK 라인(`midnight-js-contracts` 4.1.1 + `wallet-sdk-facade` 4.0.1 +
   `ledger-v8` 8.1.0)에서 `deployContract`는 성공하나, 첫 `callTx`(register/vote)가
   `1010: Invalid Transaction: Custom error: 117` (TransactionMalformed::NotNormalized)으로
   거부됩니다. `walletProvider.balanceTx`는 공식 `compact-cli-dev` 템플릿과 동일 패턴
   (`balanceUnboundTransaction` → `finalizeRecipe`)이라 사용자 코드 문제가 아니며,
   콜 경로의 SDK 버전 호환성 회귀로 의심됩니다. 이전 검증에서 콜까지 동작한 조합은
   구 라인(`facade` 3.0.0 / `ledger-v8` 8.0.3 / `midnight-js` 4.0.4)뿐이었습니다.

2. **로컬 devnet 제네시스 dust 오염 (error 196, DustDoubleSpend).**
   같은 제네시스 지갑으로 반복 펀딩하면 dust 코인 재선택으로 `Custom error: 196`이
   날 수 있습니다. 깨끗한 재시작(볼륨 리셋)으로 해소됩니다.

## 정직한 한계 (데모 아키텍처)

- **로컬 devnet 전용.** 테스트 시드는 일회용이며 절대 커밋하지 않습니다(`.gitignore` 참고).
- **증명 대행 서버.** 데모 편의를 위해 서버가 devnet 지갑을 들고 각 유권자의 비밀로
  증명을 대신 만듭니다. 즉 *서버는* 투표 내용을 알 수 있습니다. 온체인 관찰자에 대한
  익명성·중복차단은 진짜이며, 프로덕션이라면 비밀·증명을 각 사용자의 브라우저 지갑으로
  옮겨 서버 신뢰도 제거해야 합니다.
- 옵션 선택값(어느 항목)은 공개입니다(집계를 위해). 숨기는 것은 *투표자 신원*입니다.

## 라이선스

Apache-2.0
