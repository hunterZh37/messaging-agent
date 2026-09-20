import { z } from "zod";
import type { Category } from "./categories";
import { WANTS } from "../db/schema";

/** Which way money moves in a message: its own axis, beside importance (spec 7). */
export const FINANCE_VALUES = ["none", "income", "expense"] as const;
export type Finance = (typeof FINANCE_VALUES)[number];

export const SortResultSchema = z.object({
  /**
   * The one thing this message wants from the operator (operator,
   * 2026-09-19), in the ladder's own order. It replaced `important`,
   * `needs_reply` and `disposable`, three booleans a model could set in
   * combinations that contradicted each other.
   */
  wants: z.enum(WANTS),
  /** A fact about the message: it proposes, asks for or changes a time. */
  scheduling: z.boolean(),
  /** One of the operator's sub-categories, or "Other" (spec 7). */
  category: z.string(),
  finance: z.enum(FINANCE_VALUES),
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
  /**
   * Who the mail was actually sent to (operator, 2026-09-18). Left out until
   * a mailing-list announcement reached Need to reply: the model was shown
   * From, Subject and the body, so "the only recipient is the list, and you
   * are not on it" was a fact nobody could see. Optional, because a caller
   * holding nothing but a body can still sort.
   */
  toAddresses?: string[];
  ccAddresses?: string[];
  /** This inbox's own address, which is what makes "addressed to me" answerable. */
  operatorAddress?: string | null;
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
