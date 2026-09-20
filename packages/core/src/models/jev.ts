import type { Category } from "../sort/categories";
import { NO_PROJECT, type Sorter, type SortInput, type SortProject, type SortResult } from "../sort/types";
import { WANTS, type Wants } from "../db/schema";
import { isBroadcast } from "../sort/broadcast";

/**
 * The sorter on TypeSafe's Jev (operator, 2026-09-19: "resort and use jev").
 *
 * Jev is a System One model: it does not write text, it answers typed
 * questions about a state and hands back a value with a probability for every
 * option. That is the whole of what the sorter needs — a rung, a flag, a
 * category, a money direction and a project — and none of it is prose, so
 * nothing has to be coaxed into JSON or retried when it comes back malformed.
 *
 * What it cannot do is explain itself, and `reason` is a sentence the
 * operator reads. So the reason is built from the answer instead: the rung
 * it chose, how sure it was, and what it nearly said instead. That is worse
 * than an explanation for understanding a verdict and better for deciding
 * whether to trust one, which is the trade this model makes everywhere.
 */
const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const BODY_LIMIT = 4000;

interface Answer {
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface JevResponse {
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** An address as its bare form, so `Name <a@b>` and `a@b` compare equal. */
function bare(address: string): string {
  return (address.match(/<([^>]+)>/)?.[1] ?? address).trim().toLowerCase();
}

/**
 * The message as named fields rather than one blob. Jev reads state by path,
 * and the envelope is the part the old sorter could not see: a broadcast to a
 * list nobody addressed the operator on is not a personal request, which was
 * a whole class of wrong verdict (2026-09-18).
 */
export function jevState(input: SortInput): Record<string, unknown> {
  const to = input.toAddresses ?? [];
  const cc = input.ccAddresses ?? [];
  const me = input.operatorAddress ? bare(input.operatorAddress) : null;
  return {
    from: input.fromName ? `${input.fromName} <${input.fromAddress}>` : input.fromAddress,
    to,
    cc,
    addressed_to_operator: me === null ? null : [...to, ...cc].map(bare).includes(me),
    subject: input.subject,
    sent_at: new Date(input.sentAt).toISOString(),
    attachments: input.attachmentNames,
    body: input.bodyText.length > BODY_LIMIT ? `${input.bodyText.slice(0, BODY_LIMIT)}\n[truncated]` : input.bodyText,
  };
}

/**
 * The questions, one per field the sorter stores. They are asked together
 * over one state and answered in parallel, so the whole verdict is a single
 * call. The ladder is a Choice rather than a Score: its rungs are ordered by
 * precedence, not by degree, and an answer that landed between two of them
 * would mean nothing.
 */
export function jevQuestions(criteria: string, categories: Category[], projects: SortProject[]): Record<string, unknown> {
  const categoryCriteria: Record<string, string | null> = {};
  for (const c of categories) categoryCriteria[c.name] = c.description || null;
  categoryCriteria.Other = "Worth surfacing, but none of the categories above.";

  const projectCriteria: Record<string, string | null> = {};
  for (const p of projects) projectCriteria[p.name] = p.description || null;
  projectCriteria[NO_PROJECT] = "It belongs to none of the projects above.";

  return {
    wants: {
      type: "choice",
      instructions: {
        question: "What is the ONE thing this message wants from the operator? If an earlier option fits, choose it, whatever else is also true.",
        the_operators_own_criteria: criteria,
      },
      criteria: {
        reply:
          "A real person is waiting for the operator's answer to something they asked. Automated mail never belongs here: calendar invitations and RSVPs, document-share and access notices, system and account notices, platform connection requests, marketing and vendor outreach asking for a meeting. A message sent to a mailing list the operator is not addressed on is not waiting on them personally.",
        action: "There is something for the operator to do and no reply is expected: pay, sign, submit, renew, review, book, or decide by a date.",
        knowing: "Worth knowing about, with nothing to do and nobody waiting.",
        bin: "Nobody will need this again once it has been read: marketing, newsletters and digests, one-time codes, sign-in and verification notices, shipping notifications, automated receipts that are not invoices to pay, social and platform notifications. Never this for anything a person wrote, anything with money to pay or a document to keep, or anything worth searching for later.",
      },
    },
    scheduling: {
      type: "noul",
      instructions: "Does this message propose, ask for, or change a meeting time? This is a fact about the message, true at any rung.",
    },
    category: { type: "choice", instructions: "Which of the operator's own categories does this message belong to?", criteria: categoryCriteria },
    finance: {
      type: "choice",
      instructions: "Which way does money move in this message? Answer for every message, at every rung.",
      criteria: {
        none: "No money moves.",
        income: "Money coming to the operator: a payment received, a payout, an invoice they issued being paid.",
        expense: "Money leaving: a bill, an invoice to pay, a receipt for a purchase, a subscription charge.",
      },
    },
    project: { type: "choice", instructions: "Which of the operator's projects does this message belong to, judged on who it is from and what it is about?", criteria: projectCriteria },
  };
}

/** A rung the model named, or the safest reading of one it did not. */
function rungOf(a: Answer | undefined): Wants {
  const said = a?.choice;
  return (WANTS as readonly string[]).includes(said ?? "") ? (said as Wants) : "knowing";
}

/**
 * The reason, built rather than written. It says what was chosen, how sure
 * the model was, and what it nearly chose instead, because a verdict at 0.51
 * against 0.49 and one at 0.99 are different facts and the operator should
 * be able to see which they are looking at.
 */
export function jevReason(a: Answer | undefined, wants: Wants): string {
  const probabilities = a?.probabilities ?? {};
  const ranked = Object.entries(probabilities).sort((x, y) => y[1] - x[1]);
  const mine = probabilities[wants];
  const runnerUp = ranked.find(([k]) => k !== wants);
  const sure = typeof mine === "number" ? ` at ${mine.toFixed(2)}` : "";
  const nearly = runnerUp ? `, then ${runnerUp[0]} at ${runnerUp[1].toFixed(2)}` : "";
  return `Jev read this as ${wants}${sure}${nearly}.`;
}

export interface JevOptions {
  apiKey: string;
  /** Swapped in tests; the real one is global fetch. */
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

export function createJevSorter(opts: JevOptions): Sorter {
  const call = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? ENDPOINT;
  return {
    model: `typesafe:${MODEL}`,
    async sort(criteria, categories, projects, input): Promise<SortResult> {
      const res = await call(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, state: jevState(input), questions: jevQuestions(criteria, categories, projects) }),
      });
      if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const { answers } = (await res.json()) as JevResponse;

      const wants = rungOf(answers.wants);
      // The one correction that is a fact about the envelope rather than a
      // matter of opinion, kept whichever model is answering (2026-09-18).
      const settled: Wants = wants === "reply" && isBroadcast(input) ? "knowing" : wants;
      const known = new Set(projects.map((p) => p.name));
      const project = answers.project?.choice;
      return {
        wants: settled,
        scheduling: (answers.scheduling?.noul ?? 0) >= 0.5,
        category: answers.category?.choice ?? "Other",
        finance: answers.finance?.choice === "income" || answers.finance?.choice === "expense" ? answers.finance.choice : "none",
        project: project && known.has(project) ? project : NO_PROJECT,
        reason:
          settled === wants
            ? jevReason(answers.wants, wants)
            : `${jevReason(answers.wants, wants)} Brought down a rung: sent to a list the operator is not addressed on.`,
      };
    },
  };
}
