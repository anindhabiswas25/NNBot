import { ARXIV_CATEGORIES } from "../sources";
import type { Connector, RawItem } from "../types";
import { getText, log, sleep, stripHtml, truncate } from "../util";
import { parseFeed } from "./rss";

const idOf = (url: string) => url.match(/(\d{4}\.\d{4,5})/)?.[1];

/** First GitHub/GitLab repo link (owner/repo) in an abstract, e.g. "Code: https://github.com/a/b." */
export function codeUrlFrom(text: string): string | undefined {
  const m = text.match(/(?:https?:\/\/)?(?:www\.)?(github\.com|gitlab\.com)\/([\w.-]+)\/([\w.-]+)/i);
  if (!m) return undefined;
  const repo = m[3].replace(/\.git$/i, "").replace(/[.-]+$/, "");
  return repo ? `https://${m[1].toLowerCase()}/${m[2]}/${repo}` : undefined;
}

const RSS_URL = `https://rss.arxiv.org/rss/${ARXIV_CATEGORIES.join("+")}`;

async function rssEntries() {
  const rss = parseFeed(await getText(RSS_URL, { timeoutMs: 45_000, retries: 2 }));
  return rss
    .filter((e) => !/Announce Type:\s*(replace|replace-cross)/i.test(e.text))
    .map((e) => ({ ...e, text: e.text.replace(/^.*?Abstract:\s*/i, "") }));
}

/**
 * New arXiv papers. Uses the daily RSS announcement (fast, complete). The RSS is empty on weekends,
 * and briefly around the ~01:00 UTC announcement, so it falls back to the API sorted by submission
 * date (retrying rate limits), and if that fails too, gives the RSS one more try.
 */
export const arxiv: Connector = {
  name: "arXiv",
  slots: ["research"],
  async run({ since }) {
    let entries = await rssEntries();

    if (!entries.length) {
      const q = ARXIV_CATEGORIES.map((c) => `cat:${c}`).join("+OR+");
      try {
        const xml = await getText(`https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=300`, { timeoutMs: 60_000, retries: 3 });
        entries = parseFeed(xml).filter((e) => new Date(e.published) >= new Date(since.getTime() - 48 * 3_600_000));
      } catch (e) {
        log(`  arXiv API failed (${(e as Error).message.slice(0, 80)}); trying the RSS again in 60 s`);
        await sleep(60_000);
        entries = await rssEntries();
        if (!entries.length) throw e;
      }
    }

    const out: RawItem[] = [];
    for (const e of entries) {
      const id = idOf(e.link);
      if (!id) continue;
      const abstract = stripHtml(e.text);
      const authors = (e.author ?? "").split(/,\s*/).filter(Boolean);
      out.push({
        title: e.title.replace(/\s+/g, " "),
        text: truncate(abstract, 1500),
        url: `https://arxiv.org/abs/${id}`,
        source: "arXiv",
        published_at: e.published,
        type: "paper",
        trust: 1,
        ids: { arxiv: id },
        data: {
          authors: authors.length > 1 ? `${authors[0]} et al.` : authors[0],
          category: e.categories[0],
          paper_url: `https://arxiv.org/abs/${id}`,
          pdf_url: `https://arxiv.org/pdf/${id}`,
          code_url: codeUrlFrom(abstract),
          published: e.published,
        },
      });
    }
    return out;
  },
};
