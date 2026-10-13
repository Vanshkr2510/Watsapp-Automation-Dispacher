const { parse } = require('csv-parse/sync');

/**
 * Extracts Google Sheet ID and gid from various Google Sheets URL formats
 */
function parseGoogleSheetUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') return null;
  const trimmed = inputUrl.trim();

  // If it's already a direct published CSV link
  if (trimmed.includes('pub?output=csv') || trimmed.includes('/export?format=csv')) {
    return { exportUrl: trimmed, sheetId: null, gid: null };
  }

  // Check for standard Google Sheet URL: https://docs.google.com/spreadsheets/d/<ID>/...
  const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const sheetId = idMatch ? idMatch[1] : (trimmed.match(/^[a-zA-Z0-9-_]{20,}$/) ? trimmed : null);

  if (!sheetId) return null;

  // Extract gid (tab id) if present
  let gid = '0';
  const gidMatch = trimmed.match(/[?&#]gid=([0-9]+)/);
  if (gidMatch && gidMatch[1]) {
    gid = gidMatch[1];
  }

  const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  return { exportUrl, sheetId, gid };
}

/**
 * Normalizes column keys to standard names
 */
function normalizeKey(header) {
  return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Maps raw CSV row objects into structured lead records
 */
function normalizeLeadRow(row, index) {
  const normalizedRow = {};
  for (const [key, val] of Object.entries(row)) {
    const cleanKey = normalizeKey(key);
    normalizedRow[cleanKey] = (val != null ? String(val).trim() : '');
  }

  // Find keys containing keywords if exact match not found
  const findValue = (keywords) => {
    for (const kw of keywords) {
      if (normalizedRow[kw]) return normalizedRow[kw];
    }
    for (const [k, v] of Object.entries(normalizedRow)) {
      if (keywords.some(kw => k.includes(kw)) && v) return v;
    }
    return '';
  };

  const name =
    findValue(['name', 'fullname', 'customername', 'leadname', 'clientname', 'customer', 'client', 'person']) ||
    `Lead #${index + 1}`;

  const phone =
    findValue(['phone', 'phonenumber', 'mobile', 'mobilenumber', 'whatsapp', 'contactnumber', 'contact', 'cell', 'tel']);

  const orderId =
    findValue(['orderid', 'order', 'orderno', 'order#', 'ticket', 'bookingid', 'ref', 'id']);

  const status =
    findValue(['status', 'orderstatus', 'deliverystatus', 'stage', 'state']);

  const time =
    findValue(['time', 'slot', 'scheduledtime', 'appointmenttime', 'appointment', 'date', 'datetime']);

  const template =
    findValue(['template', 'templatekey', 'tpl', 'templatename', 'msgtype']);

  const customMessage =
    findValue(['message', 'custommessage', 'customtext', 'text', 'notes', 'msg']);

  // Build variables dictionary for any column in the sheet
  const variables = {};
  for (const [key, val] of Object.entries(row)) {
    const rawKey = key.trim();
    const cleanKey = normalizeKey(key);
    variables[rawKey] = val != null ? String(val).trim() : '';
    variables[cleanKey] = val != null ? String(val).trim() : '';
  }

  // Standard template variables shorthand
  variables['name'] = name;
  variables['phone'] = phone;
  variables['orderId'] = orderId;
  variables['status'] = status;
  variables['time'] = time;

  return {
    id: index + 1,
    name,
    phone,
    orderId,
    status,
    time,
    template,
    customMessage,
    variables,
    raw: row
  };
}

/**
 * Fetches and parses a Google Sheet by URL or ID
 */
async function fetchGoogleSheetData(sheetUrlOrId) {
  const parsed = parseGoogleSheetUrl(sheetUrlOrId);
  if (!parsed) {
    throw new Error('Invalid Google Sheet URL or ID. Please paste a valid docs.google.com/spreadsheets link.');
  }

  const response = await fetch(parsed.exportUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WhatsAppAutomation/1.0',
      'Accept': 'text/csv,text/plain,*/*'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Google Sheet not found (404). Please check the URL.`);
    }
    if (response.status === 403 || response.status === 401) {
      throw new Error(
        `Google Sheet is private. In Google Sheets, click "Share" (top-right) and change General access to "Anyone with the link can view".`
      );
    }
    throw new Error(`Failed to fetch Google Sheet: HTTP ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();

  // If Google returned an HTML login page instead of CSV
  if (text.trim().startsWith('<!DOCTYPE html>') || text.includes('accounts.google.com') || contentType.includes('text/html')) {
    throw new Error(
      `Permission denied: Google Sheet is not publicly viewable. Please open the Google Sheet, click "Share", and change General Access to "Anyone with the link can view".`
    );
  }

  if (!text.trim()) {
    throw new Error('The Google Sheet is empty. Please add header columns and data rows.');
  }

  // Parse CSV
  let records;
  try {
    records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true
    });
  } catch (parseErr) {
    throw new Error(`Failed to parse CSV data from Google Sheet: ${parseErr.message}`);
  }

  if (!records || records.length === 0) {
    throw new Error('No data rows found in the Google Sheet. Make sure row 1 has headers and row 2+ has data.');
  }

  const leads = records.map((row, idx) => normalizeLeadRow(row, idx));

  // Determine headers detected
  const headers = Object.keys(records[0] || {});

  return {
    leads,
    headers,
    totalCount: leads.length,
    exportUrl: parsed.exportUrl,
    sheetId: parsed.sheetId
  };
}

module.exports = {
  parseGoogleSheetUrl,
  fetchGoogleSheetData,
  normalizeLeadRow
};
