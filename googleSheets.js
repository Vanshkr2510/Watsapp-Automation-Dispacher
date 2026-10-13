const { parse } = require('csv-parse/sync');

/**
 * Extracts Google Sheet ID and gid from various Google Sheets URL formats
 */
function parseGoogleSheetUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') return null;
  const trimmed = inputUrl.trim();

  // If it's already a direct published CSV link
  if (trimmed.includes('pub?output=csv') || trimmed.includes('/export?format=csv')) {
    const gidMatch = trimmed.match(/[?&#]gid=([0-9-]+)/);
    return {
      exportUrl: trimmed,
      sheetId: null,
      gid: gidMatch ? gidMatch[1] : '0'
    };
  }

  // Check for standard Google Sheet URL: https://docs.google.com/spreadsheets/d/<ID>/...
  const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const sheetId = idMatch ? idMatch[1] : (trimmed.match(/^[a-zA-Z0-9-_]{20,}$/) ? trimmed : null);

  if (!sheetId) return null;

  // Extract gid (tab id) if present
  let gid = '0';
  const gidMatch = trimmed.match(/[?&#]gid=([0-9-]+)/);
  if (gidMatch && gidMatch[1]) {
    gid = gidMatch[1];
  }

  const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
  return { exportUrl, sheetId, gid };
}

/**
 * Discovers all worksheets/tabs (names and gids) from Google Sheet htmlview
 */
async function fetchGoogleSheetTabs(sheetId) {
  if (!sheetId) return [{ name: 'Main Sheet', gid: '0' }];

  const htmlviewUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/htmlview`;
  try {
    const response = await fetch(htmlviewUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WhatsAppAutomation/1.0',
        'Accept': 'text/html,*/*'
      },
      redirect: 'follow'
    });

    if (!response.ok) {
      return [{ name: 'Main Sheet', gid: '0' }];
    }

    const html = await response.text();
    const tabs = [];

    // Pattern 1: items.push({name: "Tab Name", ... gid: "12345"})
    const itemRegex = /\{name:\s*"([^"]+)",[^}]*gid:\s*"([0-9-]+)"/g;
    let match;
    while ((match = itemRegex.exec(html)) !== null) {
      tabs.push({ name: match[1], gid: match[2] });
    }

    // Pattern 2: <li id="sheet-button-12345"><a href="#gid=12345">Tab Name</a>
    const liRegex = /<li id="sheet-button-([0-9-]+)"[^>]*><a[^>]*>([^<]+)<\/a>/g;
    while ((match = liRegex.exec(html)) !== null) {
      if (!tabs.some(t => t.gid === match[1])) {
        tabs.push({ name: match[2].trim(), gid: match[1] });
      }
    }

    if (tabs.length > 0) return tabs;
  } catch (err) {
    console.warn(`Could not discover tabs via htmlview (${err.message}). Defaulting to gid=0.`);
  }

  return [{ name: 'Main Sheet', gid: '0' }];
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
function normalizeLeadRow(row, index, tabName = 'Main Sheet') {
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
    `Contact #${index + 1}`;

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

  // Tab Name acts as the Group / Audience Segment!
  const group = tabName;

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
  variables['group'] = group;
  variables['tab'] = tabName;
  variables['orderId'] = orderId;
  variables['status'] = status;
  variables['time'] = time;

  return {
    id: index + 1,
    name,
    phone,
    group,
    tab: tabName,
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
 * Fetches and parses a specific tab from Google Sheet
 *
 * @param {string} sheetUrlOrId - Google Sheet link or ID
 * @param {string} [targetGid] - Specific tab/worksheet gid to load
 */
async function fetchGoogleSheetData(sheetUrlOrId, targetGid = null) {
  const parsed = parseGoogleSheetUrl(sheetUrlOrId);
  if (!parsed) {
    throw new Error('Invalid Google Sheet URL or ID. Please paste a valid docs.google.com/spreadsheets link.');
  }

  const activeGid = targetGid != null ? String(targetGid) : (parsed.gid || '0');
  const exportUrl = parsed.sheetId
    ? `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/export?format=csv&gid=${activeGid}`
    : parsed.exportUrl;

  // Discover all available tabs in this spreadsheet
  let tabs = [];
  if (parsed.sheetId) {
    tabs = await fetchGoogleSheetTabs(parsed.sheetId);
  } else {
    tabs = [{ name: 'Current Tab', gid: activeGid }];
  }

  // Find active tab display name
  const currentTab = tabs.find(t => String(t.gid) === activeGid) || tabs[0] || { name: 'Main Sheet', gid: activeGid };

  const response = await fetch(exportUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) WhatsAppAutomation/1.0',
      'Accept': 'text/csv,text/plain,*/*'
    },
    redirect: 'follow'
  });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Google Sheet or tab not found (404). Please check the URL.`);
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

  if (text.trim().startsWith('<!DOCTYPE html>') || text.includes('accounts.google.com') || contentType.includes('text/html')) {
    throw new Error(
      `Permission denied: Google Sheet is not publicly viewable. Please open the Google Sheet, click "Share", and change General Access to "Anyone with the link can view".`
    );
  }

  if (!text.trim()) {
    throw new Error(`The tab "${currentTab.name}" is empty. Please add header columns and data rows.`);
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
    throw new Error(`Failed to parse CSV from tab "${currentTab.name}": ${parseErr.message}`);
  }

  if (!records || records.length === 0) {
    throw new Error(`No contact rows found in tab "${currentTab.name}". Row 1 should have headers (Name, Phone...) and Row 2+ contacts.`);
  }

  const leads = records.map((row, idx) => normalizeLeadRow(row, idx, currentTab.name));
  const headers = Object.keys(records[0] || {});

  return {
    leads,
    headers,
    totalCount: leads.length,
    exportUrl,
    sheetId: parsed.sheetId,
    activeGid,
    currentTabName: currentTab.name,
    tabs
  };
}

module.exports = {
  parseGoogleSheetUrl,
  fetchGoogleSheetTabs,
  fetchGoogleSheetData,
  normalizeLeadRow
};
