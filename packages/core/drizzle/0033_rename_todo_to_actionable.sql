-- The picker offers an actionable and an event, and no longer a reminder
-- (operator, 2026-09-16). "Actionable" is Alex's own word for the day-scoped
-- item its create_actionable tool writes, so the rows say that too.
UPDATE `alex_items` SET `kind` = 'actionable' WHERE `kind` = 'todo';
