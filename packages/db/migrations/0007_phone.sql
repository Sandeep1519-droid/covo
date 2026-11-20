-- Phase 3 M5: what Covo sent to your phone (Telegram), so each message goes out once and an approval
-- card can be updated (its buttons removed) once it's answered, on the phone or anywhere else.
CREATE TABLE phone_messages (
  kind        TEXT NOT NULL,      -- approval | finished | failed | review
  ref_id      TEXT NOT NULL,      -- the approval or run it's about
  chat_id     TEXT NOT NULL,
  message_id  INTEGER,            -- Telegram's id for the message, to edit the card later
  text        TEXT NOT NULL,      -- what was sent (short; never file contents)
  sent_at     INTEGER NOT NULL,
  closed_at   INTEGER,            -- the card was answered or expired, and its buttons removed
  PRIMARY KEY (kind, ref_id)
);
