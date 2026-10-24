-- Outlet portal access table (added 2026-10-24 at Satvik's ask).
-- Each outlet gets its own URL slug + username + password so the branch
-- manager can log into opsdashboard.sukhnafoods.com/outlet-portal/?o=<slug>
-- (or a mapped nutriobox.com subdomain later) and only see their own
-- saved Ideal Inventory snapshots.
--
-- Passwords are stored as SHA-256(salt || password) with a per-row 16-byte
-- hex salt — enough for first iteration; upgrade to bcrypt later if the
-- threat model warrants. Allowed IP CIDRs stay optional (NULL = no IP
-- restriction) — populate once Satvik collects each outlet's static IPs.
--
-- Idempotent: safe to re-run. Seed rows use placeholder password "1122"
-- (same as the Variance approve placeholder); rotate via the UPDATE at
-- the bottom once real credentials are agreed.

CREATE TABLE IF NOT EXISTS outlet_portal_access (
  outlet_slug      TEXT PRIMARY KEY,
  outlet_name      TEXT NOT NULL,       -- the full "NutrioBox (Rajinder Nagar)" style name used in snapshots
  username         TEXT NOT NULL,
  password_salt    TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  allowed_ip_cidr  TEXT[],              -- optional IP allowlist; NULL = anywhere
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at    TIMESTAMPTZ,
  last_login_ip    TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS outlet_portal_access_username_idx ON outlet_portal_access (lower(username));
CREATE INDEX IF NOT EXISTS outlet_portal_access_outlet_name_idx ON outlet_portal_access (outlet_name);

-- Session log — one row per successful sign-in so Satvik can audit who
-- opened which portal from where. Rotation of old rows is a cron job for
-- later; the table stays small while we're at 10 outlets.
CREATE TABLE IF NOT EXISTS outlet_portal_sessions (
  id            BIGSERIAL PRIMARY KEY,
  outlet_slug   TEXT NOT NULL REFERENCES outlet_portal_access(outlet_slug) ON DELETE CASCADE,
  logged_in_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip            TEXT,
  user_agent    TEXT
);

CREATE INDEX IF NOT EXISTS outlet_portal_sessions_slug_idx ON outlet_portal_sessions (outlet_slug, logged_in_at DESC);

-- Seed the 10 outlets with placeholder password 1122. The salt is a fresh
-- 16-byte hex per row; the hash is SHA-256(salt || '1122') computed inline.
-- (Postgres' sha256 was added in pg17; use pgcrypto's digest() instead which
-- is already enabled on this project per inventory-orders-setup.sql.)
INSERT INTO outlet_portal_access (outlet_slug, outlet_name, username, password_salt, password_hash)
VALUES
  ('rajinder-nagar',     'NutrioBox (Rajinder Nagar)',     'rajinder-nagar',     encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('dlf-phase-2',        'NutrioBox (DLF Phase 2)',        'dlf-phase-2',        encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('sector-63-noida',    'NutrioBox (Sector 63 Noida)',    'sector-63-noida',    encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('dwarka',             'NutrioBox (Dwarka)',             'dwarka',             encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('janakpuri',          'NutrioBox (Janakpuri)',          'janakpuri',          encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('karkardooma',        'NutrioBox (Karkardooma)',        'karkardooma',        encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('noida',              'NutrioBox (Noida)',              'noida',              encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('prashant-vihar',     'NutrioBox (Prashant Vihar)',     'prashant-vihar',     encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('sector-15-gurugram', 'NutrioBox (Sector 15 Gurugram)', 'sector-15-gurugram', encode(gen_random_bytes(16), 'hex'), '__placeholder__'),
  ('shivalik',           'NutrioBox (Shivalik)',           'shivalik',           encode(gen_random_bytes(16), 'hex'), '__placeholder__')
ON CONFLICT (outlet_slug) DO NOTHING;

-- Now fix the placeholder hashes to SHA-256(salt || '1122'). Only touches
-- rows that still carry the placeholder, so re-running the migration
-- after real credentials are rotated in doesn't overwrite them.
UPDATE outlet_portal_access
   SET password_hash = encode(digest(password_salt || '1122', 'sha256'), 'hex')
 WHERE password_hash = '__placeholder__';

-- Rotation example (keep for Satvik's reference; comment out to run):
--   UPDATE outlet_portal_access
--      SET password_salt = encode(gen_random_bytes(16), 'hex'),
--          updated_at    = NOW()
--    WHERE outlet_slug = 'rajinder-nagar';
--   UPDATE outlet_portal_access
--      SET password_hash = encode(digest(password_salt || 'NEW_PASSWORD_HERE', 'sha256'), 'hex'),
--          updated_at    = NOW()
--    WHERE outlet_slug = 'rajinder-nagar';
