-- Repair provisional thread_ids left by out-of-order message sync.
--
-- When a reply (B) is synced before its parent (A), computeThreadId assigns B a
-- provisional thread_id = A.message_id.  Later, A arrives with its own parent's
-- thread_id (T), so A.thread_id = T ≠ A.message_id.  B's provisional ID is now
-- wrong: it points at A, not at the true root T.
--
-- Walk the parent chain iteratively until every message's thread_id equals the
-- actual root.  Cap at 10 passes to avoid looping forever on malformed data.
DO $$
DECLARE
  updated_count INT;
  passes INT := 0;
BEGIN
  LOOP
    UPDATE messages m
    SET thread_id = parent.thread_id
    FROM messages parent
    WHERE m.account_id = parent.account_id
      AND m.thread_id  = parent.message_id
      AND m.thread_id IS DISTINCT FROM parent.thread_id
      AND parent.thread_id IS NOT NULL;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    EXIT WHEN updated_count = 0 OR passes >= 10;
    passes := passes + 1;
  END LOOP;
END;
$$;
