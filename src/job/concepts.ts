/** Fallback "Concept of the day" when the AI Connector is unavailable. Rotated by day of year. */
export const CONCEPTS: { title: string; body: string }[] = [
  { title: "Restaking", body: "Staked ETH already secures Ethereum. Restaking lets the same stake also secure other services (like oracles or bridges) for extra rewards. The catch: if any of those services misbehaves, the stake can be cut, so risk stacks up along with reward." },
  { title: "Mixture of Experts", body: "Instead of one giant network doing all the work, an MoE model has many smaller expert networks and a router that picks a few per token. You get the knowledge of a huge model while only paying compute for a small part of it on each step." },
  { title: "Rollups", body: "A rollup runs transactions off Ethereum, bundles hundreds of them together, and posts a compact summary back on-chain. Users get cheaper, faster transactions while still inheriting Ethereum's security. Optimistic and ZK rollups differ in how they prove the summary is honest." },
  { title: "RLHF", body: "Reinforcement Learning from Human Feedback: people compare pairs of model answers, a reward model learns their preferences, and the language model is then trained to score highly on that reward. It is a big reason chatbots feel helpful rather than just predictive." },
  { title: "Stablecoins", body: "A stablecoin is a token designed to stay at a fixed value, usually $1. Most are backed by cash and treasury bills held by a company; others use crypto collateral or algorithms. They are the main way money moves around in crypto." },
  { title: "Retrieval-Augmented Generation", body: "RAG lets a model look things up before answering. A search step finds relevant documents, and they are pasted into the prompt so the model can quote real sources. It reduces made-up answers and keeps knowledge fresh without retraining." },
  { title: "Zero-knowledge proofs", body: "A ZK proof lets you prove a statement is true without revealing why. Example: proving you are over 18 without showing your birth date. In crypto, ZK proofs verify big batches of transactions cheaply and privately." },
  { title: "Context window", body: "The context window is how much text a language model can 'see' at once, measured in tokens. Bigger windows let it read whole books or codebases, but cost more compute, and models don't always use far-away text equally well." },
  { title: "Total Value Locked (TVL)", body: "TVL is the dollar value of crypto deposited in a DeFi protocol, such as lending pools or exchanges. It is a rough measure of how much people trust and use a protocol, but it moves with token prices, so read it with care." },
  { title: "Quantization", body: "Quantization stores a model's numbers with fewer bits, e.g. 4 bits instead of 16. The model gets several times smaller and faster, often with only a small accuracy loss, which is how big models run on laptops and phones." },
  { title: "AI agents", body: "An AI agent is a model that works in a loop: it plans, calls tools (search, code, APIs), looks at the results and decides the next step until a goal is met. The hard parts are reliability, safety and knowing when to stop." },
  { title: "Proof of Stake", body: "In Proof of Stake, validators lock up coins as collateral to propose and check blocks. Honest work earns rewards; cheating gets part of the stake destroyed (slashed). It uses far less energy than Bitcoin's Proof of Work mining." },
  { title: "Diffusion models", body: "Diffusion models learn to turn noise into images. During training they see pictures gradually covered in noise and learn to undo it step by step. At generation time they start from pure noise and denoise toward an image matching your prompt." },
  { title: "Oracles", body: "Blockchains can't see the outside world by themselves. Oracles are services that bring off-chain data, like prices or weather, on-chain so smart contracts can use it. If an oracle is wrong or manipulated, the contracts relying on it can break." },
];

export function conceptOfDay(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86_400_000);
  return CONCEPTS[doy % CONCEPTS.length];
}
