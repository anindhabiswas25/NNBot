import { RELEASE_REPOS } from "../sources";
import type { Connector, RawItem } from "../types";
import { getJson, getText, truncate } from "../util";
import { parseFeed } from "./rss";

const ghHeaders = (env: NodeJS.ProcessEnv): Record<string, string> => ({
  accept: "application/vnd.github+json",
  ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
});

/** Releases of top AI repos (Atom feeds, no auth needed). Skips patch releases and pre-releases. */
export const githubReleases: Connector = {
  name: "GitHub releases",
  slots: ["launches"],
  async run({ since }) {
    const out: RawItem[] = [];
    const results = await Promise.allSettled(
      RELEASE_REPOS.map(async (repo) => {
        const entries = parseFeed(await getText(`https://github.com/${repo}/releases.atom`, { timeoutMs: 20_000 }));
        for (const e of entries) {
          if (new Date(e.published) < since) continue;
          const tag = e.link.split("/").pop() ?? e.title;
          // major/minor only: v1.2.0, 0.7, b-numbers for llama.cpp are too frequent → skip
          if (!/^v?\d+\.\d+(\.0)?$/.test(tag)) continue;
          out.push({
            title: `${repo.split("/")[1]} ${tag} released`,
            text: truncate(`${repo} ${tag}: ${e.text}`, 1200),
            url: e.link,
            source: "GitHub",
            published_at: e.published,
            type: "launch",
            trust: 1,
            data: { lab: repo.split("/")[0], version: tag, code_url: `https://github.com/${repo}`, published: e.published },
          });
        }
      }),
    );
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed === RELEASE_REPOS.length) throw new Error("all release feeds failed");
    return out;
  },
};

/** Fast-rising new repos in AI and crypto (GitHub search). */
export const githubTrending: Connector = {
  name: "GitHub trending",
  slots: ["launches"],
  async run({ env }) {
    const since = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const queries = [
      `topic:llm created:>${since} stars:>400`,
      `topic:ai-agents created:>${since} stars:>300`,
      `topic:blockchain created:>${since} stars:>200`,
    ];
    const out: RawItem[] = [];
    for (const q of queries) {
      const r: any = await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=8`, { headers: ghHeaders(env) });
      for (const repo of r.items ?? []) {
        out.push({
          title: `${repo.full_name}: ${truncate(repo.description ?? "new open-source project", 90)}`,
          text: truncate(`${repo.description ?? ""} Topics: ${(repo.topics ?? []).join(", ")}. Language: ${repo.language ?? "n/a"}.`, 800),
          url: repo.html_url,
          source: "GitHub",
          published_at: repo.created_at,
          type: "launch",
          trust: 3,
          data: { stars: repo.stargazers_count, code_url: repo.html_url, license: repo.license?.spdx_id ?? undefined, lab: repo.owner?.login, published: repo.created_at },
        });
      }
    }
    return out;
  },
};
