import { z } from "zod";
import type { Category } from "./categories";

/** Which way money moves in a message: its own axis, beside importance (spec 7). */
export const FINANCE_VALUES = ["none", "income", "expense"] as const;
export type Finance = (typeof FINANCE_VALUES)[number];

export const SortResultSchema = z.object({
  important: z.boolean(),
  needs_reply: z.boolean(),
  scheduling: z.boolean(),
  /** One of the operator's sub-categories, or "Other" (spec 7). */
  category: z.string(),
  finance: z.enum(FINANCE_VALUES),
  /**
   * Mail nobody will need again once it has been read, so it is safe to put
   * in the Trash (spec 7, 2026-09-11). Judged for every message, like
   * finance: a marketing blast is disposable whether or not it was worth
   * surfacing, and a contract never is.
   */
  disposable: z.boolean(),
  /** One of the inbox's projects, or "None" (spec 10d). */
  project: z.string(),
  reason: z.string(),
});
export type SortResult = z.infer<typeof SortResultSchema>;

export interface SortInput {
  /**
   * The stored message's id and inbox, when the caller has them. Only the
   * example lookup needs them — it excludes the message being judged and
   * stays inside its own inbox (spec 7a) — so a caller with nothing but the
   * mail in hand can still sort.
   */
  id?: string;
  accountId?: string;
  fromAddress: string;
  fromName: string | null;
  subject: string;
  bodyText: string;
  attachmentNames: string[];
  sentAt: number;
}

/** What the sorter is told about one project: the words the operator wrote. */
export interface SortProject {
  name: string;
  description: string;
}

/** What the sorter answers when a message belongs to no project (spec 10d). */
export const NO_PROJECT = "None";

/** Tool-less. Reads untrusted text, returns a verdict, can act on nothing. */
export interface Sorter {
  readonly model: string;
  sort(criteria: string, categories: Category[], projects: SortProject[], input: SortInput): Promise<SortResult>;
}
