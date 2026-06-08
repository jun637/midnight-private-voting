/** The poll question and option labels live off-chain; the contract only
 *  stores anonymous tallies indexed by option number. */
export const POLL = {
  question: "가장 기대되는 L1 블록체인은?",
  options: ["Midnight", "Ethereum", "Solana", "Bitcoin"],
} as const;
