-- A standing instruction about one sender (operator, 2026-09-20).
--
-- Read before the model is asked, so a sender the operator has ruled on
-- costs nothing and cannot drift. Keyed by address alone: "never show me
-- this sender" is a fact about the sender, not about which mailbox they
-- wrote to.
create table sender_rules (
  from_address text primary key,
  wants text not null,
  created_at integer not null
);
