export interface Config {
  title: string;
  subtitle: string;
  ratingQuestion: string;
  ratingMax: number;
  choiceQuestion: string;
  choiceOptions: string[];
  freeTextPrompt: string;
  phase: Phase;
  contractAddress: string | null;
  network: string;
}

export type Phase = "starting" | "funding" | "deploying" | "ready" | "error";

export interface Status {
  phase: Phase;
  detail: string;
  contractAddress: string | null;
  network: string;
}

export interface Results {
  choiceCount: number;
  ratingMax: number;
  totalSubmissions: number;
  ratingDistribution: number[];
  ratingAverage: number;
  choiceTallies: number[];
  feedbacks: string[];
  registeredCount: number;
}

export interface ChainState {
  contractAddress: string;
  merkleRoot: string;
  treeSize: number;
  nullifiers: string[];
  submissionCount: number;
}

export interface VoterView {
  voterId?: string;
  commitment: string;
  nullifier: string;
}

const j = async (r: Response) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${r.status}`);
  return data;
};

export const api = {
  status: (): Promise<Status> => fetch("/api/status").then(j),
  config: (): Promise<Config> => fetch("/api/config").then(j),
  results: (): Promise<Results> => fetch("/api/results").then(j),
  chain: (): Promise<ChainState> => fetch("/api/chain").then(j),
  register: (): Promise<VoterView> => fetch("/api/register", { method: "POST" }).then(j),
  submit: (body: {
    voterId: string;
    rating: number;
    choice: number;
    feedback: string;
  }): Promise<{ ok: true; commitment: string; nullifier: string; results: Results }> =>
    fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(j),
};
