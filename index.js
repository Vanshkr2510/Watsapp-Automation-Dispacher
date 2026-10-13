const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { fetchGoogleSheetData } = require('./googleSheets');

const app = express();
const PORT = process.env.PORT || 1212;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const SAMPLE_CSV = path.join(__dirname, 'sample_leads.csv');

app.use(express.json());

// Load or initialize config
function loadConfig() {
  const defaults = {
    sheetUrl: process.env.GOOGLE_SHEET_URL || '',
    defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
    templates: {
      welcome: 'Hi {{name}}! Welcome to our service. How can we help you today?',
      order_update: 'Hello {{name}}, your order #{{orderId}} is currently {{status}}.',
      reminder: 'Hi {{name}}, friendly reminder about our scheduled call/appointment at {{time}}.'
    }
  };

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...defaults, ...data };
    } catch (e) {
      console.error('Error reading config.json, using defaults:', e.message);
    }
  }
  return defaults;
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving config.json:', e.message);
  }
}

let appConfig = loadConfig();

// In-memory leads and sent tracking
let currentLeads = [];
let sheetStatus = {
  isConnected: false,
  sheetUrl: appConfig.sheetUrl || '',
  lastSynced: null,
  error: null,
  headers: []
};
const sentLeadIds = new Set();

/**
 * Normalizes phone numbers into E.164 without '+' or leading zeros.
 * Automatically adds country code if 10 digits are provided.
 */
function cleanPhoneNumber(phone, defaultCountryCode = appConfig.defaultCountryCode || '91') {
  if (!phone) return '';
  let cleaned = String(phone).replace(/\D/g, '');
  cleaned = cleaned.replace(/^0+/, ''); // strip leading zeroes
  if (cleaned.length === 10) {
    cleaned = defaultCountryCode + cleaned;
  }
  return cleaned;
}

/**
 * Injects key-value pairs into {{variable}} tags
 */
function renderTemplate(templateString, variables) {
  if (!templateString) return '';
  let result = templateString;
  for (const [key, val] of Object.entries(variables || {})) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`{{\\s*${escapedKey}\\s*}}`, 'gi');
    result = result.replace(regex, val != null ? String(val) : '');
  }
  return result;
}

/**
 * Builds the official wa.me URL
 */
function createWaLink(phone, text) {
  const normalizedPhone = cleanPhoneNumber(phone);
  const encodedText = encodeURIComponent(text);
  return `https://wa.me/${normalizedPhone}?text=${encodedText}`;
}

// Load initial data
async function initializeData() {
  if (appConfig.sheetUrl) {
    console.log(`Connecting to configured Google Sheet: ${appConfig.sheetUrl}`);
    try {
      const res = await fetchGoogleSheetData(appConfig.sheetUrl);
      currentLeads = res.leads;
      sheetStatus = {
        isConnected: true,
        sheetUrl: appConfig.sheetUrl,
        lastSynced: new Date().toISOString(),
        error: null,
        headers: res.headers
      };
      console.log(`Successfully synced ${res.totalCount} leads from Google Sheet!`);
      return;
    } catch (err) {
      console.error(`Could not sync Google Sheet on startup: ${err.message}`);
      sheetStatus.error = err.message;
      sheetStatus.isConnected = false;
    }
  }

  // Fallback to sample data
  console.log('Using sample leads. Paste a Google Sheet URL in the dashboard to connect live data.');
  try {
    const sampleContent = fs.readFileSync(SAMPLE_CSV, 'utf8');
    const { parse } = require('csv-parse/sync');
    const { normalizeLeadRow } = require('./googleSheets');
    const records = parse(sampleContent, { columns: true, skip_empty_lines: true, trim: true });
    currentLeads = records.map((row, idx) => normalizeLeadRow(row, idx));
    sheetStatus.headers = Object.keys(records[0] || {});
  } catch (err) {
    currentLeads = [
      { id: 1, name: 'Rohit Sharma', phone: '+91 98765 43210', orderId: 'ORD-101', status: 'Out for delivery', time: '3:00 PM', variables: { name: 'Rohit Sharma', phone: '+91 98765 43210', orderId: 'ORD-101', status: 'Out for delivery', time: '3:00 PM' } },
      { id: 2, name: 'Priya Singh', phone: '+91 91234 56789', orderId: 'ORD-102', status: 'Processing', time: '5:30 PM', variables: { name: 'Priya Singh', phone: '+91 91234 56789', orderId: 'ORD-102', status: 'Processing', time: '5:30 PM' } }
    ];
  }
}

// --- API Endpoints ---

// Connect & sync a new Google Sheet
app.post('/api/sheet/connect', async (req, res) => {
  const { sheetUrl, countryCode } = req.body;
  if (!sheetUrl) {
    return res.status(400).json({ error: 'Please provide a valid Google Sheet URL or ID' });
  }

  try {
    const data = await fetchGoogleSheetData(sheetUrl);
    currentLeads = data.leads;
    sentLeadIds.clear(); // reset sent state on new sheet

    appConfig.sheetUrl = sheetUrl.trim();
    if (countryCode) appConfig.defaultCountryCode = countryCode.trim();
    saveConfig(appConfig);

    sheetStatus = {
      isConnected: true,
      sheetUrl: appConfig.sheetUrl,
      lastSynced: new Date().toISOString(),
      error: null,
      headers: data.headers
    };

    res.json({
      success: true,
      message: `Successfully connected Google Sheet! Loaded ${data.totalCount} leads.`,
      sheetStatus,
      leads: currentLeads,
      headers: data.headers
    });
  } catch (err) {
    sheetStatus.error = err.message;
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// Refresh / Sync from current Google Sheet
app.post('/api/sheet/sync', async (req, res) => {
  if (!appConfig.sheetUrl) {
    return res.status(400).json({ error: 'No Google Sheet URL is currently connected. Please connect one first.' });
  }

  try {
    const data = await fetchGoogleSheetData(appConfig.sheetUrl);
    currentLeads = data.leads;
    sheetStatus = {
      isConnected: true,
      sheetUrl: appConfig.sheetUrl,
      lastSynced: new Date().toISOString(),
      error: null,
      headers: data.headers
    };

    res.json({
      success: true,
      message: `Synced ${data.totalCount} leads successfully!`,
      sheetStatus,
      leads: currentLeads,
      headers: data.headers
    });
  } catch (err) {
    sheetStatus.error = err.message;
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// Get current state (leads, templates, status)
app.get('/api/state', (req, res) => {
  res.json({
    sheetStatus,
    leads: currentLeads.map(l => ({ ...l, isSent: sentLeadIds.has(l.id) })),
    templates: appConfig.templates,
    defaultCountryCode: appConfig.defaultCountryCode
  });
});

// Mark a lead as sent
app.post('/api/leads/mark-sent', (req, res) => {
  const { id } = req.body;
  if (id != null) {
    sentLeadIds.add(Number(id));
  }
  res.json({ success: true, sentIds: Array.from(sentLeadIds) });
});

// Reset sent status
app.post('/api/leads/reset-sent', (req, res) => {
  sentLeadIds.clear();
  res.json({ success: true });
});

// Save / update templates
app.post('/api/templates', (req, res) => {
  const { templates } = req.body;
  if (!templates || typeof templates !== 'object') {
    return res.status(400).json({ error: 'Invalid templates object' });
  }
  appConfig.templates = templates;
  saveConfig(appConfig);
  res.json({ success: true, templates: appConfig.templates });
});

// Download sample CSV
app.get('/api/download-sample', (req, res) => {
  res.download(SAMPLE_CSV, 'sample_leads.csv');
});

// Generate link on demand
app.post('/api/generate-link', (req, res) => {
  const { phone, templateKey, customText, variables } = req.body;

  let message = customText;
  if (!message && templateKey && appConfig.templates[templateKey]) {
    message = renderTemplate(appConfig.templates[templateKey], variables || {});
  }

  if (!phone || !message) {
    return res.status(400).json({ error: 'Missing phone number or message' });
  }

  const link = createWaLink(phone, message);
  res.json({ link, message });
});

// Dispatcher Dashboard
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Automation Dispatcher • Google Sheets</title>
  <style>
    :root {
      --primary: #25D366;
      --primary-hover: #1EBE5D;
      --primary-dark: #075E54;
      --bg: #F0F2F5;
      --card-bg: #FFFFFF;
      --text: #111B21;
      --text-muted: #667781;
      --border: #E9EDEF;
      --radius: 10px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    body { background-color: var(--bg); color: var(--text); padding: 24px 16px; min-height: 100vh; }
    .container { max-width: 1100px; margin: 0 auto; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .brand { display: flex; align-items: center; gap: 12px; }
    .logo {
      width: 44px; height: 44px; background: #25D366; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; color: white;
      font-size: 24px; box-shadow: 0 4px 12px rgba(37,211,102,0.3);
    }
    h1 { font-size: 22px; font-weight: 700; color: #111B21; }
    p.subtitle { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

    /* Card */
    .card {
      background: var(--card-bg);
      border-radius: var(--radius);
      padding: 20px;
      box-shadow: 0 1px 3px rgba(11,20,26,0.08);
      margin-bottom: 20px;
      border: 1px solid var(--border);
    }

    /* Google Sheet Connect Box */
    .sheet-bar {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .sheet-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .input-group {
      flex: 1;
      min-width: 280px;
      position: relative;
    }
    input[type="text"], input[type="search"] {
      width: 100%;
      padding: 11px 14px;
      border: 1.5px solid #D1D7DB;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus, input[type="search"]:focus {
      border-color: var(--primary);
    }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      text-decoration: none;
      white-space: nowrap;
    }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-secondary { background: #E9EDEF; color: #111B21; }
    .btn-secondary:hover { background: #D1D7DB; }
    .btn-sm { padding: 6px 12px; font-size: 13px; border-radius: 6px; }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      font-weight: 600;
      padding: 6px 12px;
      border-radius: 20px;
      width: fit-content;
    }
    .status-connected { background: #E7FCE3; color: #0E702A; }
    .status-disconnected { background: #FFF4E5; color: #B25E00; }
    .status-error { background: #FDE8E8; color: #9B1C1C; }

    /* Instructions accordion */
    .guide-toggle {
      font-size: 13px;
      color: #008069;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-weight: 600;
      margin-top: 4px;
    }
    .guide-box {
      display: none;
      background: #F8FAFC;
      border: 1px dashed #CBD5E1;
      padding: 14px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.6;
      margin-top: 8px;
    }
    .guide-box ol { margin-left: 20px; }
    .guide-box code { background: #E2E8F0; padding: 2px 5px; border-radius: 4px; font-size: 12px; }

    /* Stats bar */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .stat-card {
      background: white;
      padding: 14px 18px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(11,20,26,0.05);
    }
    .stat-val { font-size: 24px; font-weight: 700; color: #111B21; }
    .stat-lbl { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

    /* Filters */
    .filter-bar {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
      align-items: center;
    }
    .filter-tabs { display: flex; gap: 6px; }
    .tab-btn {
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      background: #E9EDEF;
      border: none;
      color: #54656F;
    }
    .tab-btn.active { background: #008069; color: white; }

    /* Table */
    .table-container {
      overflow-x: auto;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: white;
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th {
      background: #F9FAFB;
      padding: 12px 14px;
      font-weight: 600;
      color: #54656F;
      border-bottom: 1.5px solid var(--border);
      font-size: 13px;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    tr:hover td { background: #FAFAFA; }

    .lead-name { font-weight: 600; color: #111B21; }
    .lead-phone { font-family: monospace; color: #008069; font-weight: 500; font-size: 13px; }
    .meta-tag {
      display: inline-block;
      font-size: 11px;
      background: #E9EDEF;
      color: #54656F;
      padding: 2px 6px;
      border-radius: 4px;
      margin-right: 4px;
      margin-top: 3px;
    }

    select {
      width: 100%;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid #D1D7DB;
      font-size: 13px;
      background: white;
      outline: none;
    }
    select:focus { border-color: var(--primary); }

    .msg-preview {
      font-size: 12px;
      color: #4B5563;
      background: #F8FAFC;
      border-left: 3px solid #25D366;
      padding: 6px 10px;
      border-radius: 4px;
      margin-top: 6px;
      max-width: 380px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .badge-sent {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      background: #E7FCE3;
      color: #0E702A;
      padding: 3px 8px;
      border-radius: 12px;
      font-weight: 600;
    }
    .badge-pending {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      background: #F1F5F9;
      color: #64748B;
      padding: 3px 8px;
      border-radius: 12px;
      font-weight: 600;
    }

    .action-group { display: flex; gap: 6px; align-items: center; }
    .btn-wa {
      background: #25D366;
      color: white;
      padding: 7px 14px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 13px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background 0.15s;
    }
    .btn-wa:hover { background: #1EBE5D; }
    .btn-wa.sent { background: #E9EDEF; color: #54656F; }

    /* Modal / Template editor */
    .modal-backdrop {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: white;
      border-radius: 12px;
      max-width: 650px;
      width: 100%;
      padding: 24px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2);
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .modal-title { font-size: 18px; font-weight: 700; }
    .close-btn { cursor: pointer; font-size: 20px; border: none; background: none; color: #667781; }

    textarea {
      width: 100%;
      padding: 10px;
      border-radius: 8px;
      border: 1.5px solid #D1D7DB;
      font-size: 13px;
      min-height: 80px;
      resize: vertical;
      outline: none;
    }
    textarea:focus { border-color: var(--primary); }

    .tag-pill {
      display: inline-block;
      background: #E9EDEF;
      color: #111B21;
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 12px;
      cursor: pointer;
      margin: 2px;
      user-select: none;
    }
    .tag-pill:hover { background: #D1D7DB; }

    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #111B21;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      display: none;
      z-index: 9999;
      animation: slideUp 0.3s ease;
    }
    @keyframes slideUp { from { transform: translateY(100%); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="logo">💬</div>
        <div>
          <h1>WhatsApp Automation Dispatcher</h1>
          <p class="subtitle">Direct Google Sheets integration &bull; Click to chat via official WhatsApp Web / App</p>
        </div>
      </div>
      <div style="display: flex; gap: 8px;">
        <button class="btn btn-secondary btn-sm" onclick="openTemplatesModal()">⚙️ Edit Templates</button>
        <a href="/api/download-sample" class="btn btn-secondary btn-sm">📥 Sample CSV</a>
      </div>
    </header>

    <!-- Google Sheet Connection Box -->
    <div class="card">
      <div class="sheet-bar">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div style="font-weight: 600; font-size: 15px;">📊 Connect Google Sheet</div>
          <div id="statusBadge" class="status-badge status-disconnected">
            <span>●</span> Checking connection...
          </div>
        </div>

        <div class="sheet-row">
          <div class="input-group">
            <input type="text" id="sheetUrlInput" placeholder="Paste your Google Sheet link here (e.g. https://docs.google.com/spreadsheets/d/...)" />
          </div>
          <button class="btn btn-primary" id="connectBtn" onclick="connectSheet()">
            <span>🔗 Connect & Sync</span>
          </button>
          <button class="btn btn-secondary" id="syncBtn" onclick="syncSheet()" title="Reload latest rows from Google Sheets">
            <span>🔄 Refresh</span>
          </button>
        </div>

        <div>
          <span class="guide-toggle" onclick="toggleGuide()">ℹ️ How to set up your Google Sheet in 30 seconds &darr;</span>
          <div id="guideBox" class="guide-box">
            <ol>
              <li>Create a new sheet in <a href="https://sheets.new" target="_blank" style="color: #008069; font-weight: 600;">Google Sheets</a>.</li>
              <li>Make row 1 your headers: <code>Name</code>, <code>Phone</code>, <code>OrderId</code>, <code>Status</code>, <code>Time</code> (or any custom columns!).</li>
              <li>Add your customer data in the rows below. (Numbers can be entered with or without country code, e.g. <code>+91 98765 43210</code> or <code>9876543210</code>).</li>
              <li>Click the green <strong>Share</strong> button (top right of Google Sheets) &rarr; change General access to <strong>"Anyone with the link can view"</strong>.</li>
              <li>Copy the link from your browser address bar and paste it above!</li>
            </ol>
            <div style="margin-top: 8px;">
              💡 <em>Tip: You can also use any extra column names inside templates as <code>{{columnName}}</code> tags!</em>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Quick Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-val" id="totalLeadsCount">0</div>
        <div class="stat-lbl">Total Contacts</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" id="sentCount" style="color: #0E702A;">0</div>
        <div class="stat-lbl">Messages Sent</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" id="pendingCount" style="color: #64748B;">0</div>
        <div class="stat-lbl">Pending</div>
      </div>
    </div>

    <!-- Filter & Search Bar -->
    <div class="filter-bar">
      <div class="filter-tabs">
        <button class="tab-btn active" onclick="setFilter('all', this)">All</button>
        <button class="tab-btn" onclick="setFilter('pending', this)">Pending</button>
        <button class="tab-btn" onclick="setFilter('sent', this)">Sent</button>
      </div>

      <div style="display: flex; gap: 8px; flex: 1; max-width: 400px;">
        <input type="search" id="searchInput" oninput="renderTable()" placeholder="Search by name, phone, order ID..." />
        <button class="btn btn-secondary btn-sm" onclick="resetSentStatus()" title="Reset all Sent statuses">Reset Sent</button>
      </div>
    </div>

    <!-- Leads Table -->
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th style="width: 50px;">Status</th>
            <th>Contact</th>
            <th>Details</th>
            <th>Template & Preview</th>
            <th style="width: 140px; text-align: center;">Action</th>
          </tr>
        </thead>
        <tbody id="tableBody">
          <tr><td colspan="5" style="text-align: center; padding: 24px; color: #888;">Loading data...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Template Manager Modal -->
  <div id="templatesModal" class="modal-backdrop">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">⚙️ Message Templates</div>
        <button class="close-btn" onclick="closeTemplatesModal()">&times;</button>
      </div>
      <p style="font-size: 13px; color: #666; margin-bottom: 14px;">
        Variables in double curly brackets will be automatically filled with data from Google Sheets:
      </p>
      <div id="availableTags" style="margin-bottom: 16px;"></div>

      <div id="templateInputs" style="display: flex; flex-direction: column; gap: 14px; max-height: 50vh; overflow-y: auto; padding-right: 4px;"></div>

      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;">
        <button class="btn btn-secondary" onclick="closeTemplatesModal()">Cancel</button>
        <button class="btn btn-primary" onclick="saveTemplates()">Save Templates</button>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let state = {
      leads: [],
      templates: {},
      sheetStatus: {},
      activeFilter: 'all',
      defaultCountryCode: '91'
    };

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3500);
    }

    function toggleGuide() {
      const el = document.getElementById('guideBox');
      el.style.display = el.style.display === 'block' ? 'none' : 'block';
    }

    function cleanPhone(phone, defaultCode = state.defaultCountryCode || '91') {
      if (!phone) return '';
      let cleaned = String(phone).replace(/\\D/g, '').replace(/^0+/, '');
      if (cleaned.length === 10) cleaned = defaultCode + cleaned;
      return cleaned;
    }

    function renderTemplate(tplText, variables) {
      if (!tplText) return '';
      let res = tplText;
      for (const [key, val] of Object.entries(variables || {})) {
        const regex = new RegExp('{{\\\\s*' + key + '\\\\s*}}', 'gi');
        res = res.replace(regex, val != null ? val : '');
      }
      return res;
    }

    function updateBadge() {
      const badge = document.getElementById('statusBadge');
      const st = state.sheetStatus;
      if (st.isConnected) {
        badge.className = 'status-badge status-connected';
        badge.innerHTML = '🟢 Connected (' + state.leads.length + ' leads loaded)';
      } else if (st.error) {
        badge.className = 'status-badge status-error';
        badge.innerHTML = '🔴 ' + (st.error.length > 50 ? st.error.slice(0, 48) + '...' : st.error);
        badge.title = st.error;
      } else {
        badge.className = 'status-badge status-disconnected';
        badge.innerHTML = '🟡 Sample Data (Paste Sheet URL above)';
      }
    }

    function updateStats() {
      const total = state.leads.length;
      const sent = state.leads.filter(l => l.isSent).length;
      const pending = total - sent;

      document.getElementById('totalLeadsCount').innerText = total;
      document.getElementById('sentCount').innerText = sent;
      document.getElementById('pendingCount').innerText = pending;
    }

    function setFilter(filter, btn) {
      state.activeFilter = filter;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTable();
    }

    function renderTable() {
      const tbody = document.getElementById('tableBody');
      const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();

      const filtered = state.leads.filter(lead => {
        if (state.activeFilter === 'sent' && !lead.isSent) return false;
        if (state.activeFilter === 'pending' && lead.isSent) return false;

        if (search) {
          const matchName = (lead.name || '').toLowerCase().includes(search);
          const matchPhone = (lead.phone || '').toLowerCase().includes(search);
          const matchOrder = (lead.orderId || '').toLowerCase().includes(search);
          const matchStatus = (lead.status || '').toLowerCase().includes(search);
          if (!matchName && !matchPhone && !matchOrder && !matchStatus) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 32px; color: #888;">No contacts found matching filter.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(lead => {
        const availableTemplates = Object.keys(state.templates);
        const selectedTpl = lead.selectedTemplate || (state.templates[lead.template] ? lead.template : availableTemplates[0] || 'welcome');

        let msg = '';
        if (lead.customMessage && selectedTpl === '__custom__') {
          msg = lead.customMessage;
        } else {
          msg = renderTemplate(state.templates[selectedTpl] || '', lead.variables);
        }

        const normalizedPhone = cleanPhone(lead.phone);
        const waLink = 'https://wa.me/' + normalizedPhone + '?text=' + encodeURIComponent(msg);

        const statusPill = lead.isSent
          ? '<span class="badge-sent">✓ Sent</span>'
          : '<span class="badge-pending">⏳ Pending</span>';

        return \`
          <tr>
            <td>\${statusPill}</td>
            <td>
              <div class="lead-name">\${lead.name || 'Unnamed'}</div>
              <div class="lead-phone">\${lead.phone || '<span style="color:#e53e3e">No Phone</span>'}</div>
            </td>
            <td>
              \${lead.orderId ? '<span class="meta-tag">#' + lead.orderId + '</span>' : ''}
              \${lead.status ? '<span class="meta-tag">' + lead.status + '</span>' : ''}
              \${lead.time ? '<span class="meta-tag">⏰ ' + lead.time + '</span>' : ''}
            </td>
            <td>
              <select onchange="changeLeadTemplate(\${lead.id}, this.value)">
                \${lead.customMessage ? '<option value="__custom__" ' + (selectedTpl === '__custom__' ? 'selected' : '') + '>📄 Custom Message (from Sheet)</option>' : ''}
                \${availableTemplates.map(k => \`<option value="\${k}" \${k === selectedTpl ? 'selected' : ''}>\${k.replace('_', ' ').toUpperCase()}</option>\`).join('')}
              </select>
              <div class="msg-preview" id="preview-\${lead.id}">\${msg}</div>
            </td>
            <td style="text-align: center;">
              <div class="action-group" style="justify-content: center;">
                <a href="\${waLink}" target="_blank" onclick="markSent(\${lead.id})" class="btn-wa \${lead.isSent ? 'sent' : ''}">
                  <span>\${lead.isSent ? 'Resend' : 'Send'}</span> 💬
                </a>
              </div>
            </td>
          </tr>
        \`;
      }).join('');
    }

    function changeLeadTemplate(leadId, tplKey) {
      const lead = state.leads.find(l => l.id === leadId);
      if (!lead) return;
      lead.selectedTemplate = tplKey;

      let msg = '';
      if (tplKey === '__custom__' && lead.customMessage) {
        msg = lead.customMessage;
      } else {
        msg = renderTemplate(state.templates[tplKey] || '', lead.variables);
      }

      const preview = document.getElementById('preview-' + leadId);
      if (preview) preview.innerText = msg;
      renderTable();
    }

    async function markSent(leadId) {
      const lead = state.leads.find(l => l.id === leadId);
      if (lead) lead.isSent = true;
      updateStats();
      setTimeout(renderTable, 300);

      try {
        await fetch('/api/leads/mark-sent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: leadId })
        });
      } catch (e) {
        console.error('Error recording sent state', e);
      }
    }

    async function resetSentStatus() {
      if (!confirm('Reset all sent statuses back to pending?')) return;
      state.leads.forEach(l => l.isSent = false);
      updateStats();
      renderTable();
      await fetch('/api/leads/reset-sent', { method: 'POST' });
      showToast('Sent statuses reset.');
    }

    async function connectSheet() {
      const btn = document.getElementById('connectBtn');
      const input = document.getElementById('sheetUrlInput');
      const url = input.value.trim();

      if (!url) {
        alert('Please paste a Google Sheet URL first.');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = 'Connecting...';

      try {
        const res = await fetch('/api/sheet/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sheetUrl: url })
        });
        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to connect sheet');
        }

        state.sheetStatus = data.sheetStatus;
        state.leads = data.leads;
        updateBadge();
        updateStats();
        renderTable();
        showToast(data.message);
      } catch (err) {
        alert('Error: ' + err.message);
        state.sheetStatus.error = err.message;
        updateBadge();
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔗 Connect & Sync</span>';
      }
    }

    async function syncSheet() {
      const btn = document.getElementById('syncBtn');
      btn.disabled = true;
      btn.innerHTML = 'Syncing...';

      try {
        const res = await fetch('/api/sheet/sync', { method: 'POST' });
        const data = await res.json();

        if (!res.ok || !data.success) {
          throw new Error(data.error || 'Failed to sync');
        }

        state.sheetStatus = data.sheetStatus;
        state.leads = data.leads;
        updateBadge();
        updateStats();
        renderTable();
        showToast(data.message);
      } catch (err) {
        alert('Sync error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄 Refresh</span>';
      }
    }

    // Modal & Templates
    function openTemplatesModal() {
      const container = document.getElementById('templateInputs');
      const tagsContainer = document.getElementById('availableTags');

      // Detect available columns from headers or leads
      const headers = state.sheetStatus.headers || ['name', 'phone', 'orderId', 'status', 'time'];
      tagsContainer.innerHTML = '<strong>Available tags:</strong> ' + headers.map(h =>
        \`<span class="tag-pill" onclick="insertTag('{{\${h}}}')">{{\${h}}}</span>\`
      ).join(' ');

      container.innerHTML = Object.entries(state.templates).map(([key, val]) => \`
        <div>
          <label style="font-weight: 600; font-size: 13px; text-transform: uppercase;">\${key.replace('_', ' ')}</label>
          <textarea id="tpl_\${key}">\${val}</textarea>
        </div>
      \`).join('');

      document.getElementById('templatesModal').classList.add('open');
    }

    function closeTemplatesModal() {
      document.getElementById('templatesModal').classList.remove('open');
    }

    function insertTag(tag) {
      const active = document.activeElement;
      if (active && active.tagName === 'TEXTAREA') {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        active.value = active.value.substring(0, start) + tag + active.value.substring(end);
        active.selectionStart = active.selectionEnd = start + tag.length;
        active.focus();
      } else {
        navigator.clipboard.writeText(tag);
        showToast('Copied ' + tag + ' to clipboard!');
      }
    }

    async function saveTemplates() {
      const updated = {};
      Object.keys(state.templates).forEach(key => {
        const el = document.getElementById('tpl_' + key);
        if (el) updated[key] = el.value;
      });

      try {
        const res = await fetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ templates: updated })
        });
        const data = await res.json();
        if (data.success) {
          state.templates = data.templates;
          closeTemplatesModal();
          renderTable();
          showToast('Templates saved successfully!');
        }
      } catch (e) {
        alert('Error saving templates: ' + e.message);
      }
    }

    // Initial load
    async function init() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        state.sheetStatus = data.sheetStatus;
        state.leads = data.leads;
        state.templates = data.templates;
        state.defaultCountryCode = data.defaultCountryCode || '91';

        if (state.sheetStatus.sheetUrl) {
          document.getElementById('sheetUrlInput').value = state.sheetStatus.sheetUrl;
        }

        updateBadge();
        updateStats();
        renderTable();
      } catch (e) {
        console.error('Failed to load initial state', e);
      }
    }

    init();
  </script>
</body>
</html>
  `);
});

// Start server
initializeData().then(() => {
  app.listen(PORT, () => {
    console.log(`WhatsApp Automation Server running on http://localhost:${PORT}`);
  });
});
