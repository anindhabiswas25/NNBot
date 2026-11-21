import { XMLParser } from "fast-xml-parser";
import type { Feed } from "../sources";
import type { Connector, RawItem, SlotKey } from "../types";
import { getText, stripHtml, truncate } from "../util";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text", trimValues: true, processEntities: false });

const decode = (s: string) =>
  s.replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const arr = <T,>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = (x: any): string => decode(x == null ? "" : typeof x === "object" ? String(x["#text"] ?? "") : String(x));

export interface FeedEntry {
  title: string;
  link: string;
  text: string;
  published: string;
  author?: string;
  categories: string[];
}

/** Parse RSS 2.0, RSS 1.0/RDF or Atom into flat entries. */
export function parseFeed(xml: string): FeedEntry[] {
  const doc = parser.parse(xml);
  const rssItems = arr(doc?.rss?.channel?.item ?? doc?.["rdf:RDF"]?.item);
  if (rssItems.length) {
    return rssItems.map((it: any) => ({
      title: stripHtml(txt(it.title)),
      link: txt(it.link) || txt(it.guid),
      text: stripHtml(txt(it.description) || txt(it["content:encoded"])),
      published: new Date(txt(it.pubDate) || txt(it["dc:date"]) || Date.now()).toISOString(),
      author: stripHtml(txt(it["dc:creator"]) || txt(it.author)),
      categories: arr(it.category).map(txt),
    }));
  }
  return arr(doc?.feed?.entry).map((e: any) => {
    const links = arr(e.link);
    const alt = links.find((l: any) => !l["@_rel"] || l["@_rel"] === "alternate") ?? links[0];
    return {
      title: stripHtml(txt(e.title)),
      link: alt?.["@_href"] ? decode(alt["@_href"]) : txt(alt),
      text: stripHtml(txt(e.summary) || txt(e.content)),
      published: new Date(txt(e.published) || txt(e.updated) || Date.now()).toISOString(),
      author: arr(e.author).map((a: any) => txt(a.name)).join(", "),
      categories: arr(e.category).map((c: any) => c?.["@_term"] ?? txt(c)),
    };
  });
}

/** One connector per feed so each counts (and fails) independently. */
export function feedConnector(feed: Feed, slot: SlotKey, type: RawItem["type"]): Connector {
  return {
    name: feed.name,
    slots: [slot],
    async run({ since }) {
      const xml = await getText(feed.url, { timeoutMs: 20_000 });
      return parseFeed(xml)
        .filter((e) => e.title && e.link && new Date(e.published) >= since)
        .slice(0, 40)
        .map((e) => ({
          title: e.title,
          text: truncate(e.text, 1500),
          url: e.link,
          source: feed.name,
          published_at: e.published,
          type,
          trust: feed.trust,
          data: { lab: type === "launch" && feed.trust === 1 ? feed.name : undefined, curated: type === "paper" || undefined, published: e.published },
        }));
    },
  };
}
