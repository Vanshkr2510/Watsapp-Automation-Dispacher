const { Pool } = require('pg');
require('dotenv').config();

const {
  isSupabaseConfigured,
  syncContactsToSupabase,
  markContactSentInSupabase,
  resetSentStatusInSupabase,
  fetchContactsFromSupabase
} = require('./supabaseClient');

const POSTGRES_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || '';

let pgPool = null;
let isPgReady = false;

if (POSTGRES_URL) {
  try {
    pgPool = new Pool({
      connectionString: POSTGRES_URL,
      ssl: POSTGRES_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    console.log('🔌 Connecting to Vercel Postgres / Neon database...');
    initPgSchema().then(() => {
      console.log('✅ Vercel Postgres schema initialized successfully!');
      isPgReady = true;
    }).catch(err => {
      console.warn('⚠️ Vercel Postgres initialization notice:', err.message);
    });
  } catch (err) {
    console.error('Failed to create PostgreSQL pool:', err.message);
  }
}

/**
 * Automatically creates the contacts table if it does not exist
 * Note: Only Name and Phone are stored. No text or templates.
 */
async function initPgSchema() {
  if (!pgPool) return;
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS contacts (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      group_name TEXT DEFAULT 'General',
      is_sent BOOLEAN DEFAULT FALSE,
      last_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts (phone);
  `;
  await pgPool.query(createTableQuery);
}

/**
 * Returns current active database provider
 */
function getDatabaseStatus() {
  if (POSTGRES_URL && (isPgReady || pgPool)) {
    return {
      provider: 'vercel_postgres',
      name: 'Vercel Postgres (Neon)',
      isConnected: true,
      hasRealtime: false
    };
  }
  if (isSupabaseConfigured()) {
    return {
      provider: 'supabase',
      name: 'Supabase Database',
      isConnected: true,
      hasRealtime: true
    };
  }
  return {
    provider: 'local',
    name: 'Local In-Memory Mode',
    isConnected: false,
    hasRealtime: false
  };
}

/**
 * Permanently stores ONLY Name and Phone in the database
 * Templates and message text are NOT stored (ephemeral only)
 */
async function syncContactsToDatabase(leads) {
  const status = getDatabaseStatus();

  if (status.provider === 'vercel_postgres' && pgPool) {
    const validLeads = leads
      .filter(l => l.phone)
      .map(l => ({
        name: l.name || 'Unknown',
        phone: String(l.phone).replace(/\D/g, ''),
        group: l.group || 'General',
        isSent: !!l.isSent
      }));

    if (validLeads.length === 0) return { synced: true, count: 0 };

    let successCount = 0;
    for (const lead of validLeads) {
      try {
        const query = `
          INSERT INTO contacts (name, phone, group_name, is_sent, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (phone) DO UPDATE
          SET name = EXCLUDED.name, group_name = EXCLUDED.group_name, updated_at = NOW();
        `;
        await pgPool.query(query, [lead.name, lead.phone, lead.group, lead.isSent]);
        successCount++;
      } catch (e) {
        console.warn(`Failed to upsert contact ${lead.phone}:`, e.message);
      }
    }
    return { synced: true, count: successCount, provider: 'vercel_postgres' };
  }

  if (status.provider === 'supabase') {
    return await syncContactsToSupabase(leads);
  }

  return { synced: false, count: 0, provider: 'local' };
}

/**
 * Updates is_sent status for a specific phone number
 */
async function markContactSentInDatabase(cleanPhone) {
  const status = getDatabaseStatus();

  if (status.provider === 'vercel_postgres' && pgPool) {
    try {
      await pgPool.query(
        `UPDATE contacts SET is_sent = true, last_sent_at = NOW(), updated_at = NOW() WHERE phone = $1`,
        [cleanPhone]
      );
      return true;
    } catch (e) {
      console.warn('Vercel Postgres mark sent error:', e.message);
      return false;
    }
  }

  if (status.provider === 'supabase') {
    return await markContactSentInSupabase(cleanPhone);
  }

  return true;
}

/**
 * Resets is_sent status for all contacts
 */
async function resetSentStatusInDatabase() {
  const status = getDatabaseStatus();

  if (status.provider === 'vercel_postgres' && pgPool) {
    try {
      await pgPool.query(`UPDATE contacts SET is_sent = false, last_sent_at = NULL, updated_at = NOW()`);
      return true;
    } catch (e) {
      console.warn('Vercel Postgres reset error:', e.message);
      return false;
    }
  }

  if (status.provider === 'supabase') {
    return await resetSentStatusInSupabase();
  }

  return true;
}

/**
 * Fetches permanent contacts from active database
 */
async function fetchContactsFromDatabase() {
  const status = getDatabaseStatus();

  if (status.provider === 'vercel_postgres' && pgPool) {
    try {
      const res = await pgPool.query(
        `SELECT id, name, phone, group_name, is_sent, last_sent_at FROM contacts ORDER BY id ASC`
      );
      return res.rows;
    } catch (e) {
      console.warn('Vercel Postgres fetch error:', e.message);
      return null;
    }
  }

  if (status.provider === 'supabase') {
    return await fetchContactsFromSupabase();
  }

  return null;
}

module.exports = {
  getDatabaseStatus,
  syncContactsToDatabase,
  markContactSentInDatabase,
  resetSentStatusInDatabase,
  fetchContactsFromDatabase
};
