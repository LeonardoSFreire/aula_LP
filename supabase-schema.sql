CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous inserts" ON leads
  FOR INSERT TO anon
  WITH CHECK (true);

CREATE POLICY "Allow service role to read" ON leads
  FOR SELECT TO service_role
  USING (true);
