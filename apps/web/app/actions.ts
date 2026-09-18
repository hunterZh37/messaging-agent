"use server";

import {
  connectorForAccount,
  createDrafter,
  getDraftView,
  listDraftAttachments,
  loadPipelineInputs,
  recordDraftRevision,
  reviseDraft,
  sendDraft,
  skipDraft,
  storeSentReply,
  schema,
  restoreDraft,
  type DraftView,
} from "@messaging-agent/core";
import { eq } from "drizzle-orm";
import { core } from "@/lib/core";

type Result = { ok: true } | { ok: false; error: string };

export async function sendAction(input: { draftId: string; finalText: string; to: string[]; cc: string[] }): Promise<Result> {
  const { cfg, db } = core();
  const v = getDraftView(db, input.draftId);
  if (!v) return { ok: false, error: "Draft not found" };
  try {
    const sent = await sendDraft(db, connectorForAccount(cfg, db, v.account).sender, input);
    // In the thread now, not after the next sync of Sent (2026-09-15). The
    // send has already gone: a copy that will not store is logged, never
    // reported as a failed send.
    try {
      const thread = db.select({ providerThreadId: schema.threads.providerThreadId }).from(schema.threads).where(eq(schema.threads.id, v.draft.threadId)).get();
      if (thread) await storeSentReply(db, cfg, {
        account: v.account,
        providerThreadId: thread.providerThreadId,
        draftId: v.draft.id,
        subject: v.replySubject,
        to: input.to,
        cc: input.cc,
        text: input.finalText,
        attachmentNames: v.attachments.map((a) => a.filename),
        rfcMessageId: v.account.provider === "imap" && sent.providerMessageId.startsWith("<") ? sent.providerMessageId : null,
        sentAt: Date.now(),
      });
    } catch (err) {
      console.error(`sendAction: the sent reply will show after the next sync: ${(err as Error).message}`);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Undo for a deleted draft (2026-09-14): the card comes back as it was. */
export async function restoreDraftAction(draftId: string): Promise<{ ok: true; view: DraftView } | { ok: false; error: string }> {
  try {
    return { ok: true, view: restoreDraft(core().db, draftId) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function skipAction(draftId: string): Promise<Result> {
  try {
    skipDraft(core().db, draftId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * A rewrite of the open draft, asked for in the Ask panel (spec 8, 2026-09-10;
 * the card's own field went on 2026-09-14): the operator's
 * instruction and the text on the card go to the drafter, and the whole
 * rewritten body comes back. Nothing is saved to the draft and nothing is
 * sent: the card shows the result with an Undo, and the operator decides.
 */
export async function reviseAction(input: { draftId: string; current: string; instruction: string }): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const { cfg, db } = core();
    const { voice } = await loadPipelineInputs(cfg);
    const { text } = await reviseDraft(db, createDrafter(cfg, db, { ref: input.draftId }), voice, input.draftId, input.current, input.instruction);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * "Apply to draft" in the Ask panel, clicked (spec 10c, 2026-09-10). The
 * text came back with Celeste's answer, so there is no model to call here:
 * this only writes down what the card has just taken, under the question
 * that produced it, so `draft_revisions` reads the same whether the
 * operator typed into the card's field or asked in the panel.
 */
export async function recordAppliedRevisionAction(input: {
  draftId: string;
  before: string;
  after: string;
  question: string;
  model?: string | null;
}): Promise<Result> {
  try {
    recordDraftRevision(core().db, {
      draftId: input.draftId,
      instruction: `from Ask Celeste: ${input.question.trim()}`,
      before: input.before,
      after: input.after,
      model: input.model?.trim() || "ask-celeste",
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * The files on a draft, for a card that has to paint its chip row again: the
 * Ask panel can put a file the operator gave Celeste onto the open draft, and
 * the card that owns the chips did not do it (spec 10c, 2026-09-10). Only
 * what a chip shows, as everywhere else.
 */
export async function listDraftAttachmentsAction(draftId: string): Promise<{ id: string; filename: string; mimeType: string; size: number }[]> {
  return listDraftAttachments(core().db, draftId).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size }));
}
