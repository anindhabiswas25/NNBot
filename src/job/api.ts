import type { NewPoolItem, PoolItem, SlotMeta, UserPrefs } from "../shared/types";
import { sleep } from "./util";

/** Client for the Worker's authenticated /internal endpoints. */
export class Api {
  constructor(private base: string, private key: string) {}

  private async req<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${this.base.replace(/\/$/, "")}/internal${path}`, {
          method,
          headers: { "content-type": "application/json", "x-internal-key": this.key },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok && !allow.includes(res.status)) throw new Error(`internal ${method} ${path}: ${res.status} ${await res.text()}`);
        return (await res.json()) as T;
      } catch (e) {
        if (attempt >= 2) throw e;
        await sleep(1500 * (attempt + 1));
      }
    }
  }

  state = () => this.req<Record<string, string>>("GET", "/state");
  putState = (s: Record<string, string>) => this.req("PUT", "/state", s);
  sentUrls = () => this.req<string[]>("GET", "/sent-urls");
  addSentUrls = (hashes: string[]) => this.req("POST", "/sent-urls", { hashes });
  getPool = (date: string, slot: number) => this.req<{ items: PoolItem[]; meta: SlotMeta | null }>("GET", `/pool?date=${date}&slot=${slot}`);
  putPool = (slot_date: string, slot: number, items: NewPoolItem[], meta?: SlotMeta) =>
    this.req<{ item_ids?: number[]; error?: string }>("POST", "/pool", { slot_date, slot, items, meta }, [409]);
  putMeta = (slot_date: string, slot: number, meta: SlotMeta) => this.req("PUT", "/slot-meta", { slot_date, slot, meta });
  dayItems = (date: string) => this.req<PoolItem[]>("GET", `/day-items?date=${date}`);
  recipients = (date: string, slot: number, after: number) =>
    this.req<{ users: UserPrefs[]; next: number | null }>("GET", `/recipients?date=${date}&slot=${slot}&after=${after}`);
  deliveries = (rows: { tg_user_id: number; slot_date: string; slot: number; message_id: number; item_ids: number[] }[]) => this.req("POST", "/deliveries", { deliveries: rows });
  blocked = (ids: number[]) => this.req("POST", "/blocked", { ids });
  staleOnboarding = () => this.req<{ tg_user_id: number; first_name: string }[]>("GET", "/stale-onboarding");
  reminded = (ids: number[]) => this.req("POST", "/reminded", { ids });
  weekly = (after: number) => this.req<{ users: { tg_user_id: number; opened: Record<string, number> }[]; next: number | null }>("GET", `/weekly?after=${after}`);
  feedbackUnsorted = () => this.req<{ id: number; text: string }[]>("GET", "/feedback-unsorted");
  feedbackSorted = (rows: { id: number; category: string }[]) => this.req("POST", "/feedback-sorted", { rows });
  housekeeping = (decay: boolean) => this.req("POST", "/housekeeping", { decay });
}
