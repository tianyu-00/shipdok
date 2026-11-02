-- How many finished restores of an app are kept in its history, and a failed restore's red notice that was dismissed.
-- restore_history_keep: the newest finished (done or failed) restores kept per app; NULL = keep them all. Every app starts at 10.
-- dismissed_at: the administrator closed the notice about this failed restore (the restore itself stays in the list).
ALTER TABLE apps ADD COLUMN restore_history_keep integer DEFAULT 10 CHECK (restore_history_keep IS NULL OR restore_history_keep >= 1);
ALTER TABLE volume_restores ADD COLUMN dismissed_at timestamptz;
