const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const { fetchGoogleSheetData } = require('./googleSheets');

const app = express();
const PORT = process.env.PORT || 1212;
const CONFIG_FILE = path.join(__dirname, 'config.json');
const SAMPLE_CSV = path.join(__dirname, 'sample_leads.csv');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage for media uploads (photos/videos)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const cleanBase = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `${cleanBase}-${Date.now()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB
});

app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Helper: Normalize templates
function normalizeTemplates(rawTemplates) {
  const result = {};
  for (const [key, val] of Object.entries(rawTemplates || {})) {
    if (typeof val === 'string') {
      result[key] = {
        title: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        text: val,
        mediaUrl: '',
        mediaType: ''
      };
    } else {
      let mediaType = val.mediaType || '';
      if (!mediaType && val.mediaUrl) {
        mediaType = val.mediaUrl.match(/\.(mp4|mov|webm|avi|m4v)$/i) ? 'video' : 'image';
      }
      result[key] = {
        title: val.title || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        text: val.text || '',
        mediaUrl: val.mediaUrl || '',
        mediaType
      };
    }
  }
  return result;
}

// Load or initialize config
function loadConfig() {
  const defaults = {
    sheetUrl: process.env.GOOGLE_SHEET_URL || '',
    defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || '91',
    defaultTemplate: 'welcome',
    templates: {
      welcome: {
        title: 'Welcome Offer',
        text: 'Hi {{name}}! Welcome to our store. We are thrilled to have you with us! Let us know how we can help you today.',
        mediaUrl: '',
        mediaType: ''
      },
      order_update: {
        title: 'Order Update',
        text: 'Hello {{name}}, your order #{{orderId}} is currently {{status}}.',
        mediaUrl: '',
        mediaType: ''
      },
      reminder: {
        title: 'Appointment Reminder',
        text: 'Hi {{name}}, friendly reminder about our scheduled call/appointment at {{time}}.',
        mediaUrl: '',
        mediaType: ''
      }
    }
  };

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return {
        ...defaults,
        ...data,
        templates: normalizeTemplates(data.templates || defaults.templates)
      };
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

// Compute group summary
function getGroupsSummary(leads) {
  const groupCounts = {};
  leads.forEach(l => {
    const g = l.group || 'General';
    groupCounts[g] = (groupCounts[g] || 0) + 1;
  });
  const list = [{ name: 'All', count: leads.length }];
  for (const [name, count] of Object.entries(groupCounts)) {
    list.push({ name, count });
  }
  return list;
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

  // Fallback to sample CSV
  try {
    const sampleContent = fs.readFileSync(SAMPLE_CSV, 'utf8');
    const { parse } = require('csv-parse/sync');
    const { normalizeLeadRow } = require('./googleSheets');
    const records = parse(sampleContent, { columns: true, skip_empty_lines: true, trim: true });
    currentLeads = records.map((row, idx) => normalizeLeadRow(row, idx));
    sheetStatus.headers = Object.keys(records[0] || {});
  } catch (err) {
    currentLeads = [
      { id: 1, name: 'Rohit Sharma', phone: '+91 98765 43210', group: 'VIP', orderId: 'ORD-101', status: 'Out for delivery', time: '3:00 PM', variables: { name: 'Rohit Sharma', phone: '+91 98765 43210', group: 'VIP', orderId: 'ORD-101', status: 'Out for delivery', time: '3:00 PM' } },
      { id: 2, name: 'Priya Singh', phone: '+91 91234 56789', group: 'New Leads', orderId: 'ORD-102', status: 'Processing', time: '5:30 PM', variables: { name: 'Priya Singh', phone: '+91 91234 56789', group: 'New Leads', orderId: 'ORD-102', status: 'Processing', time: '5:30 PM' } }
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
    sentLeadIds.clear();

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
      message: `Successfully connected Google Sheet! Loaded ${data.totalCount} leads across ${getGroupsSummary(currentLeads).length - 1} groups.`,
      sheetStatus,
      leads: currentLeads,
      groups: getGroupsSummary(currentLeads),
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
      groups: getGroupsSummary(currentLeads),
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

// Get state (leads, templates, groups, status)
app.get('/api/state', (req, res) => {
  res.json({
    sheetStatus,
    leads: currentLeads.map(l => ({ ...l, isSent: sentLeadIds.has(l.id) })),
    groups: getGroupsSummary(currentLeads),
    templates: appConfig.templates,
    defaultTemplate: appConfig.defaultTemplate || Object.keys(appConfig.templates)[0] || 'welcome',
    defaultCountryCode: appConfig.defaultCountryCode
  });
});

// Get contacts in a specific group
app.get('/api/group-contacts/:groupName', (req, res) => {
  const { groupName } = req.params;
  const decodedGroup = decodeURIComponent(groupName);

  const matched = decodedGroup === 'All'
    ? currentLeads
    : currentLeads.filter(l => (l.group || 'General').toLowerCase() === decodedGroup.toLowerCase());

  res.json({
    group: decodedGroup,
    count: matched.length,
    contacts: matched.map(l => ({
      id: l.id,
      name: l.name,
      phone: l.phone,
      cleanPhone: cleanPhoneNumber(l.phone),
      group: l.group || 'General',
      status: l.status,
      isSent: sentLeadIds.has(l.id)
    }))
  });
});

// Media upload endpoint
app.post('/api/upload-media', upload.single('mediaFile'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No media file was uploaded' });
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  const isVideo = req.file.mimetype.startsWith('video/') || req.file.filename.match(/\.(mp4|mov|webm|avi)$/i);
  const mediaType = isVideo ? 'video' : 'image';

  res.json({
    success: true,
    url: fileUrl,
    mediaType,
    fileName: req.file.originalname,
    size: req.file.size
  });
});

// Save single template (add or update)
app.post('/api/templates/save-single', (req, res) => {
  const { key, title, text, mediaUrl, mediaType } = req.body;
  if (!key || !text) {
    return res.status(400).json({ error: 'Template key and message text are required' });
  }

  const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  appConfig.templates[cleanKey] = {
    title: title || cleanKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    text: text.trim(),
    mediaUrl: mediaUrl ? mediaUrl.trim() : '',
    mediaType: mediaType || (mediaUrl && mediaUrl.match(/\.(mp4|mov|webm)$/i) ? 'video' : (mediaUrl ? 'image' : ''))
  };

  saveConfig(appConfig);
  res.json({ success: true, key: cleanKey, template: appConfig.templates[cleanKey], templates: appConfig.templates });
});

// Delete template
app.delete('/api/templates/:key', (req, res) => {
  const { key } = req.params;
  if (appConfig.templates[key]) {
    delete appConfig.templates[key];
    saveConfig(appConfig);
  }
  res.json({ success: true, templates: appConfig.templates });
});

// Save default template
app.post('/api/set-default-template', (req, res) => {
  const { defaultTemplate } = req.body;
  if (defaultTemplate && appConfig.templates[defaultTemplate]) {
    appConfig.defaultTemplate = defaultTemplate;
    saveConfig(appConfig);
  }
  res.json({ success: true, defaultTemplate: appConfig.defaultTemplate });
});

// Mark lead as sent
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

// Download sample CSV
app.get('/api/download-sample', (req, res) => {
  res.download(SAMPLE_CSV, 'sample_leads.csv');
});

// Dashboard UI
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
    body { background-color: var(--bg); color: var(--text); padding: 20px 16px; min-height: 100vh; }
    .container { max-width: 1140px; margin: 0 auto; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 18px;
      flex-wrap: wrap;
      gap: 12px;
    }

    .brand { display: flex; align-items: center; gap: 12px; }
    .logo {
      width: 44px; height: 44px; background: #25D366; border-radius: 50%;
      display: flex; align-items: center; justify-content: center; color: white;
      font-size: 24px; box-shadow: 0 4px 12px rgba(37,211,102,0.3);
    }
    h1 { font-size: 21px; font-weight: 700; color: #111B21; }
    p.subtitle { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

    .card {
      background: var(--card-bg);
      border-radius: var(--radius);
      padding: 18px 20px;
      box-shadow: 0 1px 3px rgba(11,20,26,0.06);
      margin-bottom: 18px;
      border: 1px solid var(--border);
    }

    /* Top Google Sheet Connect */
    .sheet-bar { display: flex; flex-direction: column; gap: 10px; }
    .sheet-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .input-group { flex: 1; min-width: 280px; }
    input[type="text"], input[type="search"] {
      width: 100%;
      padding: 10px 14px;
      border: 1.5px solid #D1D7DB;
      border-radius: 8px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus, input[type="search"]:focus { border-color: var(--primary); }

    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 9px 16px;
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
      font-size: 12px;
      font-weight: 600;
      padding: 5px 12px;
      border-radius: 20px;
    }
    .status-connected { background: #E7FCE3; color: #0E702A; }
    .status-disconnected { background: #FFF4E5; color: #B25E00; }
    .status-error { background: #FDE8E8; color: #9B1C1C; }

    .guide-toggle { font-size: 12px; color: #008069; cursor: pointer; font-weight: 600; }
    .guide-box {
      display: none;
      background: #F8FAFC;
      border: 1px dashed #CBD5E1;
      padding: 12px;
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.6;
      margin-top: 8px;
    }
    .guide-box code { background: #E2E8F0; padding: 2px 5px; border-radius: 4px; font-size: 12px; }

    /* Control Box: 3-Step Campaign Bar */
    .campaign-control-grid {
      display: grid;
      grid-template-columns: 1fr 1fr auto;
      gap: 16px;
      align-items: flex-end;
    }
    @media (max-width: 820px) {
      .campaign-control-grid { grid-template-columns: 1fr; }
    }
    .step-box {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .step-label {
      font-size: 12px;
      font-weight: 700;
      color: #008069;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    select {
      width: 100%;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1.5px solid #D1D7DB;
      font-size: 14px;
      background: white;
      outline: none;
      font-weight: 500;
    }
    select:focus { border-color: var(--primary); }

    /* Media badge */
    .media-indicator {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      background: #E0F2FE;
      color: #0369A1;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
    }

    /* Stats bar */
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .stat-card {
      background: white;
      padding: 12px 18px;
      border-radius: var(--radius);
      border: 1px solid var(--border);
      box-shadow: 0 1px 3px rgba(11,20,26,0.04);
    }
    .stat-val { font-size: 22px; font-weight: 700; color: #111B21; }
    .stat-lbl { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

    /* Filter Bar */
    .filter-bar {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 14px;
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
      padding: 11px 14px;
      font-weight: 600;
      color: #54656F;
      border-bottom: 1.5px solid var(--border);
      font-size: 13px;
    }
    td {
      padding: 11px 14px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    tr:hover td { background: #FAFAFA; }

    .lead-name { font-weight: 600; color: #111B21; }
    .lead-phone { font-family: monospace; color: #008069; font-weight: 600; font-size: 13px; }
    .group-pill {
      display: inline-block;
      font-size: 11px;
      background: #F0FDF4;
      color: #166534;
      border: 1px solid #BBF7D0;
      padding: 2px 7px;
      border-radius: 12px;
      font-weight: 600;
      margin-top: 3px;
    }
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
    .media-thumb-preview {
      margin-top: 6px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .media-thumb {
      width: 50px;
      height: 50px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid #CBD5E1;
      cursor: pointer;
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

    .action-group { display: flex; flex-direction: column; gap: 4px; align-items: center; }
    .btn-wa {
      background: #25D366;
      color: white;
      padding: 7px 12px;
      border-radius: 6px;
      font-weight: 600;
      font-size: 13px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      transition: background 0.15s;
      width: 100%;
      justify-content: center;
    }
    .btn-wa:hover { background: #1EBE5D; }
    .btn-wa.sent { background: #E9EDEF; color: #54656F; }

    /* Modals */
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
      max-width: 680px;
      width: 100%;
      padding: 22px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2);
      max-height: 90vh;
      display: flex;
      flex-direction: column;
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
    .modal-title { font-size: 18px; font-weight: 700; }
    .close-btn { cursor: pointer; font-size: 20px; border: none; background: none; color: #667781; }
    .modal-body { overflow-y: auto; flex: 1; padding-right: 4px; }

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

    /* Toast */
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
          <p class="subtitle">Google Sheets &bull; Contact Groups &bull; Media Templates &bull; WhatsApp Web</p>
        </div>
      </div>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button class="btn btn-secondary btn-sm" onclick="openTemplatesModal()">🎨 Template & Media Manager</button>
        <a href="/api/download-sample" class="btn btn-secondary btn-sm">📥 Sample CSV</a>
      </div>
    </header>

    <!-- Google Sheet Connect Bar -->
    <div class="card">
      <div class="sheet-bar">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
          <div style="font-weight: 600; font-size: 14px;">📊 Google Sheet Connection</div>
          <div id="statusBadge" class="status-badge status-disconnected">● Checking...</div>
        </div>

        <div class="sheet-row">
          <div class="input-group">
            <input type="text" id="sheetUrlInput" placeholder="Paste your Google Sheet link here..." />
          </div>
          <button class="btn btn-primary" id="connectBtn" onclick="connectSheet()">
            <span>🔗 Connect & Sync</span>
          </button>
          <button class="btn btn-secondary" id="syncBtn" onclick="syncSheet()" title="Reload latest rows from Google Sheets">
            <span>🔄 Refresh</span>
          </button>
        </div>

        <div>
          <span class="guide-toggle" onclick="toggleGuide()">ℹ️ How to format and share your Google Sheet &darr;</span>
          <div id="guideBox" class="guide-box">
            <ol>
              <li>Create a spreadsheet on <a href="https://sheets.new" target="_blank" style="color: #008069; font-weight: 600;">Google Sheets</a>.</li>
              <li>Include headers: <code>Name</code>, <code>Phone</code>, <code>Group</code> (e.g. VIP, New Leads), <code>OrderId</code>, <code>Status</code>, <code>Time</code>.</li>
              <li>Click <strong>Share</strong> (top right) &rarr; change General access to <strong>"Anyone with the link can view"</strong>.</li>
              <li>Paste the URL above and click <strong>Connect & Sync</strong>!</li>
            </ol>
          </div>
        </div>
      </div>
    </div>

    <!-- 3-STEP CAMPAIGN CONTROLLER CARD -->
    <div class="card" style="border-left: 4px solid var(--primary);">
      <div class="campaign-control-grid">
        <!-- Step 1: Select Contact Group -->
        <div class="step-box">
          <div class="step-label">
            <span>1️⃣ Select Contact Group</span>
            <button class="btn btn-secondary btn-sm" style="padding: 2px 8px; font-size: 11px;" onclick="openGroupModal()">
              👥 View Group Numbers
            </button>
          </div>
          <select id="groupSelect" onchange="onGroupChanged(this.value)">
            <option value="All">All Contacts (0)</option>
          </select>
        </div>

        <!-- Step 2: Select Global Template -->
        <div class="step-box">
          <div class="step-label">
            <span>2️⃣ Select Template (Applied at once)</span>
            <span id="templateMediaBadge" style="display: none;" class="media-indicator">🖼️ Has Media</span>
          </div>
          <select id="globalTemplateSelect" onchange="onGlobalTemplateChanged(this.value)"></select>
        </div>

        <!-- Quick Reset / Stats Action -->
        <div style="display: flex; gap: 8px;">
          <button class="btn btn-primary" onclick="applyTemplateToAll()" title="Apply current template to all visible rows">
            ⚡ Apply to All
          </button>
        </div>
      </div>
    </div>

    <!-- Quick Stats -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-val" id="totalLeadsCount">0</div>
        <div class="stat-lbl">Group Contacts</div>
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

      <div style="display: flex; gap: 8px; flex: 1; max-width: 420px;">
        <input type="search" id="searchInput" oninput="renderTable()" placeholder="Search name, phone, order ID..." />
        <button class="btn btn-secondary btn-sm" onclick="resetSentStatus()" title="Reset all Sent statuses">Reset Sent</button>
      </div>
    </div>

    <!-- Leads Table -->
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th style="width: 50px;">Status</th>
            <th>Contact & Group</th>
            <th>Order Details</th>
            <th>Template & Message Preview</th>
            <th style="width: 150px; text-align: center;">Action</th>
          </tr>
        </thead>
        <tbody id="tableBody">
          <tr><td colspan="5" style="text-align: center; padding: 24px; color: #888;">Loading data...</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- MODAL: Group Contacts Inspector -->
  <div id="groupModal" class="modal-backdrop">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title" id="groupModalTitle">👥 Group Numbers</div>
        <button class="close-btn" onclick="closeGroupModal()">&times;</button>
      </div>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
        All contact numbers in this group. You can copy them for broadcasting or records.
      </p>

      <div style="display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap;">
        <button class="btn btn-secondary btn-sm" onclick="copyGroupNumbers(',')">📋 Copy All (Comma-Separated)</button>
        <button class="btn btn-secondary btn-sm" onclick="copyGroupNumbers('\\n')">📋 Copy All (One Per Line)</button>
      </div>

      <div class="modal-body" style="max-height: 50vh;">
        <table style="width: 100%; font-size: 13px;">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody id="groupModalBody"></tbody>
        </table>
      </div>

      <div style="display: flex; justify-content: flex-end; margin-top: 14px;">
        <button class="btn btn-primary btn-sm" onclick="closeGroupModal()">Close</button>
      </div>
    </div>
  </div>

  <!-- MODAL: Template & Media Manager -->
  <div id="templatesModal" class="modal-backdrop">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">🎨 Template & Media Manager</div>
        <button class="close-btn" onclick="closeTemplatesModal()">&times;</button>
      </div>

      <div class="modal-body">
        <p style="font-size: 13px; color: #666; margin-bottom: 10px;">
          Attach a <strong>Photo</strong> or <strong>Video</strong> (optional) and write personalized text.
        </p>

        <!-- Template selector / Create new -->
        <div style="display: flex; gap: 10px; margin-bottom: 16px; align-items: center;">
          <select id="editTplPicker" onchange="loadTemplateIntoEditor(this.value)" style="flex: 1;"></select>
          <button class="btn btn-secondary btn-sm" onclick="createNewTemplateForm()">+ New Template</button>
        </div>

        <div style="background: #F8FAFC; border: 1px solid #E2E8F0; padding: 14px; border-radius: 8px; margin-bottom: 14px;">
          <div style="margin-bottom: 10px;">
            <label style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Template Key / ID</label>
            <input type="text" id="tplKeyInput" style="margin-top: 4px;" placeholder="e.g. welcome_offer, reminder" />
          </div>

          <div style="margin-bottom: 10px;">
            <label style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Display Title</label>
            <input type="text" id="tplTitleInput" style="margin-top: 4px;" placeholder="e.g. Festive Special Offer" />
          </div>

          <div style="margin-bottom: 10px;">
            <label style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Message Text</label>
            <div id="availableTags" style="margin: 6px 0;"></div>
            <textarea id="tplTextInput" placeholder="Write your template text here..."></textarea>
          </div>

          <!-- Media Attachment Section -->
          <div style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #CBD5E1;">
            <label style="font-weight: 600; font-size: 12px; text-transform: uppercase;">Attach Photo / Video (Optional)</label>
            
            <div style="display: flex; gap: 8px; margin-top: 6px; align-items: center; flex-wrap: wrap;">
              <input type="file" id="mediaFileInput" accept="image/*,video/*" style="font-size: 13px;" />
              <button class="btn btn-secondary btn-sm" type="button" onclick="uploadSelectedMedia()">⬆️ Upload File</button>
            </div>

            <div style="margin-top: 8px;">
              <span style="font-size: 11px; color: #666;">Or paste Media URL:</span>
              <input type="text" id="tplMediaUrlInput" oninput="updateMediaPreviewInEditor()" placeholder="https://example.com/photo.jpg or /uploads/..." style="margin-top: 3px; font-size: 13px;" />
            </div>

            <!-- Media Preview in Editor -->
            <div id="mediaEditorPreviewBox" style="margin-top: 10px; display: none;">
              <div style="font-size: 11px; font-weight: 600; color: #555; margin-bottom: 4px;">Media Preview:</div>
              <div id="mediaEditorPreviewContent"></div>
            </div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; gap: 10px; align-items: center;">
          <button class="btn btn-secondary btn-sm" id="deleteTplBtn" style="color: #DC2626;" onclick="deleteCurrentTemplate()">🗑️ Delete Template</button>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-secondary btn-sm" onclick="closeTemplatesModal()">Cancel</button>
            <button class="btn btn-primary btn-sm" onclick="saveCurrentTemplate()">💾 Save Template</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let state = {
      leads: [],
      groups: [],
      templates: {},
      selectedGroup: 'All',
      globalTemplate: 'welcome',
      sheetStatus: {},
      activeFilter: 'all',
      defaultCountryCode: '91'
    };

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.innerText = msg;
      toast.style.display = 'block';
      setTimeout(() => { toast.style.display = 'none'; }, 3800);
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

    function renderTemplateText(tplText, variables) {
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
        badge.innerHTML = '🟢 Connected (' + state.leads.length + ' contacts loaded)';
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
      const groupLeads = getFilteredByGroup();
      const total = groupLeads.length;
      const sent = groupLeads.filter(l => l.isSent).length;
      const pending = total - sent;

      document.getElementById('totalLeadsCount').innerText = total;
      document.getElementById('sentCount').innerText = sent;
      document.getElementById('pendingCount').innerText = pending;
    }

    function getFilteredByGroup() {
      if (state.selectedGroup === 'All') return state.leads;
      return state.leads.filter(l => (l.group || 'General').toLowerCase() === state.selectedGroup.toLowerCase());
    }

    function onGroupChanged(groupName) {
      state.selectedGroup = groupName;
      updateStats();
      renderTable();
    }

    function onGlobalTemplateChanged(tplKey) {
      state.globalTemplate = tplKey;
      applyTemplateToAll(false);
      updateTemplateMediaBadge();
    }

    function applyTemplateToAll(showToastAlert = true) {
      const groupLeads = getFilteredByGroup();
      groupLeads.forEach(l => {
        l.selectedTemplate = state.globalTemplate;
      });
      renderTable();
      if (showToastAlert) {
        showToast('Applied template "' + (state.templates[state.globalTemplate]?.title || state.globalTemplate) + '" to all ' + groupLeads.length + ' contacts.');
      }
    }

    function updateTemplateMediaBadge() {
      const badge = document.getElementById('templateMediaBadge');
      const tpl = state.templates[state.globalTemplate];
      if (tpl && tpl.mediaUrl) {
        badge.style.display = 'inline-flex';
        badge.innerText = tpl.mediaType === 'video' ? '🎥 Video Attached' : '🖼️ Photo Attached';
      } else {
        badge.style.display = 'none';
      }
    }

    function setFilter(filter, btn) {
      state.activeFilter = filter;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTable();
    }

    function renderGroupDropdown() {
      const select = document.getElementById('groupSelect');
      select.innerHTML = state.groups.map(g => \`
        <option value="\${g.name}" \${g.name === state.selectedGroup ? 'selected' : ''}>
          \${g.name === 'All' ? '🌐 All Contacts' : '📁 Group: ' + g.name} (\${g.count})
        </option>
      \`).join('');
    }

    function renderGlobalTemplateDropdown() {
      const select = document.getElementById('globalTemplateSelect');
      const keys = Object.keys(state.templates);
      if (keys.length === 0) {
        select.innerHTML = '<option value="">No templates defined</option>';
        return;
      }
      select.innerHTML = keys.map(k => {
        const tpl = state.templates[k];
        const mediaIcon = tpl.mediaUrl ? (tpl.mediaType === 'video' ? ' 🎥' : ' 🖼️') : '';
        return \`<option value="\${k}" \${k === state.globalTemplate ? 'selected' : ''}>\${tpl.title}\${mediaIcon}</option>\`;
      }).join('');
      updateTemplateMediaBadge();
    }

    function renderTable() {
      const tbody = document.getElementById('tableBody');
      const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();
      const groupLeads = getFilteredByGroup();

      const filtered = groupLeads.filter(lead => {
        if (state.activeFilter === 'sent' && !lead.isSent) return false;
        if (state.activeFilter === 'pending' && lead.isSent) return false;

        if (search) {
          const matchName = (lead.name || '').toLowerCase().includes(search);
          const matchPhone = (lead.phone || '').toLowerCase().includes(search);
          const matchOrder = (lead.orderId || '').toLowerCase().includes(search);
          const matchGroup = (lead.group || '').toLowerCase().includes(search);
          if (!matchName && !matchPhone && !matchOrder && !matchGroup) return false;
        }
        return true;
      });

      if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 32px; color: #888;">No contacts found for selected group & filter.</td></tr>';
        return;
      }

      const availableTemplates = Object.keys(state.templates);

      tbody.innerHTML = filtered.map(lead => {
        const currentTplKey = lead.selectedTemplate || state.globalTemplate || availableTemplates[0] || 'welcome';
        const tplObj = state.templates[currentTplKey] || { text: '', mediaUrl: '', mediaType: '' };

        let msg = '';
        if (lead.customMessage && currentTplKey === '__custom__') {
          msg = lead.customMessage;
        } else {
          msg = renderTemplateText(tplObj.text || '', lead.variables);
        }

        const normalizedPhone = cleanPhone(lead.phone);
        const waLink = 'https://wa.me/' + normalizedPhone + '?text=' + encodeURIComponent(msg);

        const statusPill = lead.isSent
          ? '<span class="badge-sent">✓ Sent</span>'
          : '<span class="badge-pending">⏳ Pending</span>';

        // Media thumbnail
        let mediaHtml = '';
        if (tplObj.mediaUrl) {
          if (tplObj.mediaType === 'video') {
            mediaHtml = \`
              <div class="media-thumb-preview">
                <span class="media-indicator">🎥 Video Attached</span>
                <a href="\${tplObj.mediaUrl}" target="_blank" style="font-size: 11px; color: #008069;">View Video</a>
              </div>
            \`;
          } else {
            mediaHtml = \`
              <div class="media-thumb-preview">
                <img src="\${tplObj.mediaUrl}" class="media-thumb" onclick="window.open('\${tplObj.mediaUrl}', '_blank')" alt="Attachment" title="Click to open full image" />
                <div>
                  <button type="button" class="btn btn-secondary btn-sm" style="font-size: 11px; padding: 2px 7px;" onclick="copyImageToClipboard('\${tplObj.mediaUrl}')">
                    📋 Copy Image
                  </button>
                </div>
              </div>
            \`;
          }
        }

        return \`
          <tr>
            <td>\${statusPill}</td>
            <td>
              <div class="lead-name">\${lead.name || 'Unnamed'}</div>
              <div class="lead-phone">\${lead.phone || '<span style="color:#e53e3e">No Phone</span>'}</div>
              <span class="group-pill">📁 \${lead.group || 'General'}</span>
            </td>
            <td>
              \${lead.orderId ? '<span class="meta-tag">#' + lead.orderId + '</span>' : ''}
              \${lead.status ? '<span class="meta-tag">' + lead.status + '</span>' : ''}
              \${lead.time ? '<span class="meta-tag">⏰ ' + lead.time + '</span>' : ''}
            </td>
            <td>
              <select onchange="changeLeadTemplate(\${lead.id}, this.value)" style="margin-bottom: 4px;">
                \${lead.customMessage ? '<option value="__custom__" ' + (currentTplKey === '__custom__' ? 'selected' : '') + '>📄 Custom Message (from Sheet)</option>' : ''}
                \${availableTemplates.map(k => \`<option value="\${k}" \${k === currentTplKey ? 'selected' : ''}>\${state.templates[k].title}\${state.templates[k].mediaUrl ? ' (Media)' : ''}</option>\`).join('')}
              </select>
              \${mediaHtml}
              <div class="msg-preview" id="preview-\${lead.id}">\${msg}</div>
            </td>
            <td style="text-align: center;">
              <div class="action-group">
                <a href="\${waLink}" target="_blank" onclick="handleSendClick(\${lead.id}, '\${tplObj.mediaUrl || ''}')" class="btn-wa \${lead.isSent ? 'sent' : ''}">
                  <span>\${lead.isSent ? 'Resend' : 'Send'}</span> 💬
                </a>
                \${tplObj.mediaUrl && tplObj.mediaType !== 'video' ? \`<span style="font-size: 10px; color: #666;">(Image copied on send)</span>\` : ''}
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
      renderTable();
    }

    async function handleSendClick(leadId, mediaUrl) {
      markSent(leadId);
      if (mediaUrl && !mediaUrl.match(/\\.(mp4|mov|webm)$/i)) {
        await copyImageToClipboard(mediaUrl, false);
        showToast('Image copied to clipboard! In WhatsApp Web, press Cmd+V (or Ctrl+V) to paste the image.');
      }
    }

    async function copyImageToClipboard(imageUrl, showToastMsg = true) {
      try {
        const response = await fetch(imageUrl);
        const blob = await response.blob();
        
        // Convert to PNG blob if JPEG (ClipboardItem requires image/png in some browsers)
        let pngBlob = blob;
        if (blob.type !== 'image/png') {
          pngBlob = await convertBlobToPng(blob);
        }

        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': pngBlob })
        ]);
        if (showToastMsg) showToast('Image copied to clipboard! Paste it into WhatsApp with Cmd+V / Ctrl+V.');
      } catch (err) {
        console.warn('Direct image clipboard copy failed:', err);
        if (showToastMsg) showToast('Image link ready: ' + imageUrl);
      }
    }

    function convertBlobToPng(blob) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width;
          canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          canvas.toBlob(b => resolve(b), 'image/png');
        };
        img.onerror = reject;
        img.src = URL.createObjectURL(blob);
      });
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

    // Connect Sheet
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

        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to connect sheet');

        state.sheetStatus = data.sheetStatus;
        state.leads = data.leads;
        state.groups = data.groups;
        updateBadge();
        renderGroupDropdown();
        updateStats();
        applyTemplateToAll(false);
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
        if (!res.ok || !data.success) throw new Error(data.error || 'Failed to sync');

        state.sheetStatus = data.sheetStatus;
        state.leads = data.leads;
        state.groups = data.groups;
        updateBadge();
        renderGroupDropdown();
        updateStats();
        applyTemplateToAll(false);
        renderTable();
        showToast(data.message);
      } catch (err) {
        alert('Sync error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔄 Refresh</span>';
      }
    }

    // --- MODAL: GROUP NUMBERS INSPECTOR ---
    function openGroupModal() {
      const modal = document.getElementById('groupModal');
      const title = document.getElementById('groupModalTitle');
      const body = document.getElementById('groupModalBody');
      const groupLeads = getFilteredByGroup();

      title.innerHTML = '👥 Group: <strong>' + state.selectedGroup + '</strong> (' + groupLeads.length + ' Contacts)';
      body.innerHTML = groupLeads.map(l => \`
        <tr>
          <td><strong>\${l.name}</strong></td>
          <td style="font-family: monospace; color: #008069;">\${cleanPhone(l.phone)}</td>
          <td>\${l.isSent ? '<span style="color:#0E702A; font-weight:600;">Sent</span>' : '<span style="color:#64748B;">Pending</span>'}</td>
        </tr>
      \`).join('');

      modal.classList.add('open');
    }

    function closeGroupModal() {
      document.getElementById('groupModal').classList.remove('open');
    }

    function copyGroupNumbers(separator) {
      const groupLeads = getFilteredByGroup();
      const numbers = groupLeads
        .map(l => cleanPhone(l.phone))
        .filter(p => p.length >= 7);

      if (numbers.length === 0) {
        alert('No valid phone numbers found in this group.');
        return;
      }

      const text = numbers.join(separator === '\\n' ? '\\n' : ', ');
      navigator.clipboard.writeText(text);
      showToast('Copied ' + numbers.length + ' phone numbers to clipboard!');
    }

    // --- MODAL: TEMPLATE & MEDIA MANAGER ---
    let editingTemplateKey = null;

    function openTemplatesModal() {
      renderTemplateEditorPicker();
      renderAvailableTags();
      const keys = Object.keys(state.templates);
      if (keys.length > 0) {
        loadTemplateIntoEditor(keys[0]);
      } else {
        createNewTemplateForm();
      }
      document.getElementById('templatesModal').classList.add('open');
    }

    function closeTemplatesModal() {
      document.getElementById('templatesModal').classList.remove('open');
    }

    function renderTemplateEditorPicker() {
      const picker = document.getElementById('editTplPicker');
      picker.innerHTML = Object.entries(state.templates).map(([k, tpl]) => \`
        <option value="\${k}">\${tpl.title} (\${k})\${tpl.mediaUrl ? ' 🖼️' : ''}</option>
      \`).join('');
    }

    function renderAvailableTags() {
      const container = document.getElementById('availableTags');
      const headers = state.sheetStatus.headers || ['name', 'phone', 'group', 'orderId', 'status', 'time'];
      container.innerHTML = '<span style="font-size: 11px; color:#555;">Click tag to insert:</span> ' + headers.map(h => \`
        <span class="tag-pill" onclick="insertTagIntoText('{{\${h}}}')">{{\${h}}}</span>
      \`).join(' ');
    }

    function insertTagIntoText(tag) {
      const textarea = document.getElementById('tplTextInput');
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = textarea.value.substring(0, start) + tag + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + tag.length;
      textarea.focus();
    }

    function loadTemplateIntoEditor(key) {
      editingTemplateKey = key;
      document.getElementById('editTplPicker').value = key;
      const tpl = state.templates[key] || { title: '', text: '', mediaUrl: '', mediaType: '' };

      document.getElementById('tplKeyInput').value = key;
      document.getElementById('tplKeyInput').disabled = true; // don't change key on edit
      document.getElementById('tplTitleInput').value = tpl.title || '';
      document.getElementById('tplTextInput').value = tpl.text || '';
      document.getElementById('tplMediaUrlInput').value = tpl.mediaUrl || '';
      document.getElementById('deleteTplBtn').style.display = 'inline-flex';

      updateMediaPreviewInEditor();
    }

    function createNewTemplateForm() {
      editingTemplateKey = null;
      document.getElementById('tplKeyInput').value = '';
      document.getElementById('tplKeyInput').disabled = false;
      document.getElementById('tplTitleInput').value = '';
      document.getElementById('tplTextInput').value = '';
      document.getElementById('tplMediaUrlInput').value = '';
      document.getElementById('deleteTplBtn').style.display = 'none';
      updateMediaPreviewInEditor();
    }

    function updateMediaPreviewInEditor() {
      const url = document.getElementById('tplMediaUrlInput').value.trim();
      const previewBox = document.getElementById('mediaEditorPreviewBox');
      const content = document.getElementById('mediaEditorPreviewContent');

      if (!url) {
        previewBox.style.display = 'none';
        content.innerHTML = '';
        return;
      }

      previewBox.style.display = 'block';
      const isVideo = url.match(/\\.(mp4|mov|webm)$/i);
      if (isVideo) {
        content.innerHTML = \`<video src="\${url}" controls style="max-width: 100%; max-height: 140px; border-radius: 6px;"></video>\`;
      } else {
        content.innerHTML = \`<img src="\${url}" style="max-width: 100%; max-height: 140px; border-radius: 6px; object-fit: contain;" alt="Preview" />\`;
      }
    }

    async function uploadSelectedMedia() {
      const fileInput = document.getElementById('mediaFileInput');
      if (!fileInput.files || fileInput.files.length === 0) {
        alert('Please choose a file to upload first.');
        return;
      }

      const formData = new FormData();
      formData.append('mediaFile', fileInput.files[0]);

      try {
        showToast('Uploading media file...');
        const res = await fetch('/api/upload-media', {
          method: 'POST',
          body: formData
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Upload failed');

        document.getElementById('tplMediaUrlInput').value = data.url;
        updateMediaPreviewInEditor();
        showToast('Media uploaded successfully!');
      } catch (err) {
        alert('Media upload failed: ' + err.message);
      }
    }

    async function saveCurrentTemplate() {
      const key = (document.getElementById('tplKeyInput').value || '').trim();
      const title = (document.getElementById('tplTitleInput').value || '').trim();
      const text = (document.getElementById('tplTextInput').value || '').trim();
      const mediaUrl = (document.getElementById('tplMediaUrlInput').value || '').trim();

      if (!key) {
        alert('Please enter a Template Key.');
        return;
      }
      if (!text) {
        alert('Please enter Template Message Text.');
        return;
      }

      try {
        const res = await fetch('/api/templates/save-single', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, title, text, mediaUrl })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Failed to save template');

        state.templates = data.templates;
        renderGlobalTemplateDropdown();
        renderTemplateEditorPicker();
        renderTable();
        closeTemplatesModal();
        showToast('Template saved successfully!');
      } catch (e) {
        alert('Error: ' + e.message);
      }
    }

    async function deleteCurrentTemplate() {
      if (!editingTemplateKey) return;
      if (!confirm('Are you sure you want to delete template "' + editingTemplateKey + '"?')) return;

      try {
        const res = await fetch('/api/templates/' + encodeURIComponent(editingTemplateKey), { method: 'DELETE' });
        const data = await res.json();
        state.templates = data.templates;
        renderGlobalTemplateDropdown();
        renderTable();
        closeTemplatesModal();
        showToast('Template deleted.');
      } catch (e) {
        alert('Delete failed: ' + e.message);
      }
    }

    // Initial load
    async function init() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();
        state.sheetStatus = data.sheetStatus;
        state.leads = data.leads;
        state.groups = data.groups || [];
        state.templates = data.templates;
        state.globalTemplate = data.defaultTemplate || Object.keys(data.templates)[0] || 'welcome';
        state.defaultCountryCode = data.defaultCountryCode || '91';

        if (state.sheetStatus.sheetUrl) {
          document.getElementById('sheetUrlInput').value = state.sheetStatus.sheetUrl;
        }

        updateBadge();
        renderGroupDropdown();
        renderGlobalTemplateDropdown();
        updateStats();
        applyTemplateToAll(false);
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
