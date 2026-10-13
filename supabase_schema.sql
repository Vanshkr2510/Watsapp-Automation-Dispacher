-- ========================================================
-- Supabase Schema: WhatsApp Automation (Contacts Only)
-- Only Name and Phone are stored permanently.
-- Message text and templates are NOT stored in the database.
-- ========================================================

-- 1. Create contacts table
CREATE TABLE IF NOT EXISTS public.contacts (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  group_name TEXT DEFAULT 'General',
  is_sent BOOLEAN DEFAULT FALSE,
  last_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Create index for fast phone lookup
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON public.contacts (phone);
CREATE INDEX IF NOT EXISTS idx_contacts_group ON public.contacts (group_name);

-- 3. Enable Supabase Realtime (Instant Live Updates across devices)
ALTER PUBLICATION supabase_realtime ADD TABLE public.contacts;

-- 4. Enable Row Level Security (RLS) with public access policy
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on contacts"
  ON public.contacts
  FOR SELECT
  TO anon, authenticated
  USING (true);

CREATE POLICY "Allow public insert and update on contacts"
  ON public.contacts
  FOR ALL
  TO anon, authenticated
  USING (true)
  WITH CHECK (true);

