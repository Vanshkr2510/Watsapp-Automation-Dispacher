const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

let supabase = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log('✅ Supabase Client initialized for Realtime Contacts sync');
  } catch (err) {
    console.error('❌ Failed to initialize Supabase client:', err.message);
  }
}

function isSupabaseConfigured() {
  return !!supabase;
}

function getSupabaseConfig() {
  return {
    isConfigured: !!supabase,
    url: SUPABASE_URL,
    anonKey: SUPABASE_ANON_KEY
  };
}

/**
 * Permanently upserts ONLY Name, Phone, and Group into Supabase 'contacts' table.
 * Message text and templates are NOT saved to Supabase (temporary only).
 */
async function syncContactsToSupabase(leads) {
  if (!supabase) return { synced: false, count: 0 };

  const records = leads
    .filter(l => l.phone)
    .map(l => ({
      name: l.name || 'Unknown',
      phone: String(l.phone).replace(/\D/g, ''),
      group_name: l.group || 'General',
      is_sent: !!l.isSent,
      last_sent_at: l.isSent ? new Date().toISOString() : null,
      updated_at: new Date().toISOString()
    }));

  if (records.length === 0) return { synced: true, count: 0 };

  try {
    const { data, error } = await supabase
      .from('contacts')
      .upsert(records, { onConflict: 'phone', ignoreDuplicates: false })
      .select('phone, is_sent');

    if (error) {
      console.warn('Supabase upsert warning:', error.message);
      return { synced: false, error: error.message };
    }

    return { synced: true, count: data ? data.length : records.length };
  } catch (err) {
    console.error('Error syncing contacts to Supabase:', err.message);
    return { synced: false, error: err.message };
  }
}

/**
 * Updates is_sent status for a specific phone number in Supabase
 */
async function markContactSentInSupabase(cleanPhone) {
  if (!supabase || !cleanPhone) return false;

  try {
    const { error } = await supabase
      .from('contacts')
      .update({
        is_sent: true,
        last_sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('phone', cleanPhone);

    if (error) console.warn('Supabase mark sent error:', error.message);
    return !error;
  } catch (err) {
    console.error('Supabase mark sent failed:', err.message);
    return false;
  }
}

/**
 * Resets is_sent status for all contacts in Supabase
 */
async function resetSentStatusInSupabase() {
  if (!supabase) return false;

  try {
    const { error } = await supabase
      .from('contacts')
      .update({
        is_sent: false,
        last_sent_at: null,
        updated_at: new Date().toISOString()
      })
      .neq('phone', '');

    return !error;
  } catch (err) {
    console.error('Supabase reset sent failed:', err.message);
    return false;
  }
}

/**
 * Fetches permanent contacts from Supabase
 */
async function fetchContactsFromSupabase() {
  if (!supabase) return null;

  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, phone, group_name, is_sent, last_sent_at')
      .order('id', { ascending: true });

    if (error) throw error;
    return data;
  } catch (err) {
    console.error('Error fetching from Supabase:', err.message);
    return null;
  }
}

module.exports = {
  isSupabaseConfigured,
  getSupabaseConfig,
  syncContactsToSupabase,
  markContactSentInSupabase,
  resetSentStatusInSupabase,
  fetchContactsFromSupabase
};

