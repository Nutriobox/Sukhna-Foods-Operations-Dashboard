-- =====================================================================
-- Ops Dashboard — extend Realtime to inventory_snapshots
-- Run ONCE in Supabase SQL Editor (project: lezcgmnmcpgbecqtuqsg).
-- After this, every open tool will receive a push within ~500 ms of any
-- inventory sync too (not just PM/BOM).
-- =====================================================================

-- 1. Add inventory_snapshots to the Realtime publication.
ALTER PUBLICATION supabase_realtime ADD TABLE public.inventory_snapshots;

-- 2. Allow the browser (anon role) to receive the pushed rows.
ALTER TABLE public.inventory_snapshots DISABLE ROW LEVEL SECURITY;

-- 3. Verify.
SELECT schemaname, tablename
  FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime'
   AND tablename IN ('costing_snapshots', 'inventory_snapshots')
 ORDER BY tablename;

SELECT relname, relrowsecurity
  FROM pg_class
 WHERE relname IN ('costing_snapshots', 'inventory_snapshots')
 ORDER BY relname;
