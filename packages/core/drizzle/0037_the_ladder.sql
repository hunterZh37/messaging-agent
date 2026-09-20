-- One rung instead of three booleans (operator, 2026-09-19).
--
-- `important`, `needs_reply` and `disposable` were independently settable and
-- could contradict each other: a message could be owed a reply and safe to
-- delete at the same time, and which list it appeared on depended on which
-- query asked first. `wants` is one value with a defined precedence, so the
-- contradiction cannot be written down.
--
-- reply    a person is waiting on the operator's words
-- action   something to do, with no reply expected
-- knowing  worth knowing, nothing to do
-- bin      never needed again once read
--
-- The table is rebuilt rather than altered so the old columns are gone rather
-- than merely unused, which is the point of the change.

create table sorts_new (
  message_id text primary key references messages(id),
  wants text not null,
  scheduling integer not null,
  category text,
  finance text not null default 'none',
  reason text not null,
  model text not null,
  labeled_at integer,
  created_at integer not null
);

-- Derived from what each row already holds, in the ladder's own order, so no
-- verdict is blank while the operator waits for a re-sort. A row that was
-- neither important nor disposable becomes `knowing`: nothing is moved to the
-- bin that was not already marked for it.
--> statement-breakpoint
insert into sorts_new (message_id, wants, scheduling, category, finance, reason, model, labeled_at, created_at)
select
  message_id,
  case
    when needs_reply = 1 then 'reply'
    when category = 'Action required' then 'action'
    when disposable = 1 then 'bin'
    else 'knowing'
  end,
  scheduling,
  category,
  finance,
  reason,
  model,
  labeled_at,
  created_at
from sorts;

--> statement-breakpoint
drop table sorts;
--> statement-breakpoint
alter table sorts_new rename to sorts;
