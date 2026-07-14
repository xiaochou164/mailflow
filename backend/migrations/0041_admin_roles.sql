ALTER TABLE users
  ADD COLUMN IF NOT EXISTS admin_roles TEXT[] NOT NULL DEFAULT ARRAY[]::text[];

CREATE INDEX IF NOT EXISTS idx_users_admin_roles
  ON users USING GIN (admin_roles);
