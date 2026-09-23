# Compose: a message that starts a conversation

Date: 2026-09-22
Status: approved by operator (email first; chats staged after)
Depends on: `docs/superpowers/specs/2026-09-06-messaging-agent-design.md`

## 1. What this is

Celeste can answer, but it cannot begin. Every draft is a reply: `drafts.thread_id`
and `drafts.reply_to_message_id` are NOT NULL foreign keys, `Sender` has only
`sendReply`, and Ask Celeste refuses a request with no thread to anchor to — which
is exactly what the operator hit on 2026-09-22, asking it to write to two people it
had no thread with.

Compose adds: a button at the top of the sidebar, a composer that writes a new email
by hand or through Celeste, and a draft that lands in the existing queue and goes out
through the existing gate.

## 2. Decisions

| Question | Decision |
|---|---|
| Channels in this change | **Email only.** iMessage and WhatsApp come after, each on its own |
| Why | WhatsApp's open-chat script falls back to typing a name into Search and taking the top hit, which can land a message in the wrong chat; and the operator's standing rule forbids driving Messages or WhatsApp to test |
| Draft storage | `thread_id` and `reply_to_message_id` become nullable; `account_id` and `subject` are added; `mode` gains `"new"` |
| Why not a placeholder thread | An invented thread and message would leak into thread lists, search, stats and the sorter unless every query excluded them. A composed draft genuinely has no thread |
| Send path | A second method, `Sender.sendNew`, beside `sendReply`. Mail only for now; the chat senders throw until their own change |
| Preview and gate | The existing Drafts queue: confirm dialog, then the 6-second cancel in `SendProvider` |
| Guard | The confirm dialog says when this is the first message ever sent to an address, and shows every recipient in full |
| Local echo | None for a composed message: `storeSentReply` needs a provider thread id that does not exist yet. The sent mail appears at the next sync |

## 3. The shape of it

**Core**
- `drafts` migration, with `account_id` backfilled from each draft's reply-to message.
- `DraftView.replyTo` becomes `MessageRow | null`; `account` comes from the draft's own
  `account_id` when there is no reply-to; `subject` is the draft's own for a composed one.
- `composeDraft(db, {accountId, to, cc, subject, text, model})` writes the row.
- `sendDraft` branches: with no thread, it calls `sender.sendNew` and skips the
  reply-only fields.
- `firstContact(db, accountId, addresses)` answers whether any message was ever
  exchanged with each address, for the warning.

**Senders**
- `imapSender.sendNew`: the SMTP call it already makes, without `inReplyTo`/`references`.
- `outlookSender.sendNew`: one new client call, `POST /me/messages`, then the existing
  update, attach and send.
- `imessage` and `whatsapp`: throw `compose is not supported for this channel yet`.

**Web**
- A Compose button above the folder tree, and a composer with To, Cc, Subject, a body
  that takes the same marks as a reply, and **Draft with Celeste** from one line of
  instruction.
- `DraftCard` and `DraftList` stop assuming `replyTo`: a composed card shows its own
  subject and recipients, and no thread above the box.
- `SendPreviewDialog` shows the subject and the first-contact warning.
- Ask Celeste gains a `compose` action, exempt from the thread-id requirement, so
  "write to X about Y" produces a draft instead of a refusal.

## 4. Known limits (accepted)

- A composed message does not appear in the app until the next sync brings the
  provider's own copy back.
- No contact picker: recipients are typed, as they are on a reply today. The address
  book only knows iMessage handles, and only forward (handle → name).
- The first-contact warning is a warning, not a block.
- iMessage and WhatsApp compose remain unbuilt, and the operator tests them by hand
  when they land.

## 5. Testing

- Unit: the migration's backfill, `composeDraft`, `sendDraft`'s new branch, `firstContact`,
  `imapSender.sendNew` against the fake SMTP client, `outlookSender.sendNew` against the
  fake Graph client, and the Ask Celeste `compose` proposal.
- The queue's existing tests must keep passing untouched: a reply is unchanged.
- End to end: one real email composed in the app and sent to the operator's own address,
  with their confirmation at the moment of sending. No other recipient is ever used.
