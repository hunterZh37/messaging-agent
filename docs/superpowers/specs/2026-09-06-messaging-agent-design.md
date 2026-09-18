# Celeste: Design Spec

Date: 2026-09-06
Status: confirmed by operator after grilling session
Repo: the messaging-agent repository

## 1. What this is

Celeste is the product name. The repo stays `messaging-agent`.

One agent that reads the operator's mail and texts, sorts each message as
important or non-important, and drafts replies the operator approves.
Nothing sends without a person pressing a button.

It is also the operator's one place for all messages: a unified inbox across
every channel and account, with an intelligence layer on top (digest,
follow-up tracking, thread summaries, ask-your-inbox). Usable from a phone.

One agent. No org chart, no hierarchy, no roles, no routing law, no spawning,
no agent-to-agent messages. The predecessor (`~/Desktop/Agentic_OS`, GitHub
an earlier agent project) had all of that. It is reference material only.
This repo starts empty.

## 2. Operator and horizon

- **v1 operator**: one person, alone, on their own Mac, with their own accounts.
- **Later**: a product where other people connect their inboxes.
- **The one rule honored now for that future**: the core library
  (sync, sort, draft, send) has no Next.js and no CLI imports. The CLI and
  the web queue are thin shells over it.
- **Deliberately not done now**: no `owner_id` on tables, no shared
  connector interface, no Vercel deployability constraint. These are
  migrations for later, not scaffolding for now.

## 3. Channels

| Channel  | Read                                   | Label                  | Send                                          |
|----------|----------------------------------------|------------------------|-----------------------------------------------|
| Gmail, Workspace, any IMAP inbox | IMAP with an app password, incremental UID sync of Inbox and Sent | Gmail label `agent/*` via the IMAP label extension; IMAP keywords elsewhere | SMTP reply in-thread (In-Reply-To, References) |
| Outlook  | Microsoft Graph                        | Graph category `agent/*` | Graph reply in-thread                       |
| iMessage | `~/Library/Messages/chat.db` read-only | none                   | AppleScript to Messages.app, verified by polling chat.db |
| WhatsApp | local WhatsApp SQLite store read-only  | none                   | URL scheme, no delivery verification          |

- Multiple accounts of every channel. `accounts` table and account picker
  in the queue from day one.
- iMessage group chats included.
- Mac permissions needed before first run: Full Disk Access (chat.db,
  WhatsApp store) and Automation for Messages.app.

## 4. Side-effect line

Without the button the agent may:

- Apply its own namespaced labels or categories (`agent/important`,
  `agent/needs-reply`). Reversible.

Without the button the agent never:

- Sends, archives, deletes, trashes, marks read, mutes, moves to spam,
  creates or changes anything in Alex, or writes to the Obsidian vault.

Behind a button the agent may send (section 10), trash (section 10b), and
hand actionables to Alex (section 10e).
Nothing is ever permanently deleted: every trash path lands in a store the
provider holds for about 30 days.

## 5. Runtime shape

Always-on daemon on the Mac, launched by launchd, reachable from the
operator's phone over Tailscale.

The daemon loop:

1. Poll every mail account every 2 minutes (Gmail `history.list`, Graph
   `/messages/delta`). Watch `chat.db` and the WhatsApp store for changes.
2. Apply blocklist at fetch.
3. Sort each new message as it arrives.
4. For important messages, download attachments, extract text, and embed
   (section 11a).
5. Draft as soon as a message is important and needs a reply, so replies are
   waiting when the operator opens the app.
6. Serve the PWA, bound to the Tailscale interface only.
7. Generate the daily digest once each morning.

No webhooks in v1. Polling is enough.

### Backfill and retention

- First run: last 7 days per account, full bodies, stored forever. Nothing
  is pruned.
- Then watermark by provider message ID and process only new arrivals.
- **Window (2026-09-07)**: the inbox has a window chip row, Today · 7 days ·
  30 days · All, that filters the view. Choosing a window wider than what
  is synced for an account backfills that account to the window (All = the
  whole mailbox) automatically, with progress shown in place; each account
  remembers how far back it has been synced. The sorter runs automatically
  only on messages from the last 30 days; older backfilled mail is stored
  unsorted and shows under All without an importance verdict, with a
  "Sort older mail" control that runs the sorter over it on demand (each
  message is one model call, so this is the operator's choice).
  Since 2026-09-15 every open of Celeste starts on Today: a window picked
  holds while moving between folders and threads, and is forgotten when the
  app or browser is closed. On a phone the eye (Hide) sits left of the bin
  (Delete) on each row instead of on top of it.
  Opening Celeste lands on Need to reply; when that is empty, Unopened; when
  both are empty, the Inbox, counted over what the tree shows on that open.
  An open is the first page of a tab (session storage, so a new tab or the
  home-screen app launched afresh) that comes in by `/`, `/inbox` or the app's
  start address; a reload, a thread link, any other folder, and every click
  inside the app go where they point. A session cookie was tried first and
  failed: Chrome and the phone keep those long after the app is closed.
  A long thread offers a floating "Scroll to bottom" while its end is below
  the screen (2026-09-15). A mail reply appears in its thread the moment the
  provider accepts it: the send stores the reply itself, and the next sync
  of Sent takes that row over (same Message-ID, or for Outlook the operator's
  message in the thread, within 30 minutes, starting with the typed text)
  rather than adding a second copy. Switching Mail and Messages keeps the
  list the operator is on when the other side has it. The "No need to
  reply" list is removed from the Mail tree (2026-09-15); an old link to it
  opens the plain Inbox. On a phone the project choice is one button naming
  what is on, which opens a sheet from the bottom listing every inbox with its
  projects, full names and counts, and an edit link per inbox; desktop keeps
  the strip and pills (2026-09-15). Every row of Deleted items carries a
  Restore that puts mail back in its inbox and a chat back in Messages, the
  same restore as the thread page's "Restore to inbox" (formerly "Put back").
- **Project groups (2026-09-15)**: an inbox's projects can sit in groups
  (table `project_groups`, `projects.group_id`). A group files nothing and
  costs no re-sort: picking it (`?project=group:<id>`) lists every project
  in it, and its count is the sum of theirs. The bar shows each group as one
  tab ahead of the projects in no group; while a group or one of its
  projects is on, a row beneath lists "All <group>" and its projects, on
  desktop and phone. The phone's sheet lists each group with its projects
  under it. Groups are made, renamed, removed and filled in the projects
  editor, in the same Save as the projects. Project and group counts follow
  the window (operator, 2026-09-15: the bar said 12 over an empty Today
  list); which tabs show is still decided over all time, so a quiet window
  shows them at 0, dimmed, rather than emptying the bar. The Showing row that repeated the filters was removed (2026-09-15): the
  header's chips say what is on and change it. The header's filters are dropdown chips (operator, 2026-09-15: "I
  like top header to feel more like a filter"): PERIOD and PROJECT, each
  saying what is on and opening its choices beneath it — a panel on desktop,
  the sheet on a phone. The project tab strip and the inbox pills are gone
  with them; a group's projects still open in a row under the header. The
  inbox switcher leads those chips as INBOX (2026-09-15) and is gone from the
  sidebar; the Drafts header carries it too. The header holds still (operator,
  2026-09-15: "the position of the labels are too jumpy"): each chip keeps a
  fixed width and cuts a long value short, and the group's row keeps its height
  whether or not a group is on.
- Drafting looks only at threads from the last 7 days where the last
  message is not the operator's. Same rule for iMessage and WhatsApp.

## 6. Blocklist

Operator-edited file of email addresses and phone numbers. Applied inside
the fetch step for all four channels. Blocked senders are never stored and
never reach a model.

## 7. Sorting

- **Output per message**: `important: boolean`, `needs_reply: boolean`,
  `scheduling: boolean`.
- **Model**: `claude-haiku-4-5-20251001`, direct Anthropic SDK, no tools.
- **Rule source**: operator-written markdown criteria file (VIP senders,
  topics that matter, what is noise). Operator edits it; the agent never
  writes to it.
- **Sub-categories under Important (2026-09-07)**: the operator defines
  them in the app, on the Inbox page's sub-category row ("Edit
  categories"): name, one-sentence description, order. They live in the
  `categories` table (position, name, description), seeded once with a
  starter list (Needs reply, Scheduling, Action required, FYI) the operator
  edits freely. The sorter assigns exactly one to every important message,
  or `Other` when none fits; when several fit, the first in order wins.
  Not-important messages get no category. The inbox shows one chip per
  category with counts as a second row under Important; the reason line
  names the category. Renaming a category re-labels its existing sorts;
  deleting one moves them to `Other`; adding one does not re-sort old mail
  (the operator can ask for a re-sort).
- **Finance (2026-09-09)**: a second axis on every sorted message,
  `finance: none | income | expense`, judged for important and
  not-important mail alike, independent of the sub-category. Income is
  money coming to the operator; expense is money leaving (bills, invoices
  to pay, receipts, subscription charges). It backs the header's Finance
  group. A "Re-sort window" control re-runs the sorter over the current
  window and updates category, finance and reason in place, never the
  importance verdict.
- **Safe to delete (2026-09-11)**: a third axis on every sorted message,
  `disposable: boolean`, judged for important and not-important mail alike,
  independent of the sub-category and of finance. Operator: "For all
  inboxes I want you to have a category under inbox that says 'Safe to
  Delete.' The 'Safe to Delete' contains messages such as marketing or
  one-time security codes." True for mail nobody will need again once it
  has been read: marketing and promotions, newsletters and digests,
  one-time codes, sign-in and verification notices, shipping notifications,
  automated receipts that are not invoices to pay, social and platform
  notices. False for anything a person wrote, anything with money to pay or
  a document to keep, and anything the operator may want to search for
  later: contracts, statements, tickets, confirmations carrying a date. It
  backs the "Safe to delete" row under Inbox and the deletes offered there.
  Rows written before the axis existed read false until "Re-sort window"
  reaches them, so nothing is ever offered for deletion on no verdict.

## 7a. Two sorter roles, and the trickle model learning from the backlog model

Decided with the operator on 2026-09-10 (A / A+B / A / B), after the
330-message eval (run f64d0517) showed qwen3:8b agreeing with Haiku on
importance, finance and project but flagging 144 of 257 no-reply messages
as needs_reply and matching sub-categories 43% of the time.

**Two roles.** The sorter is two roles. `sorter` is the trickle model, the
one the refresh button uses for the handful of messages that arrive
between syncs (env `CELESTE_MODEL_SORTER`, today `ollama:qwen3:8b`).
`sorter_backlog` is the backlog model (env `CELESTE_MODEL_SORTER_BACKLOG`,
the operator sets Haiku); unset, it is the trickle model, so nothing
changes by itself. The backlog model judges every bulk job: the first
sync of a newly connected inbox, Sort older, Re-sort, and the sort that
follows a window backfill. The routine refresh is the only trickle path.
`celeste models` lists both. Each sort row already records its model.

**Trusted verdicts.** A verdict is trusted when a model other than the
trickle model made it. Nothing yet marks a hand correction (`labeled_at`
only records when the provider label was applied), so the operator's
corrections join the trusted set once such a mark exists. Trickle
verdicts are never trusted: a wrong qwen3 answer today must not become
tomorrow's example.

**Examples in the prompt.** Before the trickle model judges a message,
the message is embedded (nomic-embed-text, the existing `message_embeddings`
vec0 table) and the six nearest messages with a trusted verdict are
rendered into the user message, before the mail itself, as worked
examples: sender, subject, a two-line snippet, and the stored verdict as
JSON. When embeddings are unavailable, the fallback is the most recent
trusted verdicts from the same sender domain. Examples are given to the
trickle sorter only; the backlog model does not need them and they would
break its cached prefix.

**Distilled rules.** After every backlog run, a Sonnet pass reads the
trusted verdicts and their reasons and rewrites `~/messaging-agent/rules.md`:
sender-domain patterns, needs_reply patterns, sub-category and finance
patterns, capped at about 1,500 words, in the operator's plain English.
The previous file is kept as `rules.prev.md`. The trickle sorter reads
it as a "Learned rules" block after the operator's criteria. The
operator may edit it by hand between runs; the next backlog run
overwrites it (the operator chose automatic rewrites over on-demand).
`celeste rules distill` and `celeste rules show` do the same by hand.
A rewrite costs one Sonnet call, roughly $0.15 for 330 verdicts.

**Proof.** `celeste eval sort` gains `--examples` and `--rules` so the
trickle model can be measured bare and with each aid on the same seed.
The aids earn their place only if needs_reply and sub-category agreement
rise clearly above 56% and 43%; whichever adds nothing is dropped.


## 8. Drafting

- **When**: `important && needs_reply` and the thread is unreplied.
- **Model**: `claude-sonnet-5`, direct Anthropic SDK, no tools.
- **Context given to the drafter**:
  - Last 10 messages of the thread, plus subject.
  - Attachment filenames, plus extracted text for attachments on important
    messages (section 11a).
  - Voice file: operator-written markdown with tone rules and sample
    replies.
  - Last 5 messages the operator sent to this sender, plus 10 most recent
    sent messages globally. Cached in SQLite.
  - Calendar via Alex (section 8a). Fetched only when the sorter flags
    scheduling intent. Drafts that propose a time also include the
    operator's booking link.
  - Contact note for the sender from the Obsidian vault at
    `~/Documents/Obsidian Vault`. **Deferred**: the vault has no people
    notes yet and the operator will define the convention later. Ships as
    a no-op stub read from disk, no Obsidian plugin required.
- **Addressing**: reply-all by default. Recipient list shown above the
  draft and editable before send.
- **Language**: match the incoming message.
- **Attachments**: the automatic drafter never attaches a file. The operator
  can (2026-09-10, below); Celeste cannot.
- **Follow-ups (2026-09-09)**: the automatic drafter answers inbound mail
  only, but the thread page's button works on any thread. When the
  operator sent the last message it reads "Follow up with Celeste" and
  drafts a short nudge to the people the operator last wrote to,
  referencing what was sent and asking for their update. The queue labels
  such a draft "Celeste follow-up". Withdrawn 2026-09-11 (operator: no
  Celeste drafts for sent mail, they only cost tokens): a thread the
  operator wrote last shows no drafting button, and a pending draft whose
  thread the operator has since answered from the mailbox itself is
  retired to skipped ("answered by the operator") the next time the queue
  or the pipeline reads it.
- **Revise (2026-09-10)**: the drafter has a second job. Given the thread,
  the draft as it stands and one line of instruction from the operator, it
  returns the whole body again with that one change made, keeping
  everything the instruction does not touch and the language and tone of
  the current draft. The instruction is the operator's and is followed; the
  thread stays untrusted data. Each revision is stored in `draft_revisions`
  (instruction, before, after, model) beside the draft. Nothing in `drafts`
  moves: `original_text` is still what Celeste first wrote and `final_text`
  is still only written by a send, so a revision is an offer exactly like a
  manual edit and the operator is the one who accepts it. Operator,
  2026-09-10: "if I want to chat with Celeste to make edits to the content
  of the draft … that should be a new feature."
- **Outgoing attachments (2026-09-10, decision B: attach and read)**.
  Operator: "I want to drag in a PDF file to ask Celeste and Celeste should
  automatically put that as an attachment to Jocelyn." Dropping a file on the
  Ask Celeste panel or on the draft card puts it on the draft the operator
  has open. Their act, not hers: there is no proposal and no button, because
  the drop already was the decision. The bytes go to the same content-addressed
  blob store every other attachment uses (section 11a) and a `draft_attachments`
  row records filename, MIME type, size, sha256, path and the text read out of
  it. A PDF's text layer is extracted with `pdf-parse` and capped at 20,000
  characters; a scan with no text layer stores none. A draft carries at most
  ten files, 25 MB each, and only while it is still pending.
  **Nothing leaves the Mac until Send.** The confirm gate names every file
  going out. On send they go with the reply: nodemailer attachments over
  IMAP/SMTP, and on Outlook a Graph `fileAttachment` inline up to 3 MB with an
  upload session above that, always put on the draft before it is sent.
  Removing a file deletes the row and never the blob, which is shared.
  While the panel is open, a drop also asks Celeste, in the operator's own
  words, what the file is and whether it fits the thread — the answer is what
  shows she read it. What she is shown is in section 10c.
- **The send gate is a preview of the mail (2026-09-10)**. Operator: "Should
  be able to click on the PDF and see the content. When I send an edit there
  should be a pop-up overlay displaying what the preview of the email should
  look like for the other person." Send no longer opens a panel inside the
  card showing a diff. It opens a dialog over the page holding the reply as
  the recipient will open it: From (the account's address, with its display
  name when it has one), To, Cc when there is one, the subject the sender will
  really set, the date in words, the body as plain text with its links live,
  and the files going out. The subject is the one core works out for the send
  (`DraftView.replySubject`), so the preview cannot drift from the mail. What
  Celeste first wrote is underneath, folded away behind "Show changes from
  Celeste's draft" and shown only when the text was edited, because the
  question at this point is whether the mail is right rather than what
  changed. **Send** is the only button, and Enter presses it; the × in the
  corner and Escape close it, and there is no Cancel (section 10a). Sending
  still opens the 6-second cancel window, and nothing about the send path
  changes.
  Outgoing files preview exactly like inbound ones (section 11a): a chip of a
  previewable type opens the file underneath it, on the card, while editing,
  and in this dialog; anything else downloads. Their bytes come from
  `/api/drafts/<draft>/attachments/<attachment>`, which takes the draft id as
  part of the question, so an attachment id belonging to another draft is a
  miss rather than a file.

- **The send gate outlives the page (2026-09-10)**: the operator pressed Send
  on a draft, moved on to something else and nothing went, because the six
  seconds lived in the card they had just navigated away from; the countdown,
  the Undo and the toast now sit in a provider above every route, and closing
  the tab or leaving the site fires whatever is still counting, forfeiting the
  window rather than the mail. A draft the gate is holding appears on no list,
  so coming back to the page it was sent from does not find the card waiting as
  if nothing had happened.
- **It says the mail went (2026-09-10)**: once the server confirms the send,
  the countdown is replaced for five seconds by "Sent to <recipient>" — with
  the subject when the line has room for all of it — because a toast that
  simply vanished made a send that worked look exactly like one that never
  happened, which is why the operator pressed Send twice.
- **The thread stops asking to be answered (2026-09-10)**: sending writes the
  draft's row and nothing else, so the reply exists only at the provider until
  the inbox is pulled; a send that works now reads the page at once, which
  takes the card away, then pulls that one inbox and reads the page again, at
  which point the reply is in Sent, `threads.last_from_operator` has flipped
  and the thread has left Need to reply.

## 8a. Calendar via Alex

The operator already runs a scheduling agent, Alex (`~/Desktop/agentic-
scheduling`, deployed with a public booking page). Alex syncs
every Google and Microsoft calendar and exposes a stateless JSON-RPC MCP
endpoint at `/api/mcp`.

- **Single calendar source.** This app has no Google Calendar OAuth scope.
  Alex is the only calendar read.
- **Not agent-to-agent.** Alex's MCP tools are deterministic code over its
  database, not a model. The daemon calls them like any HTTP API. The
  drafter stays tool-less; the daemon fetches before the prompt is built.
- **Endpoint.** Whatever `ALEX_MCP_URL` names; there is no default. Local dev
  `http://localhost:3000/api/mcp`. Configured as `ALEX_MCP_URL` in `.env`.
- **Transport.** Streamable HTTP, stateless. One POST carries one JSON-RPC
  message; GET returns discovery. Confirmed live on 2026-09-06 with
  `privateTierConfigured: true`.
- **Tier: private.** `Authorization: Bearer <MCP_TOKEN>` unlocks
  `get_schedule`, so drafts can reason over real events, not just free/busy.
  The token lives in `.env`. Without the header the endpoint fails closed to
  public tools only. Event titles therefore flow into draft prompts; the
  operator accepts that.
- **When.** The sorter emits a third flag, `scheduling`. Only threads with
  that flag trigger a fetch, covering the next 14 days.
- **Writes: only behind the button.** Proposing times still goes through
  the booking link; the recipient books via Alex. Beyond that, Celeste
  creates to-dos, reminders, and settled events in Alex, but only as part
  of an approval the operator confirms. Section 10e.

## 9. Airlock

Every model call that reads stranger-written text is a plain completion
with zero tools. Sending is a code path reachable only from the queue's
send button. Untrusted text can never reach anything that acts.

## 10. The app

Next.js PWA served by the daemon. Responsive, phone first. Reachable only
on the operator's tailnet, no app login in v1.

Surfaces:

- **Inbox**: every message from every account in one list, newest first,
  channel and account badges, important filter, mark handled. The daily
  digest is pinned at the top.
- **Thread**: full history of any conversation, cached summary at the top
  for long threads, reply from here using the draft flow.
- **Queue**: the drafts waiting for approval.
- **Search**: hybrid keyword plus semantic search over messages and
  attachment text.
- **Ask**: a question box over the inbox.
- **Compose**: start a new message on any channel. Recipient picker per
  account. Same confirm plus delay as a reply.

### Approval queue

Per draft:

| Action                    | Behavior                                                    |
|---------------------------|-------------------------------------------------------------|
| Send as-is                | Preview dialog of the mail as the recipient will read it (2026-09-10), then 6-second cancel window, then send. |
| Edit then send            | Inline edit, then the same preview, with the changes from Celeste's draft foldable underneath, plus delay. |
| Skip                      | Mark handled without reply.                                 |
| Regenerate with instruction | One-line steer, new drafter call.                         |
| Mark not-important        | Writes a correction row, removes from queue.                |
| Snooze                    | Hide until a date. Resurfaces on the next run. No scheduler. |

Plus one bulk action per run, described in 10b. Screen-level UI and UX decisions are in 10a.

Every action is logged to an `actions` table.

## 10a. UI and UX

Decided in a grilling session on 2026-09-06. The app is phone-first and
desktop-capable; one design, responsive.

**Direction**: premium, quiet, minimal, easy to read. Geist for all text.
Anything Celeste generated (sort reason, draft, summary, digest) and any
control that asks her to generate something carries the "Celeste" mark in
front of it (accent-coloured spark glyph plus the name), decided 2026-09-07,
so machine output is never mistaken for mail. Thread hierarchy: subject
first, then the inbox meta line, then the Celeste reason block; then the
thread as a conversation, oldest first, every message visible: the
operator's messages in accent-tinted bubbles on the right, everyone else's
in neutral bubbles on the left under a who-line (avatar, name, address,
recipients, date). Files sit at the top of the bubble, then the body. A reply
shows only the words its sender typed; the quoted history (Outlook
From/Date/To blocks, "On … wrote:", blockquotes) folds behind "Show quoted
history" (2026-09-09, operator-directed). Mail that quotes nothing, and a
bare forward, is shown whole. Signatures and legal footers stay, since the
sender wrote them.

**Inbox switcher (2026-09-08)**: one global control, top-left, selects
which inbox every surface shows: All, or one connected inbox. Desktop: the
top slot of the icon rail, a monogram button that opens a panel listing
"All inboxes" and each inbox by domain (full address when two share a
domain, and as secondary text), a status dot (synced / needs sign-in) and
its count of important, unhandled messages from the last 7 days, then
"Add inbox…". Phone: the same button in a slim top bar. The choice is
remembered per browser (cookie); a link naming an inbox overrides it for
that visit. It filters the Inbox, the approval queue, and every later
surface (Trash, digests). The Inbox page's per-account chips are removed. The switcher's per-inbox count (important, unhandled, 7 days) was removed on 2026-09-11 at the operator's request.
Under All inboxes the content header still carries the projects, folded
behind one pill per inbox and opened a row at a time (2026-09-10; 10d), so
the one view that shows everything is not the one view that cannot say what
any of it is about, and it stays one row tall until the operator asks for
more.

**Folder tree (2026-09-08)**: the icon rail is replaced by a labelled tree
in a 220px sidebar (desktop) or a drawer opened from a menu button in the
phone top bar (the bottom bar goes away). Rows: Drafts (the approval queue,
with its pending count), Inbox with Need to reply / Unopened / No need to
reply / Safe to delete (Unopened added 2026-09-09: threads unread by the thread_opens rule; its view has a "Mark all opened · N" button with a 6-second undo; Safe to delete added 2026-09-11: mail the sorter called `disposable`, counted and narrowed like every other row, with a "Delete all · N" button in the same place),
Sent with Waiting for reply / Not waiting for reply, Deleted items, Junk & Spam.
The inbox switcher stays at the top; Inboxes (gear) and the theme toggle
sit at the bottom. Inert placeholders (Ask, Triage) are dropped until they
exist. Need to reply is a fact about a thread (2026-09-09): its latest message
is inbound, that message's sort says `needs_reply`, and it is not marked
handled; older messages in the thread never count on their own. Automated
mail never needs a reply: calendar invitations and RSVPs, document-share
and access notices, system and platform notices, vendor outreach. Waiting for reply is a heuristic, no
model call: a sent message that still ends its thread and, with quoted
text stripped, asks something (a question mark or a request phrase).
The operator overrides it per thread: "No reply needed" on a thread they
sent last takes it out of Waiting until they put it back with "Waiting
for reply again" (2026-09-10).
Shift, pressed on its own on a thread, marks it handled (2026-09-11):
the pane sweeps off in the done colour as the server is told, the page
moves to the neighbour, and on the Need-to-reply list the row is gone at
once. Shift only arms on keydown and fires on keyup with no other key in
between, so Shift-combinations never trigger it.

Under All inboxes each inbox's pill carries that inbox's mail in the view
(the number the All tab is the total of), and an open pill narrows the
list to that inbox, shows its project row and a chip on the Showing row;
one pill is open at a time and the choice lives in the URL (2026-09-11:
a pill saying 0 under Sent while the list showed mail read as a bug). An
open pill stays on the bar even at 0, so an empty list has a visible
reason and a way out. A remembered project that holds nothing in the
folder on screen comes off rather than emptying the list, the way the
money side does; a project the link itself names stays.

Deleted items and Junk are the providers' Trash and Spam folders, synced
under the same window and backfill rules as Inbox and never sorted. The
chip rows (Important / All, window, sub-categories or projects) stay inside
the Inbox views. A thread opened from Deleted items offers "Put back in
inbox" in its action row (2026-09-11): the same provider restore Cmd-Z
uses, for a delete this session no longer remembers, and the next deleted
thread takes its place.
Colour palette is Protocol Z's (protocolz.org), decided 2026-09-07: night
(bg #0d0e0b, surface #1c1d17, ink #f6f6f2, signal #deff9a, critical #e0635e,
verified #b4e08a) and day (bg #f2f4f6, surface #fff, ink #16191d, signal
#ad552b, critical #c23b2e, verified #2e7d32), with hairline and ink-mute
tints from the same stylesheet. The signal colour is the one accent (send,
selected chips, badges); critical is danger. Default follows the OS; a
sidebar toggle persists a choice. Chips, rows, and nav items have visible
hover and selected states. No decoration that does not carry information.

**Phone (2026-09-11, the phone pass; operator: "now I want you to work on
mobile view")**: under 900px the same pages reflow rather than change. The
content header is one scrolling row per group with its labels hidden from
sight (title and project tabs, then window and money side on one row, then
Showing). Ask Celeste is the whole screen with the × top right, opened from
a spark at the right of the top bar. The thread page keeps its actions in
a bar fixed to the bottom, and "← Inbox" is the way back. A list row shows
its × always, and a swipe to the left deletes the thread; a delete made by
touch says "Deleted" with Undo on the toast, since a phone has no Cmd-Z.
Hidden preview text in HTML mail (a sender's preheader) is dropped at store
time instead of rendering as a column of letters. Nothing scrolls sideways
at 390px except a table inside its own card.

**Stress audit (2026-09-11, two hours of pressing everything)**: the
drafter may decline mail that asks nothing of the operator (an automated
notice, a receipt) with one line, `NO REPLY: <reason>`; the reason is kept
as a declined draft row so the pipeline never asks again, the thread page
says "Nothing to answer here" with Draft anyway beside it, and a draft asked
for through Ask Celeste is always written. The full sync runs behind
`POST /api/sync` rather than a server action, because a page's actions run
one at a time and a slow sync held every other one back; Graph calls carry
a 45-second timeout and IMAP sockets a minute, so a silent provider is given
up on instead of hanging the app. The send gate can say anything in the
app's toasts with an Undo that outlives the page (Mark all opened uses it).
A malformed address is named on the card before the preview. Two sort
passes meeting on one message keep the first verdict. With Ask Celeste
open under 1600px, or any window under 1200px with a thread open, the list
steps aside and the thread keeps the width. HTML mail at night sits on its
own light paper.

**Home is the queue.** Opening the app shows the next pending draft as a
full-width card. One draft at a time. Send, skip, mark not-important, and
snooze advance to the next card. When the queue is empty the home shows a
quiet "Nothing waiting" line, today's digest, and the last sync time.

**Navigation**: four destinations. Queue, Inbox, Search/Ask, Triage, plus
an Accounts entry (gear). Bottom bar on phone, thin icon sidebar on desktop.
Compose is a floating button on Inbox only.

**Inboxes** (re-decided 2026-09-07, twice; replaces every earlier version).
The unit the operator connects is an inbox, identified by its address. The
connector is about the mailbox, not a provider platform: Gmail and Google
Workspace connect over IMAP and SMTP with an app password, which needs no
Google Cloud project, no consent screen, no test-user whitelist, and never
expires. The Gmail API connector built earlier is removed. Outlook.com stays
on Microsoft sign-in because Microsoft no longer allows password IMAP.

- Add inbox: the operator types the address. The app detects the provider
  from the domain (and MX records for custom domains): Gmail-hosted inboxes
  get the Gmail IMAP/SMTP settings and a "paste an app password" step with a
  link to Google's app-passwords page; Outlook.com/Hotmail/Live open the
  Microsoft sign-in; any other domain asks for IMAP host and password with
  SMTP derived by convention and editable. The connection is tested before
  it is saved.
- Credentials: app passwords and IMAP passwords live in SQLite in a
  `mail_credentials` table, never in `.env`. `.env` holds only the product's
  own keys (`ANTHROPIC_API_KEY`, `MICROSOFT_CLIENT_ID`).



- The operator's only job is to identify the inbox and prove access to it
  (app password, or Microsoft sign-in for Outlook.com). Product-level keys
  (Anthropic, Entra app registration) belong to the product, live in
  `.env`, and are never typed into the UI.
- Connect: one "Add inbox" button opens the address step described above;
  iMessage and WhatsApp appear as "later".
- After sign-in: sync starts immediately with visible progress (fetching,
  sorting, labelling, drafting), then the queue opens on the first draft.
  No spend guard.
- Refresh (before the daemon phase): opening the app triggers a sync when
  the last one is older than 2 minutes; a refresh icon in the header forces
  one. There is no "Sync now" button.
- Inbox rows: address, type (Gmail, Outlook, IMAP), last sync, pending
  count, status. Disconnect removes the credentials and keeps stored mail
  and drafts (confirm first). A row whose login fails shows "needs sign-in"
  with Reconnect (re-enter the app password, or Microsoft sign-in), and the
  queue shows a banner.
- Placement: gear icon at the bottom of the sidebar, page titled Inboxes.
- First run: the empty queue is the onboarding: "Add your first inbox"
  with the address step inline.
- Outlook: public-client Entra app registration with PKCE, one env value
  `MICROSOFT_CLIENT_ID`, no secret; Inbox and Sent Items synced by
  per-folder Graph delta; categories `agent/*` as labels; replies sent
  through `createReply` so Graph keeps the thread headers.

**The draft card**, top to bottom:

- Meta line: channel glyph, inbox label (the domain after the @, e.g. `work.example.com`), sender, time, project chip (section 10d).
- Sorter reason, one line, always visible ("Client asks for a decision by
  Friday").
- Thread: latest message expanded, older messages collapsed to one line
  each, tap to expand.
- Recipients (editable), then the draft.
- "Also add to Alex": proposed to-dos, reminders, and settled events as
  checkable lines (section 10e).
- Actions: Send, Edit, Delete draft (Skip until 2026-09-14). Revising is done in the Ask Celeste panel
  (2026-09-14; the inline field of 2026-09-10 is gone, see below). Mark
  not-important and Snooze live in an overflow menu.

**Writing rule** (operator, 2026-09-10): Celeste writes like a person. No
semicolons, no em or en dashes, no hyphens used as dashes; hyphens inside
words stay. The rule is in every prompt that produces mail (draft,
follow-up, revise, apply from Ask Celeste) and the text is tidied once
more after the model answers (`humanizePunctuation`).

**Editing**: press Edit and the draft becomes an inline textarea. The
confirm panel shows a diff against the original so the operator sees their
own changes. That diff is what gets logged.

**Send gate**: Send opens a confirm panel with final recipients and the
text (or diff). Confirm slides the card away, the next draft appears, and a
non-blocking toast shows "Sending in 6s, Undo". Undo restores the card to the
front of the queue. The send fires when the toast expires.

**Live mail only in the triage rows, and no more backfill (2026-09-14)**:
the full-history backfill of chats had put 217 chats under Need to reply,
200 of them conversations that ended months ago and 51 from short codes,
and old mail filled Unopened and Safe to delete the same way. Operator:
"eliminate backfill". Decided: history already pulled stays, searchable by
Ask Celeste, but out of every status row. Need to reply, Unopened, Safe to
delete and Waiting only consider mail and texts sent within the 30 days
before an account was connected or since (`liveOnly`, off
`accounts.created_at`); the plain folder lists still show everything.
Connecting Messages or WhatsApp pulls 30 days, not all history; the
on-demand backfill (`BackfillOnDemand`) and "Sort N older" are gone.

Need to reply for chats is now people the operator knows, recently: the
other person wrote last, they have a name or the operator has written in
that chat, and the last word is within 14 days (`CHAT_REPLY_WINDOW_MS`);
groups still need an @mention. A number written prettily ("+91 99099
27926", "‪+1 (650) 862‑8157‬") reads as no name, for Safe to delete too
(`noName`, comparing digits; and `=` rather than LIKE, which ignored case
and read "Grace" as the handle grace@icloud.com). Mail keeps the
sorter's verdict.

And a deleted sender stays deleted: a new message from someone whose
earlier message the operator deleted (a `trash` action, not a hide) and
never answered goes to Deleted items on arrival, as a `hide` with
`auto: true`, so Put back still works and Safe to delete never offers the
same short code twice. The thread is marked opened up to it. Chats deleted
through the app are only deleted here; the phone still shows the new chat.

**A chat delete that lost the window (2026-09-14)**: "Could not delete 1
chat, Messages kept it". The script chose Delete Conversation… and a second
later read `sheets of window 1`; Messages, on another Space, showed no window
at that moment and AppleScript stopped with "Can't get window 1". The
confirmation is now looked for in every window, sheet and dialog for up to
five seconds, no window is ever indexed blindly, and "window gone" is its own
answer. When Messages does not say it deleted, chat.db is asked whether the
chat went anyway (`isGone`); if not, the whole delete, title check included,
runs once more before the chat is reported kept.

**Hidden, then deleted in Outlook (2026-09-14)**: "Could not delete 5
threads, the provider kept them". Each was mail hidden here and later deleted
in Outlook itself. Graph gives a message a new id when it changes folder, so
the copy arriving in Deleted Items was stored as a second row, and that new
inbound row was read as the sender writing again: the hidden copy came back
to the inbox under an id Graph answered 404 for. Three fixes. A copy arriving
in Trash with the Message-ID of a hidden row is that row: it takes the new id
and becomes deleted, not hidden. Only a message arriving in the inbox or
Messages brings a hidden thread back. And an Outlook delete or restore that
meets a 404 finds the message by Message-ID (`findMessage`): already where it
was going counts as done, elsewhere is moved under its current id, gone from
the mailbox counts as done. Sixteen stale inbox rows, all confirmed in
Outlook's Deleted Items, were folded into their Trash copies (`absorbCopy`).

**Mobile: a home-screen app over Tailscale (2026-09-14)**: "how can we
make this mobile", option 1 of three (a native wrapper and a cloud move were
the others; texts cannot leave the Mac, so the Mac stays the server). Four
parts.

- *Always on.* `scripts/celeste-server/install.sh` puts two launchd agents in
  the user's account: `com.celeste.server` runs `start.sh` (install, build,
  `next start` on 127.0.0.1:3100) at login and again whenever it stops, and
  `com.celeste.awake` runs `caffeinate -is` so the Mac does not sleep on
  power. It refuses to install without a passcode or with port 3100 taken,
  and runs `tailscale serve --bg 3100` when Tailscale is up. `uninstall.sh`
  takes all of it back out. `CELESTE_NO_BACKGROUND=1` starts a server without
  the chat watcher and mail clock, for a trial run beside the real one.
- *The lock.* `proxy.ts` lets this Mac's own browser straight through: Next
  adds forwarding headers to every request, so local means every one of them
  names this Mac and none of Tailscale's identity headers is present.
  Anything else goes to `/unlock` and types `CELESTE_PASSCODE` from .env (at
  least 8 characters), which signs a 30-day session cookie with a key derived
  from the passcode, so changing it signs every phone out. Five wrong tries in
  ten minutes wait out the ten. APIs answer 401 instead of redirecting. The
  root layout renders nothing of the app for a locked request, since it puts
  the Ask conversation into every page. Origins and redirects use the
  forwarded name and scheme, and server actions allow `*.ts.net`.
- *Home-screen app.* `app/manifest.ts` (standalone, starting on Need to
  reply), icons drawn by the app with `ImageResponse` (the Celeste star in
  signal lime on the night ground: 32, 180, 192 and 512 pixels), a
  see-through status bar with `viewport-fit=cover`, and safe-area room on the
  phone's top bar, drawer and Ask panel. The manifest, icons and service
  worker open without a session.
- *Push.* A Notifications switch in the sidebar subscribes the device through
  `public/sw.js`; on an iPhone Safari that is not on the home screen it is a
  line saying to add it first. Subscriptions live in `push_subscriptions`,
  signed with VAPID keys in .env. The server pushes after the chat watcher
  stores a text and after mail is sorted, for what landed in Need to reply
  since the last notice (`needsReplySince`): one per thread with who wrote and
  at most 90 characters, one line when more than three land at once, a tap
  opening the thread. A subscription the push service calls gone is deleted.

Adding an inbox stays on the Mac: Google sign-in is registered to 127.0.0.1.

**Delete draft (2026-09-14)**: "able to delete draft". Skip already did
the act, removing the card, keeping the automatic drafter off that message
and bringing back "Draft a reply", so it became the delete rather than a
second button beside it: "Delete draft" with the trash icon, still on x,
named apart from the thread's own Delete in the row below. It says "Draft
deleted" with an Undo that puts the card back as it stood, the operator's
typing, To and Cc included (`restoreDraft`, refused when the thread holds a
newer draft by then). Stored as `skipped`, with a `restore` action for the
Undo.

**Hide keeps the thread in the folder (2026-09-15)**: "hide is when
temporarily the messages do not show up under Need to reply, Unopened, or Safe
to delete for chats and emails until that person sends another message". Until
now Hide moved the thread to Deleted items, so Rafael's email vanished from the
one inbox. A hide now sets `threads.hidden_at` and moves nothing: the
thread stays in Inbox or Messages with a Hidden tag, and Need to reply,
Unopened, No need to reply and Safe to delete leave it out (their counts too).
A new message from the other side clears it; the thread page offers Unhide in
place of Hide, and Undo unhides. Hiding from a plain Inbox or Messages view
keeps the page where it is; from a sorting list it moves on to the next thread
as before. Threads hidden the old way were brought back to their folders and
hidden the new way at start (`convertLegacyHides`); what the app hid by itself,
a new message from a sender the operator had deleted, stays deleted. The bare Shift shortcut is gone: held while clicking or
scrolling it read as a tap and hid fifteen threads in two minutes. Hide is =.

**Quotes checked against what they cite (2026-09-15)**: "celeste gave me a
wrong answer". Asked for a password from a WhatsApp chat, she answered from
earlier in the conversation and "quoted" a line no message holds: one
account's address with another account's password, cited to the wrong
message, while search would have returned the right one first. The prompt
now says that what a message says comes from a tool called for this
question, never from earlier turns, and that a quote is copied word for word
and checked. After every answer, each quote (a `>` line, or double-quoted
text of eight characters or more) with a `[msg:id]` on its line or the next
is split where lines were joined or words elided (" / ", "…"), and every
piece must appear in the cited message (`checkQuotes`). A mismatch goes back
to her once, naming the quote, and she re-reads and answers again; still
wrong, the answer carries a line saying a quote does not match its message.

**Chats on the clock too (2026-09-15)**: "the newest chat for iMessages is
not getting synced". Three texts arrived while the server was down; the
watcher only fires on a new write, so nothing read them after it came back,
and the refresh button had fetched mail alone since the clock split. Now both
chats sync once when the server starts, on every tick of the two-minute
clock as a net under dropped file events, and on refresh.

**Mail on the server's clock (2026-09-14)**: a reply to a Waiting thread
arrived at 2:27 PM and Celeste fetched it at 2:47 PM, so the thread read as
still waiting. Mail was pulled only by an open, visible tab every three
minutes, inside one sync that also sorted, labelled and drafted for about
94 seconds. Decided with the operator (option 1 of two; IMAP IDLE push was
the other): the pipeline splits into `fetchAccounts` and `processPending`.
The app server fetches every mail account every two minutes from
`instrumentation.ts` (`startMailClock`, a `Ticker` that skips a tick while
a run is in flight), on the same queue as the chat watcher so no account is
read twice at once, and hands what arrived to a single-flight sort that
never holds the next fetch back. The tab's own three-minute sync is gone;
opening the app still syncs when the last one is stale, the refresh button
still runs the whole pipeline, and the page's three-second pulse shows what
landed.

**Mail or Messages, a toggle top left (2026-09-14)**: "can we have a
toggle where we can switch between messages and emails, instead of having
messages under the left hand bar". The sidebar opens with a two-way switch.
Mail shows Drafts, Inbox, Sent, Deleted items and Junk with the inbox
switcher; Messages shows All chats, Need to reply, Unopened and Safe to
delete, and no inbox switcher, since chats belong to no inbox. Each side
wears its Need to reply count on the corner, so the other side is never out
of mind. The side follows the page (`sideOfPath`); on Inboxes and Usage the
side last chosen stays, remembered in the browser. Each side lands on its
Need to reply list and keeps the window (`sideHref`). Words only, no
icons: in the 220px column an icon and a count cut the label to "Mess…".

**Read or answered in another app is not unopened (2026-09-14)**: a chat
read or answered on the phone stayed in Unopened here, because read state
for texts was Celeste's own. Three sources now open a thread up to a
message, never past it, so a newer text still counts: Messages' `is_read`
on each text as it is stored, plus the guids of texts read in the last
week re-read on every sync (`readGuidsSince`); WhatsApp's per-chat
`ZUNREADCOUNT`, a chat with none unread opened up to its newest text on
every sync; and, for mail and chats alike, the operator's own message,
which is proof they read the thread up to then.

**Contact names, synced both ways (2026-09-14)**: "the contact names are
not synced". Messages read the Mac's Contacts already; WhatsApp never did,
naming an unsaved contact by their number; and a chat was named when its
first text landed, so a contact added afterwards left it called by the
number forever. Now `chatNameFrom` names a WhatsApp one-to-one chat from
Contacts, by the chat's phone or by the number in its name, whenever
WhatsApp only has a number (`isNumberish`); and every sync of either chat
account runs `renameChatThreads`, which puts a newly learned name on the
thread, on every text in it, on the sender of every inbound text and into
the search index. The other party's handle is read off the chat's own
texts, theirs from or ours to, so a chat only ever written to is named too.
Contacts on this Mac is the source: what the phone does not share with the
Mac cannot be named here.

**General or this thread, as two tabs (2026-09-14)**: the "Looking at"
chip with its × was the only way between the thread's conversation and
General, and the way back was to open another thread (operator: "super
easy to navigate between general chat and specialized chat"). The panel
now carries two tabs under its head whenever a thread or a draft is on
screen: General, and the thread by its subject (a draft by who it goes to
when there is no subject). One tap either way. The thread tab is the chip
of before, General is the chip cleared, and the tab back resumes both the
thread and the draft at once (`resumeLookingAt`, reducer event `resume`).
With nothing open there are no tabs: General is the only place then.

**Chats are outside the inbox switcher, for Ask too (2026-09-14)**: asked
"check my message with Keith and find out what the passwords are" with a
Gmail selected, Celeste reported no chat by that name, although the chat
held 437 texts and the index found the two with a password. Her search and
list tools narrowed everything to the selected inbox, and a chat belongs to
no inbox. The selected inbox now narrows mail only: `search_inbox` keeps
every chat in reach whichever inbox is selected, `list_mail` over the
Messages folder ignores the inbox as the page does, and the prompt says so.

**Read elsewhere (2026-09-14)**: opened mail kept reappearing in Unopened.
The database showed no open record ever lost; what it showed was that read
state never came in from the provider, so every synced mail, including mail
read years ago in Gmail or that morning on the phone, started unopened, and
"Mark all opened" cleared only the window on screen, so widening it brought
the rest back. Four changes. A message's read state rides on
`NormalizedMessage.read` (IMAP's `\\Seen`, fetched with the source; Graph's
`isRead`, added to the select), and storing a read message from someone
else opens its thread up to that message's time and no further
(`markThreadOpenedUpTo`), so a newer unread reply still counts; a Graph
delta re-delivering a message as read does the same on the row it already
has. Every IMAP sync also reads the `\\Seen` flags of the last week's inbox
mail again, flags only, so what was read on the phone since catches up.
"Mark all opened" acts on the whole inbox, every window; its number is the
number it acts on, while the tree's count beside Unopened stays the
window's. Only inbox mail and texts make an opened thread unread again: a
reply that went to Junk or Trash no longer does, which had put the mail
already read back on the list. And Undo on "Mark all opened" keeps any
thread the operator opened by hand after pressing it: each record carries
the mark's time, and a thread whose open no longer matches it is theirs.

**Revising a draft (2026-09-10, moved into the panel 2026-09-14)**: the
card used to carry its own one-line field marked "Celeste revise", with a
Revise button and an "Undo revision" beside it, while the Ask Celeste panel
did the same job through `apply_draft`. Two inputs, two buttons and two
Undo paths for one act (operator, 2026-09-14: "the ui/ux can be simpler
than that"). The field is gone. A draft is revised by saying what to change
in the panel, which sees the card, and the rewrite lands on it at once; the
panel's box invites it ("Ask Celeste, or say what to change in the draft…")
and its empty state says the same. What a rewrite replaced waits behind a
quiet "Undo" on the draft's own label line, next to "revised, 5 changes", a
stack ten deep; it is hidden in the confirm gate. On a desktop wide enough
for the panel to make room rather than cover the card (1200px and up), a
draft appearing opens the panel by itself, once per draft, so a card is
never on screen without the way to talk to Celeste about it; closed again,
it stays closed for that card. The card's `edited` mark and the confirm diff
are unchanged, both still read against the draft Celeste first wrote, so a
rewrite shows up as what it is: another change to that draft.

The same instruction can come from the Ask Celeste panel instead, which
sees the open draft and offers "Apply to draft" (section 10c); either way
the revision lands in `draft_revisions`.

**Delete gate (2026-09-11)**: deleting is the second write that reaches the
world, and it goes through the send gate rather than a second one of its
own. Three ways in: a quiet "Delete" in any inbox thread's action row,
which moves to the neighbour as "No reply needed" does; a small × at the
right of each row on the Safe-to-delete view, a sibling of the link rather
than inside it; and "Delete all · N" where "Mark all opened" sits, over the
threads in the view on screen, resolved when it is pressed rather than when
the page was drawn. Each dispatches one job that goes at once: no countdown
and no Undo (operator, 2026-09-11: "just delete instantly"), because nothing
is destroyed. The thread sweeps off the screen, and a row slides out, before
the page moves on, and a delete that worked says nothing more (operator,
2026-09-11: the "Deleted 1 thread" toasts were not wanted; one that failed
still says so). Pressed again before the next thread has shown, Delete
takes that next thread, walking the list in the neighbour's order (operator,
2026-09-11: "delete very fast"). The way back is Cmd-Z (operator,
2026-09-11): the last delete done comes back out of the provider's Trash
into the inbox, then the one before it, said with a "Restored" toast. A
moved message gets a new provider id, so every move Celeste makes records
where the message ended up, and a sync that meets a message it knows under
a new id on the other side of Trash moves the row instead of adding one.
Nothing is destroyed — IMAP moves the uids to `\Trash` (MOVE, or COPY plus
`\Deleted` plus an EXPUNGE of those uids where the server has no MOVE) and
Graph posts the message to `deleteditems` — so the toast that follows says
"Deleted N threads · in Trash for 30 days", the way back after the window
has closed. Only the messages that actually moved are filed under `trash`
and written to `actions` as kind `trash`; the operator's own sent mail in a
deleted thread stays where it is. Ask Celeste has no `delete_threads`
proposal yet; that is a follow-up.

**Mark not-important**: overflow menu item. Card leaves the queue, toast
offers undo, the correction row is written when the toast expires.

**Snooze**: presets this evening, tomorrow morning, next week, plus a custom
native date input.

**Ask**: one search box. A keyword returns results. A question returns an
answer card with the cited messages beneath, each tappable to open the
thread. No chat history; asking again replaces the card.

**Triage** (one-button trash): non-important rows grouped by sender with a
count, account glyph on each row. Unchecking a sender keeps all of theirs.
Follow-ups waiting on others and weekly project proposals appear on the
same screen.

**Desktop**: the queue is one centered column about 720px wide. Inbox is a
two-pane list plus thread. Keyboard shortcuts in v1 are minimal: `s` send,
`x` skip, `e` edit, `Esc` back or cancel, `Enter` confirms inside the gate. On a thread page, `Delete` or `Backspace` (with nothing focused) deletes the thread through the same gate as the Delete button (2026-09-11).
The fuller keymap (j/k, r, n, z, o, ?) is a later phase.

**Drafts page (2026-09-10)**: Drafts is a folder like every other one, not a
single card handed over at a time. Two panes under a header of its own —
title, "N waiting", and the refresh control — with the pending drafts as
rows on the left in queue order, oldest first, each showing its inbox and
time, who it goes to, the subject it answers, the opening of the draft and a
`reply` or `follow-up` tag; the draft card fills the right pane. Which draft
is open rides in `?draft=`, defaulting to the first, so a row is a plain
link and the thread page's "Open in queue" lands on the right one. Skip, and
a Send the moment its six seconds start, take the draft out of the list and
move the selection to the one below it, or the one above when it was last,
or the empty state; Undo restores the card to the front of the queue and
reopens it. A skipped draft is the operator's answer to that message: the
next sync does not draft it again, though a newer message in the thread is
drafted afresh (2026-09-10). Every one of those refreshes the server-rendered counts, so
"Drafts · N" in the tree and the header agree with the list. On a phone the
list comes first and a tap opens the card, with a "Drafts" back link, as on
a thread. j/k and the arrows walk the list. An empty queue keeps all of it —
header, both panes, tree — with "No drafts" in the list and, in the card's
place, "No drafts waiting" over the one line that says where a draft comes
from, since nothing on this screen makes one.

**The reply card under the thread (2026-09-10)**: the operator, on asking
Celeste for a draft from the panel — "that draft should pop up on the
left-hand side under the content of the email as if we're replying to them
automatically. Kind of like Cursor design." A thread whose draft is waiting
carries it on the thread page, between the mail and the action row: the same
card the Drafts folder shows, with the thread left off it because the page
above it is the thread, and the account line, the subject and the sorting
reason left off for the same reason. There is no "Open in queue" any more,
and "Draft with Celeste" stays on the thread rather than carrying the
operator to the queue — what it makes appears under the mail a moment later.
It is the queue's card in every other way: To and Cc, the files going out,
"Revise with Celeste", the send gate's preview of the mail, and the same six
seconds with an Undo before anything leaves, one implementation shared by
both places a card can be read. Send or Skip and the card goes, the counts
and the action row are the server's to say again, and "Draft with Celeste"
is back on the row. It registers with the Ask panel exactly as the queue's
does, so "Looking at: draft to <recipient>", Apply, the + and a drop all
reach it from a thread page. Drafts stays the folder over all of those cards,
and its list is the server's again on every refresh rather than only at
mount, so a draft written from the panel joins it without a reload and
`?draft=` for that draft opens it rather than whatever was on top.

**Notifications**: app icon badge with the pending count, one push per
morning with the digest. Nothing per message.

## 10b. One-button trash

One bulk button per run: "Trash non-important".

Flow:

1. Opens a review list of every message sorted non-important in this run,
   grouped by account, showing sender, subject or first line, and channel.
   All rows checked.
2. Operator unchecks anything to keep. An unchecked row writes a
   `corrections` row with verdict important, so the sorter learns.
3. Confirm dialog shows the final count per channel.
4. Six-second cancel window.
5. Trash executes per channel and reports per-row success or failure.

Per channel:

| Channel  | What happens                                                                 | Recoverable       |
|----------|------------------------------------------------------------------------------|-------------------|
| Gmail    | `messages.trash` via API                                                     | 30 days in Trash  |
| Outlook  | Graph move to `deleteditems`                                                 | Deleted Items     |
| iMessage | Open conversation by URL, read window title, require it to match the expected handle or known alias, then Cmd-Delete. Deletes the whole 1:1 conversation. Group chats refused. | ~30 days in Recently Deleted |
| WhatsApp | No automation path exists. Rows shown in a "delete by hand" list.           | n/a               |

Exclusions, never trashed even if sorted non-important:

- Threads where the operator has ever sent a message.
- Messages with an existing correction marking them important.
- iMessage group chats.

iMessage deletion is the only act that reaches through a keyboard rather
than an API. If the window title does not match or the window never
appears, nothing is pressed and the row is reported as failed.
Reference: `kernel/src/text-delete.ts` in Agentic_OS.

## 10c. Intelligence layer

All of these are tool-less completions over stored data. None can send,
label, or trash.

| Feature            | Behavior                                                                                   | Model |
|--------------------|--------------------------------------------------------------------------------------------|-------|
| Daily digest       | Once each morning: what came in, what needs you, what is waiting on others. Pinned in inbox. | sonnet |
| Follow-up tracking | Threads where the operator sent last and nobody replied in 3 days surface as "waiting on them" with a nudge draft in the queue. | sonnet for the nudge |
| Thread summaries   | One paragraph at the top of any thread over 10 messages. Cached per thread, refreshed when the thread grows. | haiku |
| Ask your inbox     | Hybrid retrieval: FTS5 keyword hits and sqlite-vec nearest neighbours over messages and attachment chunks, merged by reciprocal rank fusion. Top hits go to a completion, answer cites the messages and files it used. | sonnet |


**Ask Celeste panel (grilled 2026-09-09, all A).** The first shipped piece
of the intelligence layer: a toggleable 380px right panel ("Ask Celeste"
in the sidebar, keyboard shortcut ⌘/) that stays open across folders and
threads. Conversations are stored in SQLite (`chats`, `chat_messages`) so
they survive reloads and feed the personal-model data later; one per thread
since 2026-09-10 (see below), where it was one running conversation before. Celeste always sees the thread that is open (shown as a "Looking
at" chip the operator can clear) and can search the whole inbox through
tools: FTS5 keyword search over subject, sender and body (sqlite-vec
neighbours join later), fetching a thread by id, listing mail by window and status (new, unopened, waiting), and searching by sender or project (2026-09-10). Proposals can name several threads and become one button ("Create Immigration and file 2 threads"), creating a missing project on the way; under a bulk button each thread is a chip reading "subject · sender", resolved when the turn is stored so old turns keep their names (operator, 2026-09-10: "what does this thread 1 and 2 do here?"). She answers with
citations to the messages she used and can **propose** actions that
render as buttons: draft a reply or follow-up, file the thread to a
project, mark it handled, open a thread. Every action needs the
operator's click; nothing sends, moves or writes without it. Model:
`claude-sonnet-5`. Every Celeste turn carries the Celeste mark. Mail
content is untrusted data inside the prompt.

**A conversation per thread, and History (2026-09-10, decision A).** The
operator: "when I do Ask Celeste [with a draft open] I want it to
automatically point to the content of the draft and clear out the history.
Also there should be a feature where I can go back to previous chat history
with Celeste on any given emails or topics." So the panel is no longer one
running transcript. Conversations are **per thread**, drafts included —
a draft is a reply in its thread, so both share that thread's conversation —
plus one **General** conversation for questions asked outside any thread or
draft. Opening a thread or a draft switches the panel to that thread's
conversation: empty the first time, resumed every time after. The head names
the conversation under "Ask Celeste" (`<subject> · <counterpart>`, or
"General"), with a **History** button that lists every conversation anything
was said in, newest first, with its last message's age and how many turns it
holds; clicking one reopens it here without navigating to its thread, so the
"Looking at" chip still describes the page. **New** closes the conversation
on screen — closed, not deleted: it stays in History, it is just no longer
what that thread opens to — and starts a fresh one in the same context. The
chip and the draft context are unchanged. Stored in `chats`
(`kind`, `thread_id`, `title`, `updated_at`, `closed_at`); the one chat that
existed before this becomes General.

**The draft the operator has open (2026-09-10, part B of the "Revise with
Celeste" request in section 8).** While a draft card is open, it registers
itself with the panel: recipients, subject and the text as it stands after
every edit and revision. The chip then reads "Looking at: draft to
<recipient>" beside the thread's own, and can be cleared the same way. The
question carries that draft, and the thread it answers comes from the
draft when no thread is open, so a question asked from the queue lands on
the right mail. The draft block is the operator's own writing and is
trusted; the thread beside it stays untrusted mail. Asked for a change to
it, Celeste answers in a line and proposes `apply_draft` with the complete
revised body, which renders as an "Apply to draft" button. The click puts
that text on the card exactly as a revision typed under the draft does —
the card's Undo walks it back, the "· edited" mark and the confirm diff
still read against what she first wrote — and records it in
`draft_revisions` with the instruction "from Ask Celeste: <the question>".
She never sends: the operator still reads the card and presses Send. Each
turn remembers which draft it was about (`chat_messages.context_draft_id`),
so a button offered over a draft that has since been sent, skipped or
closed is greyed out rather than landing somewhere else.

**Files on the draft (2026-09-10, with section 8's outgoing attachments).**
The draft block names every file attached to it — filename, MIME type, size —
and carries the text read out of any PDF under a `--- text of <filename> ---`
fence. The draft above it is the operator's own writing and stays trusted; a
file's contents are untrusted data like mail, and the block says so before she
reads a word of it. The list is read server-side from `draft_attachments` by
draft id rather than sent up from the browser, so a PDF's text never makes the
round trip. There is no tool and no proposal for attaching: the operator
dropped the file, and her part is to say what it is. A drop with the panel
open posts one question on their behalf ("I attached <filename> to the draft.
What is it, in one line, and does it fit the thread?"), shown as their own
bubble in a quieter style, so the confirmation is an answer rather than a
claim by the app. One Sonnet call per drop.

**Files on the conversation, and the + that always works (2026-09-10).**
Operator: "cannot click on the plus button, I click on it, and nothing
happens" — on a thread page, where no draft is open, the + and a drop had
nowhere to put a file and were dead. A conversation now holds files of its
own (`chat_files`: filename, MIME type, size, sha256, path, text excerpt),
the same 25 MB a draft takes, twenty per conversation, the same
content-addressed blob store and the same PDF text read on the way in. The +
and a drop on the panel always take the file: onto the draft when one is
open, as before, and to the conversation when none is, with the overlay
saying which ("Drop to attach to the draft to <recipient>" / "Drop to give
Celeste this file"). A drop with no draft open posts the auto question "I
gave you <filename>. What is it, in one line?" in the same quieter style.

Those files show as chips over the composer: a PDF or an image opens
underneath the chip, anything else downloads, × takes it off the
conversation, and the bytes stay because blobs are shared. The prompt gains
"# Files in this conversation" after the thread block and before the draft —
each file named with its size, the text of any PDF under the same untrusted
fence a draft's files get — read server-side from `chat_files` by chat id, so
a PDF's text never makes the round trip. There is no tool for attaching: when
a draft is open and a file belongs on it she says so, and the chip's "Attach
to draft" button is the only thing that puts it there, copying the row into
`draft_attachments` with the same blob and the same excerpt rather than
reading the file again. The card then reads its own files back, so the row
the operator sends from is the true one. The draft card's own paperclip and
drop are unchanged. Bytes are served by a third route under the inbound
rules, `/api/chats/<id>/files/<fileId>`, with the chat id part of the
question so a guessed file id is a miss; like the other two it is left out of
the app's CSP, which blanks Chrome's PDF viewer.

A rewrite Celeste proposes for the draft that is open lands on the card at
once, with Undo revision, so her "updated the draft" is true (operator,
2026-09-10); the Apply button stays for a turn read back later, when the
card is a different one.

**A draft of the thread on screen is written, not offered (2026-09-10).**
Asked to draft a reply to the thread the operator has open, Celeste proposed
a button and then wrote the reply out in the chat as well, which is two
drafts and neither of them where mail is composed. A `draft_reply` or
`draft_follow_up` proposal over exactly the one thread named by the "Looking
at" chip now runs the moment her answer lands: no click, and the reply card
appears under the mail (section 10a). The button reads as done with a link to
the queue, so a turn read back later says what happened rather than offering
to do it again, and nothing runs twice for a thread whose draft is already on
screen. A proposal over several threads, or over a thread the operator is not
on, keeps its button: a sweep is theirs to agree to. Asked from the Drafts
folder, the new card is the one that opens. She is told the same rule — say
in one line that the draft is under the mail on their screen, never write the
reply out beside it, and with a draft already open ask for wording through
`apply_draft`, never both in one answer.

Which draft the panel is looking at is one state machine, and every event
names the draft it means: a card registers, lets go by name, and the × clears
by name. A card leaving the screen can only take away its own registration,
so it can never empty the chip the card arriving beside it has just filled —
the failure behind Celeste answering "the draft isn't open right now, so I
can't push the update directly" over a draft the operator was looking at.

**The operator's words reach the drafter (2026-09-14).** "Draft an email
saying that I have already reached out to Ryan... also ask if I can take a
final look before they file it" left a card that said neither: a
`draft_reply` proposal carried only a thread id, so the drafter saw the
thread alone and wrote its own reply, while Celeste's summary described the
request rather than the text. A proposal now carries `instruction`, the
operator's words about what the draft should say, and Celeste is told to
pass all of them on whenever they said anything about its content and to
describe the draft only by what she passed. The drafter is handed the
instruction after the thread, told every point in it goes in, and never
offered the decline. She is also told to ask or act, never both: an answer
that asks "do you want me to start a fresh reply?" and then says "the draft
is on your screen now" contradicts itself. And when she proposes a new draft
with words in it for a thread whose card is already open, the panel does
not write a second card: it revises the open draft to say them, the way
"Revise with Celeste" does, and the answer reads as applied.

## 10d. Projects

Decided in a grilling session on 2026-09-06. Ships with Phase 4, because it
depends on local embeddings (section 11a).

**Amendments, grilled 2026-09-08** (these override the paragraphs below
where they differ):

- Projects are **per inbox** and live in SQLite (`projects` table: inbox,
  name, description, order), not in `projects.md`. The operator defines
  them in the app: an in-place editor on the Inbox header (Edit) with an
  "Add starter projects" button that loads the seed list, and "New
  project…" inside the thread's "Move to project…" picker. Under "All
  inboxes" the bar shows every inbox's projects, folded behind one pill per
  inbox (2026-09-10, superseding "no project chips show"; see the project bar
  below). The editor stays per inbox, so an opened row's Edit takes the
  switcher to that inbox.
- **Project bar (grilled 2026-09-08, supersedes the chip-row placement)**:
  a bar across the top of the content area, above both the list and the
  thread pane, shows the selected inbox's projects as tabs: All, then each
  project in the operator's order (all of them, wrapping), then Unfiled,
  then Edit. Each tab counts the messages in the current folder and window
  that match it, regardless of Important / All, so the numbers describe the
  list beneath. Picking a tab filters every folder view (Inbox, Sent,
  Deleted items, Junk & Spam) and persists across folders (cookie, per
  inbox); a link naming a project overrides for that visit.
  **Under "All inboxes" (2026-09-10, operator: "the projects for each inbox
  should still show but they should be categorized under different
  mailboxes", then progressive disclosure after the unfolded version read as
  messy)**: the first row is a single "All · N" tab, counted over every inbox
  at once, then one pill per inbox that has something to show, in switcher
  order. A pill carries the inbox's short name, a chevron and how many
  projects wait under it (Unfiled aside); shut, the pill of the inbox holding
  the project that is on says which instead of counting, the name cut short
  if it is long. Clicking a pill opens that inbox's row beneath the first,
  above the window row: the inbox's name, its tabs (its own Unfiled included)
  and its Edit pencil. Several rows can be open at once. Which are open is
  browser state, unremembered and out of the URL: the inbox holding the
  project that is on opens itself, everything else starts shut, and a click
  on a tab inside an open row leaves it open. On a phone the pills wrap and
  the rows stack. Hidden-at-zero and the counts-equal-the-list rule hold per
  row, so each row's numbers are taken over its own inbox alone; a row's
  Unfiled is that inbox's Unfiled and names the inbox, since two rows sharing
  one would each show a number neither list has. Picking a tab narrows the
  list to that project — and to the inbox that owns it, the folder tree's
  counts with it — while the switcher stays on All. The choice is remembered
  under its own owner rather than any inbox's, so it survives a reload
  exactly as it does under one inbox, and neither view's choice leaks into
  the other. With no projects anywhere the bar says "No projects yet. Pick an
  inbox and press Edit to propose some."
  **Header (2026-09-09, redesigned for clarity, operator chose A):** one
  visual grammar per axis. Row one: folder name, then a strip labelled
  PROJECT of underline-style tabs (not pills) on a single line that scrolls
  sideways, Edit pinned at its right end, refresh at the far right. Edit
  opens the project or sub-category editor as a centred popover dialog over
  the page (2026-09-10, operator: "a popover panel instead of a
  collapsible"): Esc, scrim or Cancel closes it; a URL param deep-links it. Row
  two: segmented groups labelled WINDOW and FINANCE (counts only on
  Finance). Re-sorting lives only in the project editor ("Re-file this inbox"); the header's sole ⟳ syncs mail (operator, 2026-09-09: one refresh button). Beneath the header, above the list, a
  one-line summary of what is applied ("Formation & legal · Income · All
  time"), each part clickable to clear that one dimension. The Important /
  All toggle was removed earlier on the operator's word; the list shows
  every message in the window and important ones keep their dot. Project tabs show only projects that
  hold mail under the current selections, in the operator's order, plus All
  and whichever tab is on (operator, 2026-09-09 evening: "hide all the
  project chips that have 0 emails"); Finance and window chips keep their
  places and dim at zero.
  **Filters combine with AND and are all remembered** per browser (inbox,
  window, Finance, project, like the inbox switcher); every tree row, tab
  and chip changes only its own dimension and carries the others, folder
  switches included. Counts everywhere describe the list beneath them, subject to the
  **header hierarchy (2026-09-09)**: project comes first; window and
  Finance narrow within the chosen project and never change which
  projects show or their counts. Project tab counts follow folder, tree
  status and inbox only. Finance counts follow project, window, folder and
  status; a Finance side with zero messages is disabled, not clickable.
  Window chips are always clickable and carry no counts.
  **List rows group by thread (2026-09-09, operator-directed):** a thread
  is one entry showing its newest message, with an "N earlier messages"
  toggle that expands the rest indented; collapsed by default, the open
  thread's group expanded on the thread page. The count is over the
  messages the current filters admit, not the thread's full length.
  **Unread (2026-09-09):** rows carry no importance dot. A thread the
  operator has not opened in Celeste since its latest inbound message shows
  a blue dot in the left gutter and a bold sender, Apple Mail style; opening
  the thread clears it (`thread_opens`). Read state was Celeste's own until
  2026-09-14; the provider's now counts too, see "Read elsewhere" below. The sub-category chips were removed from the header
  (operator: "remove the chips that start with needs reply"); the sorter's
  categories, the row tags and `?cat=` filtering remain, and the category
  editor is reachable only by URL (`?edit=1`) until a row is restored. The
  list pane holds rows only.
- **Assignment is by the sorter (2026-09-09, reversing the embeddings
  decision after a real-mail test)**: the same Haiku call that judges
  importance, category and finance also names the project, from the
  inbox's project list with descriptions, or none. Marginal cost is a few
  hundred cached tokens per message. Manual filings are never overwritten.
  The embedding pipeline (Ollama `nomic-embed-text`, sqlite-vec) stays in
  core for the later "ask your inbox" search, not for filing. Project lists
  can be proposed by a model from the mail itself (done once by hand for
  one inbox on 2026-09-09; the ten proposed projects replaced the
  starter six). Since 2026-09-10 this is a feature: "Propose projects" in
  the project editor (and `celeste projects propose`) has Sonnet read the
  inbox's senders, subjects and snippets and append 6–12 proposed rows,
  name and description, to the editor for the operator to edit and Save;
  nothing is written until Save. Re-file then runs the backlog sorter
  over the window. Any inbox may ask, empty or not; existing projects are
  shown to the model so it proposes what is missing.
- **Manual filing**: "Move to project…" on a thread files every message in
  the thread, with "Unfiled" and "New project…" in the picker.
- If Ollama is not running, sync still works; projects show a one-line
  setup hint instead of filing.

**Definition.** The operator owns the project list. The agent may propose
additions but never creates one on its own.

**Where it lives.** `projects.md` in the data dir, one section per project:

```markdown
## Northwind pilot
priority: high
description: 60-day staging pilot for Northwind, SOW signed September.
people: maya@northwind.co, priya@northwind.co
domains: northwind.co
keywords: pilot, SOW, staging
```

The app reads the file and may append two things: approved proposals and
sender hints learned from corrections. The operator can still open and edit
it in any editor. Project rows are mirrored into a `projects` table for
joins.

The initial list lives at `docs/projects.seed.md` in the repo: Robotics
research, Consulting (tutoring included), Immigration, Messaging agent,
Scheduling agent, Finance agent. All six are `priority: high`, so in
practice priority separates them from proposed projects, which start
`normal`.

**Bootstrap pass.** People and domains in the seed are blank by design. On
the first Phase 4 run, the agent scans stored mail, matches threads to
projects by description and keywords, and proposes a people and domains
list per project from the senders it found. The operator approves per
project on Triage, the same surface as new-project proposals. Nothing is
written to `projects.md` without approval.

**Granularity.** Thread-level. One primary project per thread, or none.
iMessage and WhatsApp conversations count as threads. Assigned when the
thread first gets a sort; re-evaluated only on correction.

**Mechanism.** Embedding similarity, no model call by default:

1. Each project's description, keywords, and hints are embedded (Ollama,
   same model as section 11a). Re-embedded when the file changes.
2. A thread's vector is the embedding of its subject plus latest message.
3. Best cosine match above the threshold wins. Below the threshold: none.
4. When the top two candidates are within a small margin, one haiku call
   breaks the tie. That is the only model call on this path.
5. Sender hints short-circuit: a sender listed under a project's `people`
   assigns that project without a similarity check.

**Uses.**

- Gmail label and Outlook category `agent/project/<name>`. Same
  unattended-label rule as section 4. Moving a thread between projects
  swaps the label.
- Inbox project filter and per-project view across all channels and
  accounts.
- The project's description and notes go into the draft prompt.
- Daily digest and follow-ups are sectioned by project (Phase 5).

**Priority.** Each project carries `priority: high | normal | low`. The
sorter prompt sees the assigned project and its priority, so "anything on
Northwind is important" is a field, not prose in the criteria file.

**Correction.** Reassigning a thread in the UI moves the label, writes a
`corrections` row with kind `project`, and appends the sender to the new
project's `people` list in `projects.md` so future threads from them match
without a similarity check. Nothing retroactive beyond that thread.

**Proposals.** Weekly, alongside the digest: cluster the vectors of threads
with no project. Any cluster of 4 or more threads becomes a proposal with a
haiku-written name and one-line description. Proposals appear on the
Triage screen showing the threads. The operator approves (appends to
`projects.md` and labels the threads), renames, or dismisses. A dismissed
cluster is remembered and not proposed again.

**UI.** The project shows as a chip in the queue card's meta line. Tapping
it opens a reassign picker. Proposals live on Triage next to trash and
follow-ups.

## 10e. Actionables into Alex

Decided in a grilling session on 2026-09-06. Ships with Phase 5, after
the Alex read path exists.

**What.** Celeste hands three kinds of item to Alex through its private MCP
tier:

| Kind      | Alex tool           | Example                                              |
|-----------|---------------------|------------------------------------------------------|
| To-do     | `create_actionable` | "Send SOW PDF" on Friday, untimed or timed           |
| Reminder  | `set_reminder`      | "Confirm walkthrough with Maya" Thursday 9:00 AM     |
| Event     | `create_event`      | "Northwind walkthrough" Thu 2:00 to 2:20 PM, only once the thread has settled on a time |

Personal blocks are out of scope. Proposing times still uses the booking
link; `create_event` is for a slot the other side has already confirmed.
Alex's `create_event` has no attendees field, so the event lands on the
operator's calendar only. The reply is the invite.

**Sources.** Two, both from the same thread:

- Requests in the inbound message ("can you send the SOW by Friday").
- Commitments in the operator's reply ("PDF by end of day today").
  Detected from the final text at confirm time, so edits count.

**Detection.** The drafter's sonnet call returns the draft text plus a
structured list `{kind, title, dayISO, startISO?, endISO?, source}`. No
extra call for queue items. If the operator edits the draft, the list is
re-derived from the final text at confirm time with one further call.
Dates resolve in the operator's timezone; ambiguous ones ("next week")
resolve to the first plausible day and are shown for correction.

**Gate.** Nothing is written to Alex unattended. Items appear on the card
under the draft as "Also add to Alex", each a checkable line with an
editable title and day. The confirm panel lists checked items beside the
diff. One confirm, one undo window, then the send and the Alex writes
fire together. Skip with items checked offers "Add to Alex without
sending", which goes through the same confirm and undo.

**Failure.** If the send succeeds and an Alex write fails, the draft is
still sent. The item is marked failed on the thread with a retry button.
Every attempt, success or failure, is an `actions` row.

**Read-back.** Celeste stores Alex's returned id (`todoId`, `eventId`,
reminder id) in an `alex_items` table linked to the thread. The thread
shows each item with its status. `get_schedule` already returns timed
actionables and events, so those show done or upcoming. Untimed to-dos
show "added" until Alex gains a `get_actionables` read; that is a change
in the agentic-scheduling repo on the operator's list. Follow-up tracking
treats a done to-do as evidence the operator's side is complete.

**Not agent-to-agent.** Every Alex tool is deterministic code over its
database. Celeste calls them over HTTP after a human approval. No model
on either side talks to the other.

## 10f. Messages on this Mac (iMessage)

Decided 2026-09-11 with the operator: read and reply (B), a folder of its
own (A), one-to-one chats for the last 30 days then live (A), and the same
gate as mail (A).

- **Provider `imessage`**: one account, `email` = `messages:<handle Messages
  sends as>`, display name "Messages". Left out of the inbox switcher and
  the project bar; it has its own folder.
- **Reading**: `~/Library/Messages/chat.db` opened read-only with a busy
  timeout, never written. One-to-one chats only (`chat.style = 45`). Texts
  after the stored ROWID watermark, the first run 30 days back. The body
  comes from `attributedBody` (a typedstream: the bytes after `NSString`,
  `01 94 84 01 2B`, a length, then UTF-8); the `text` column when it has
  one. Attachment-only bubbles and tapbacks are skipped.
- **Names**: every address book file on this Mac is read, numbers matched
  on their last ten digits, and the names cached in `contacts`. A chat's
  subject is the contact's name, or the handle.
- **Storage**: a chat is a thread (`providerThreadId` = chat guid); a text
  a message in folder `messages` with `isFromOperator = is_from_me`,
  `rfcMessageId` = the text's guid, no HTML, no Cc. Attachments keep the
  file's path on this Mac as their provider id and are read on first open.
- **Folder**: Messages, with Need to reply and Unopened, at `/messages`;
  the list shows one row per chat; the thread page shows the chat as
  bubbles with Reply with Celeste, Mark handled, Delete and Move to
  project. Delete deletes the conversation in Messages.app too (operator,
  2026-09-11: "the messages on the phone are still there"): Messages has
  no AppleScript command for it, so the app is driven, in one script, by
  System Events: activate, open the chat by its `imessage:` URL, choose
  Delete Conversation… from the Conversation menu, press Delete on the
  "Delete from all your devices?" sheet, never Delete and Report Spam. The
  chat goes to Messages' Recently Deleted for thirty days and, with
  Messages in iCloud on, leaves the phone. The chat is opened once first
  and the window's title checked against the handle, the contact's name
  and Messages' own name for the chat, so a link that lands elsewhere
  never has another conversation deleted. chat.db is then read for a few
  seconds until the chat holds no texts; an RCS chat keeps empty card rows,
  so a confirmed Delete stands either way. A chat Messages would not
  delete stays on screen and counts as failed. The first run makes macOS ask, once, for
  Accessibility. Put back and Undo restore the chat in Celeste alone;
  Messages' own Recently Deleted is where it is recovered by hand.
  Beside Delete (a trash can) a chat and a mail thread have Hide (an eye),
  on the row and on the thread (operator, 2026-09-11): the thread leaves
  Celeste for Deleted items and stays in its app or mailbox, a `hide`
  action remembering the folder it came from; Put back and Undo bring it
  back there without asking the provider for a move that never happened.
  Shift or the = key hides the open thread; Mark handled left the action
  row (operator, 2026-09-11), Hide taking its place and its key. A hidden thread comes back by itself
  when the other side writes again (operator, 2026-09-11); a deleted one
  does not.
- **Live** (operator, 2026-09-11: "when I get a new message, Need to
  reply should indicate"): while the tab is in view the app pulls mail
  and chats every three minutes, and every three seconds (ten until
  2026-09-14) asks `/api/pulse`
  for the newest moment anything was stored; when that moves, from this
  sync or any other, the page reads itself again, so the tree's counts and
  the open list move on their own. A row that arrived since the operator
  last looked at that list wears a New tag until it is opened; "last
  looked" is kept in the browser per list, a visit ending after a minute
  out of sight.
- **The moment a text lands** (operator, 2026-09-14: "the message syncing
  is not immediate"; a text could wait three minutes for the clock, and
  forever with no tab open): the server watches the folders holding
  `chat.db` and `ChatStorage.sqlite`, started once from
  `instrumentation.ts` when the app comes up. A change to the database or
  its `-wal` is a text having arrived; a burst of writes becomes one sync a
  second after it settles, and a write during a sync one more sync after
  it (`ChangeTrigger`). That sync covers the accounts of the one chat
  provider whose file moved, through the connector alone: no sorter, no
  drafter, no revalidation, and it queues behind a full sync in flight so
  no account is synced twice at once. The page's pulse then shows the text
  within three seconds. Mail has no file to watch and stays on the clock.
- **Need to reply** is a rule, not a verdict (operator, 2026-09-11: the
  local sorter called a friend's text "no reply needed"): the other person
  had the last word and nobody has marked the chat handled. Texts are not
  sorted at all. The automatic drafter never drafts a text; Reply with
  Celeste does, with a text flavour: one to three short sentences, no
  greeting, no sign-off.
- **Safe to delete** is a rule too (operator, 2026-09-11): the handle has
  no name in the address book and the operator never wrote back, so codes,
  deliveries, promos and short codes, never a friend. The window narrows
  this row like every other (operator, 2026-09-13, after a 7-day header
  over a list reaching back to February); All clears everything. Delete
  all on it deletes every chat it lists, through the same gate with Undo.
- **Typing a text**: a box under the newest bubble, the Ask panel's pill
  with an arrow; Enter sends, at once, through a draft row of the
  operator's own (`model = operator`) so Sent history and the send path
  stay one. Opening a chat lands at the box.
- **Sending**: the card has one recipient and no Cc, subject or files;
  the preview says Send this text; the text goes the moment Send is pressed,
  with no six seconds and no Undo (operator, 2026-09-11); then `osascript` tells Messages.app to send to the handle on iMessage or SMS
  (RCS goes as SMS). The text Messages writes is matched by chat and body
  to give the draft its sent id; failing that a local id until the next
  sync. iMessage has no unsend. The first send makes macOS ask, once,
  whether the app may control Messages.
- **History**: all of it (operator, 2026-09-11, after a password sent in
  May sat outside the 30-day window): a connect reaches the whole of
  chat.db, and a backfill reaches back for an account connected earlier.
  Chats never backfill on demand from the "All" window (a whole history
  inside the page's server blocked it for minutes); a backfill pauses
  between pages and reads before it writes, so the app's own writes get
  the lock in between.
- **Reading a long chat**: the newest 120 texts show; "Show earlier · N
  more" reveals a page at a time and the reader's place holds. An iPhone
  photo (HEIC) previews as a 2000px JPEG made by the Mac's sips; the
  download stays the original.
- **Out of this phase**: group chats, reactions, edits and unsends,
  sending attachments.

## 10g. WhatsApp on this Mac

Decided 2026-09-11 with the operator: the native Mac app, like iMessage
(A); one-to-one chats and groups, both fully; inside the Messages folder,
mixed with iMessage; groups reach Need to reply only when a message
mentions the operator; Delete on a group clears the chat and stays in it.

- **Provider `whatsapp`**: one account, `email` = `whatsapp:<own number>`
  (the number is encrypted in WhatsApp's preferences, but the member
  present in the most groups is the operator, and `ZWAZACCOUNT` pairs it
  with the operator's LID), display name "WhatsApp". Left out of the
  inbox switcher and the project bar, like Messages.
- **Reading**: `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`
  opened read-only with a busy timeout, never written. Sessions of type 0
  (one-to-one) and 1 (groups); status, broadcast and community rows are
  skipped. Messages after the stored `Z_PK` watermark, the first run 30
  days back. Text messages (type 0) and media captions come through;
  media-only rows and group events (type 6) are skipped. A media file, when
  WhatsApp has it, sits under `Message/` + the item's local path and is
  read on first open.
- **Names**: the session's partner name for a one-to-one chat, the group's
  name for a group; in a group the sender line is the member's push name
  from `ZWAPROFILEPUSHNAME`, or the handle.
- **Storage**: a chat is a thread (`providerThreadId` = the session's JID);
  a message lives in folder `messages` with `isFromOperator` from
  `ZISFROMME`, `rfcMessageId` = `ZSTANZAID`, no HTML, no Cc. Rows and
  bubbles carry a small WhatsApp mark so a chat says which app it came
  from.
- **Rules**: for one-to-one chats the same as iMessage: Need to reply when
  the other person had the last word and nobody marked it handled; Safe to
  delete when the handle has no name and the operator never wrote back. A
  group needs a reply when its newest message mentions the operator (the
  text carries `@<own LID>`, the LID found as the member present in every
  group) and it is not handled. Groups are never Safe to delete.
- **Sending**: the same compose box, Reply with Celeste and instant send.
  WhatsApp has no scripting dictionary: a one-to-one send opens
  `whatsapp://send?phone=<number>&text=<text>`, checks the Chat menu's
  "Block <name>" item names that person, then clicks the menu's Send. A
  group is opened by name through WhatsApp's Search. Every send is
  confirmed by reading the sent text back from ChatStorage within a few
  seconds; nothing found means the send failed and the draft stays.
- **Deleting**: the Chat menu's Delete chat for a one-to-one chat, Clear
  chat for a group, the confirmation sheet's button, the same name guard,
  and the database read afterwards until the chat is gone or empty. Undo
  restores in Celeste only.
- **History**: all of it, as for Messages.
- **Out of this phase**: sending attachments, reactions, edits, status,
  communities.

## 10i. Ask Celeste sees the chats

Operator, 2026-09-11: "Celeste not having access to my messages". Search
always indexed every stored message, texts included, but Celeste was told
she saw only mail, her hits did not say which app they came from, and her
list tool could not open the Messages folder. Now: the system prompt names
Messages (iMessage) and WhatsApp as hers to search; every search hit and
list row carries a `channel` (mail, imessage, whatsapp) and a chat hit's
subject reads "WhatsApp chat: <name>"; `search_inbox` takes `channel` to
stay inside one app; `list_mail` takes folder `messages`; a hit in Deleted
items says so.

## 10h. Sign in with Google

For a Gmail or Workspace account that cannot make an app password (the
operator's school disables 2-Step Verification; decided 2026-09-11 after a
throwaway probe showed Google grants the token and Gmail's IMAP accepts
it). The Inboxes page's Gmail step offers Sign in with Google beside the
app password. The flow mirrors Microsoft's: `/api/oauth/google/start`
(PKCE, state in a cookie, scopes `https://mail.google.com/` and `email`,
offline access with consent), `/api/oauth/google/callback`, tokens in
`oauth_tokens`. The account is filed as the same Gmail IMAP inbox with no
password row; the token store is what says it signs in with Google, and
the IMAP and SMTP clients ask for a fresh token at each connect. The
Google client stays in Testing mode, so a sign-in lasts seven days; when
the refresh is refused the inbox reads needs sign-in with a Reconnect
through Google, as an Outlook inbox does.

## 11. Storage and secrets

- SQLite file via Drizzle. Tables: `accounts`, `messages`, `threads`,
  `sorts`, `drafts`, `actions`, `corrections`, `sent_cache`, `oauth_tokens`,
  `watermarks`, `summaries`, `digests`, `attachments`, `chunks`, `projects`,
  `project_proposals`, `alex_items`.
- FTS5 virtual table over message bodies and attachment text.
- sqlite-vec virtual table over chunk embeddings. Same file, joins work.

### Data kept for future personalization

The operator intends to train a model on this data later. Three rules
protect that:

- **Draft diffs.** Every draft row keeps the original model text, the final
  sent text, and every regenerate instruction the operator typed. "Edited"
  alone is not enough; the diff is the signal.
- **Append-only actions.** The `actions` table is never updated or deleted.
  Every queue action is a new row with a timestamp.
- **JSONL export.** A CLI command dumps messages, threads, sorts, drafts,
  actions, and corrections as newline-delimited JSON. Training starts from
  that file, never from the live database.
- Anthropic API key, `MICROSOFT_CLIENT_ID`, and Alex `MCP_TOKEN` in `.env`
  (gitignored).
- **Operator aliases (2026-09-09)**: an "Also you" list on the Inboxes
  page, `operator_aliases` table. A message is the operator's when its
  sender is a connected inbox address or an alias (or a known relay whose
  display name is one). Such mail is drawn on the right in threads, never
  sorted or drafted for. Saving the list re-stamps stored mail.
- Microsoft OAuth refresh tokens in the `oauth_tokens` table; IMAP app
  passwords in the `mail_credentials` table.
- Microsoft OAuth flow: public client with PKCE through the app's own
  loopback callback.

## 11a. Attachments and embeddings

The operator wants search and drafting to understand PDFs and images, and
wants the raw files kept for future training.

**Which attachments**: tiny inline images under 20 KB (signatures, tracking
pixels) are skipped. Everything else gets an `attachments` row at sync. Bytes:
IMAP delivers the whole RFC822 source at sync, so the blob is written then for
every kept attachment, important or not (disk is the only cost). Outlook
delivers metadata only; its bytes are fetched on demand the first time the
operator opens or downloads the file, and cached on disk from then on. The
same on-demand path backfills mail synced before blobs existed. Extraction
and embedding (below) run only for messages sorted important.

**Viewing (2026-09-07)**: the thread view shows one chip per attachment with
name, size and a download link. Images and PDFs preview inline (PDF in an
embedded viewer); every other type is download-only and is always served as
`application/octet-stream` with a `Content-Disposition: attachment`, so an
HTML or SVG attachment can never execute inside the app's origin. The files
the operator attaches to a draft (section 8) are served by a second route
under the same rules and the same allowlist, so a PDF on the way out reads
the same as one that arrived. Both routes are left out of the app's own
Content-Security-Policy and state their own per response: the page policy
blanks out Chrome's built-in PDF viewer.

**Where bytes live**: files on disk at `~/messaging-agent/blobs/<sha256>`.
An `attachments` row holds the path, filename, MIME type, size, and the
message it came from. Not in SQLite BLOB columns, not in object storage.

**Extraction**, all local:

| Type          | Method                                                        |
|---------------|---------------------------------------------------------------|
| PDF with text | `pdf-parse` (npm, no binary)                                  |
| Scanned PDF   | Rasterize pages, then the vision model below                  |
| Image         | Local vision model via Ollama (e.g. `moondream` or `llava`): OCR plus a one-line caption |
| Other         | Filename only                                                 |

**Chunking**: extracted text and message bodies split into roughly
500-token chunks with 50-token overlap, stored in `chunks`, indexed in FTS5.

**Embedding**: local model via Ollama (e.g. `nomic-embed-text`). Every chunk
of every message and processed attachment is embedded at sync time and stored
in sqlite-vec. Nothing leaves the Mac for embedding or OCR.

**Why not a separate vector database**: it would hold vectors and a little
metadata, not files. Structured data still needs transactions, joins, and
migrations, which vector stores do not have. Two stores means two writes per
message and a consistency failure mode. sqlite-vec puts the vectors in the
same file as the rows they describe.

**Cost model**: Ollama runs on the Mac's CPU/GPU continuously inside the
daemon. Inbound mail volume, not operator usage, drives compute.

## 12. Stack

- TypeScript.
- Next.js PWA for the app.
- Daemon process (Node) running sync, sort, draft, digest, and serving the
  app. Installed as a launchd agent.
- Core library as a package with no framework imports.
- Models behind one thin `ModelProvider` seam (2026-09-10, operator chose
  this over LangChain): adapters for Anthropic (`@anthropic-ai/sdk`, no
  gateway) and Ollama (local). Each role — sorter, drafter, chat — names its
  model as `provider:model` in config, overridable by environment, so a
  local model such as `ollama:qwen3:8b` can stand in for a Claude model
  without code changes. An eval harness replays stored mail through two
  models and reports agreement, latency and cost (section 13).
- Ollama for embeddings and image OCR, local only.
- `sqlite-vec` loadable extension for vector search.

## 13. Measurement

What the operator does is the first measure. The `actions` table yields a
weekly number:

- Percent of drafts sent unedited.
- Percent of important flags the operator overrode.

Choosing between two models needs a second one, because those numbers arrive
a week late and only for the model that shipped. `celeste eval sort` replays
a sample of already-sorted mail through two or more models and stores what
each said in `eval_runs` and `eval_results`. It never writes to `sorts`: the
verdict the operator lives with stays where it is, and the baseline is copied
into the run so a later re-sort cannot move the target.

The report says, per model: agreement with the baseline on important,
needs_reply, finance, disposable, category and project; agreement between the models;
mean latency; tokens; and a cost estimated from list prices, which is an
order of magnitude and not a bill. Local models cost nothing per token.
Agreement is counted over the messages both sides answered, so a model that
failed half its calls does not read as half as good as one that answered.

The third measure is what all of it costs (2026-09-11). Every role talks to
a model through the one `ModelProvider` seam, so a wrapper there writes a
`model_calls` row for every request that seam sends: when, which job, which
model, the tokens in and out, the cache tokens read and written, the latency
and an estimated cost. A call that threw is a row too, with the reason and
no tokens. The tool loop behind Ask Celeste writes one row per request it
makes, not one per question, because the bill is for the requests. The local
embedder writes a row per batch with no token counts, since Ollama reports
none, and a cost of zero. Nothing bypasses the ledger: sorting on either
model, drafting and revising, Ask Celeste, distilling rules, proposing
projects and an eval run all pass through it, each under its own job name
even when several share the drafter's model.

The `/usage` page reads that table over a window the operator picks: cost,
calls and tokens as four tiles, then what each model was asked, what each
job spent, and a bar per day. `celeste usage --since 7d` prints the totals
and the by-model table from the same summary, so the page and the terminal
cannot disagree. Prices are Anthropic's list prices, copied by hand and
never automatically current: a cache read is billed at 10% of an input token
and a cache write at 125%. A local model costs nothing, and a model with no
row in the price table reads as unknown rather than free.

The page also says what each conversation with Celeste cost, and the Ask
panel says it where the conversation is: a line under the open
conversation's name and a figure on every History row. A conversation is
listed by what it is about — a thread's by its mail, and a General one by
the first question asked in it, cut where the row ends. Those numbers come
from the ledger rows carrying the conversation's own id, and for conversations older
than the ledger from the tokens each stored answer recorded, which is marked
as an estimate because a stored turn knows nothing about the prompt cache.

## 14. Git

- The messaging-agent repository. This name previously
  redirected to `agentic_os`; the redirect is now broken on purpose.
- Commit per completed step on `main`.
- Push only when the operator says push.

## 15. Reference files in Agentic_OS worth reading before rewriting

- `kernel/src/oauth.ts`: loopback PKCE flow.
- `kernel/src/mail.ts`, `kernel/src/mailwatch.ts`: Gmail and Graph
  normalization, `history.list` and `/messages/delta`.
- `kernel/src/messages.ts`, `kernel/src/blocklist.ts`: chat.db and WhatsApp
  SQL with blocklist inside the query.
- `kernel/src/text-reply.ts`: AppleScript send and WhatsApp URL scheme.
- `kernel/src/text-delete.ts`, `kernel/src/trash.ts`: title-gated conversation
  delete and mail trash.
- `spawner/src/airlock.ts`: the tool-less summarizer idea.

Do not copy their signatures. They carry the kernel's message envelopes.

## 16. Open items owned by the operator

- Obsidian contacts convention.
- Full Disk Access and Automation permissions before first run.
- Install Tailscale.app on the Mac and the phone. A CLI shim exists at
  `/usr/local/bin/tailscale` but the app is missing.
- Install Ollama and pull an embedding model and a vision model. Not
  installed today. `tesseract` is present at `/opt/homebrew/bin` as a
  fallback OCR if the vision model is too slow.
- Add a `get_actionables` private tool to Alex so Celeste can read the
  status of untimed to-dos (section 10e).
