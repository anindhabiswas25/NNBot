import type { Connector, RawItem } from "../types";
import { getJson, truncate } from "../util";

/** Hugging Face Daily Papers — community upvotes and code links (replaces Papers with Code). */
export const hfPapers: Connector = {
  name: "HF Daily Papers",
  slots: ["research"],
  async run({ since }) {
    const rows: any[] = await getJson("https://huggingface.co/api/daily_papers?limit=100");
    // Filter on when HF *featured* the paper, not the paper's own arXiv date (r.publishedAt), which is
    // usually 2–5 days older. Dates are midnight UTC and there's no list on weekends, so look back 3 whole
    // days (Monday reaches Friday's list); the 7-day sent-URL dedupe drops anything already sent.
    const cutoff = new Date(since.getTime() - 72 * 3_600_000);
    cutoff.setUTCHours(0, 0, 0, 0);
    return rows
      .filter((r) => new Date(r.paper?.submittedOnDailyAt ?? r.publishedAt ?? 0) >= cutoff)
      .map((r): RawItem => {
        const p = r.paper;
        const authors = (p.authors ?? []).map((a: any) => a.name).filter(Boolean);
        return {
          title: p.title,
          text: truncate(p.ai_summary ? `${p.ai_summary} ${p.summary}` : p.summary ?? "", 1500),
          url: `https://arxiv.org/abs/${p.id}`,
          extra_urls: [`https://huggingface.co/papers/${p.id}`],
          source: "HF Daily Papers",
          published_at: p.publishedAt ?? r.publishedAt,
          type: "paper",
          trust: 1,
          ids: { arxiv: p.id },
          data: {
            authors: authors.length > 1 ? `${authors[0]} et al.` : authors[0],
            hf_upvotes: p.upvotes,
            code_url: p.githubRepo || undefined,
            stars: p.githubStars || undefined,
            paper_url: `https://arxiv.org/abs/${p.id}`,
            pdf_url: `https://arxiv.org/pdf/${p.id}`,
            lab: r.organization?.fullname,
            published: p.publishedAt,
          },
        };
      });
  },
};

/** Quantised / converted re-uploads of someone else's model are not launches. */
const REUPLOAD = /gguf|awq|gptq|mlx|bnb|exl2|[-_](4|8)bit|[-_](nv|mx)?fp[48]|[-_]int[48]|[-_]q[2-8]_/i;

function fmtParams(n?: number): string | undefined {
  if (!n) return undefined;
  if (n >= 1e9) return `${+(n / 1e9).toFixed(1)}B params`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M params`;
  return undefined;
}

/** New and trending models on the Hub (created in the last 14 days). */
export const hfModels: Connector = {
  name: "HF Hub models",
  slots: ["launches"],
  async run() {
    const expand = ["createdAt", "likes", "downloads", "cardData", "safetensors", "pipeline_tag", "trendingScore", "author"].map((e) => `expand[]=${e}`).join("&");
    const rows: any[] = await getJson(`https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=60&${expand}`);
    const cutoff = Date.now() - 14 * 86_400_000;
    return rows
      .filter((m) => new Date(m.createdAt).getTime() >= cutoff && (m.likes ?? 0) >= 50 && !REUPLOAD.test(m.id))
      .slice(0, 25)
      .map((m): RawItem => {
        const [org, name] = String(m.id).split("/");
        const tags: string[] = m.cardData?.tags ?? [];
        return {
          title: `${org} releases ${name} on Hugging Face`,
          text: `${m.id} is a new ${m.pipeline_tag ?? "model"} model${m.cardData?.base_model ? ` based on ${m.cardData.base_model}` : ""}. Tags: ${tags.slice(0, 8).join(", ")}. ${m.likes} likes and ${m.downloads} downloads so far.`,
          url: `https://huggingface.co/${m.id}`,
          source: "Hugging Face Hub",
          published_at: m.createdAt,
          type: "launch",
          trust: 1,
          ids: { hf_model: m.id },
          data: {
            lab: org,
            license: m.cardData?.license,
            model_size: fmtParams(m.safetensors?.total),
            downloads: m.downloads,
            likes: m.likes,
            category: m.pipeline_tag,
            published: m.createdAt,
          },
        };
      });
  },
};
