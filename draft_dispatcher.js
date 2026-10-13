const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const { fetchGoogleSheetData } = require('./googleSheets');

// Configuration Defaults
const USER_DATA_DIR = process.env.CHROME_USER_DATA_DIR || path.join(__dirname, 'chrome-wa-profile');
const DEFAULT_DELAY_MS = 3000; // 3 seconds wait for draft sync

/**
 * Normalizes phone numbers into E.164 without '+' or leading zeros.
 */
function cleanPhoneNumber(phone, defaultCountryCode = '91') {
  if (!phone) return '';
  let cleaned = String(phone).replace(/\D/g, '').replace(/^0+/, '');
  if (cleaned.length === 10) cleaned = defaultCountryCode + cleaned;
  return cleaned;
}

/**
 * Replaces {{variable}} tags in template text
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
 * Loads contacts from a specific Google Sheet tab or fallback sample CSV
 */
async function loadContacts(sheetUrl, targetGid = null) {
  let leads = [];

  if (sheetUrl) {
    try {
      console.log(`📡 Fetching contacts from Google Sheet tab (gid: ${targetGid || 'default'})...`);
      const res = await fetchGoogleSheetData(sheetUrl, targetGid);
      leads = res.leads;
      console.log(`Loaded ${leads.length} contacts from tab: "${res.currentTabName}"`);
      return { leads, tabName: res.currentTabName };
    } catch (err) {
      console.warn(`Could not load Google Sheet (${err.message}). Using sample CSV.`);
    }
  }

  const sampleCsvPath = path.join(__dirname, 'sample_leads.csv');
  const sampleContent = fs.readFileSync(sampleCsvPath, 'utf8');
  const { parse } = require('csv-parse/sync');
  const { normalizeLeadRow } = require('./googleSheets');
  const records = parse(sampleContent, { columns: true, skip_empty_lines: true, trim: true });
  leads = records.map((row, idx) => normalizeLeadRow(row, idx, 'Sample Sheet'));

  return { leads, tabName: 'Sample Sheet' };
}

/**
 * Main dispatcher function: Auto-drafts messages for an entire Sheet Tab in one click
 *
 * @param {Object} options
 * @param {Array} [options.contacts] - Contacts list (or loaded automatically)
 * @param {string} [options.templateText] - Template text with {{variables}}
 * @param {string} [options.gid] - Specific sheet tab gid to draft
 * @param {number} [options.limit] - Max contacts to process
 * @param {Function} [options.onProgress] - Progress callback
 * @param {boolean} [options.useExistingCdp] - Connect via CDP port 9222 instead of launching profile
 */
async function runDraftDispatcher(options = {}) {
  const {
    templateText = 'Hi {{name}}! Friendly update regarding order #{{orderId}}.',
    gid = null,
    limit = 200,
    useExistingCdp = false,
    cdpUrl = 'http://localhost:9222',
    onProgress = () => {}
  } = options;

  let contacts = options.contacts;
  let activeTabName = options.tabName || 'Sheet Tab';

  if (!contacts || contacts.length === 0) {
    const configPath = path.join(__dirname, 'config.json');
    let sheetUrl = '';
    if (fs.existsSync(configPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        sheetUrl = cfg.sheetUrl || '';
      } catch (e) {}
    }
    const loaded = await loadContacts(sheetUrl, gid);
    contacts = loaded.leads;
    activeTabName = loaded.tabName;
  }

  const targetContacts = contacts.slice(0, limit);
  console.log(`\n======================================================`);
  console.log(`🚀 Starting WhatsApp Auto-Draft Dispatcher (1-Click)`);
  console.log(`📑 Sheet Tab: ${activeTabName}`);
  console.log(`👥 Contacts to Draft: ${targetContacts.length}`);
  console.log(`🔒 SAFETY ENFORCED: NO SEND / NO ENTER — DRAFTS ONLY`);
  console.log(`======================================================\n`);

  let context;
  let browser;

  if (useExistingCdp) {
    console.log(`Connecting to existing Chrome instance at ${cdpUrl}...`);
    try {
      browser = await chromium.connectOverCDP(cdpUrl);
      const contexts = browser.contexts();
      context = contexts.length > 0 ? contexts[0] : await browser.newContext();
      console.log(`Connected via Chrome DevTools Protocol (CDP)!`);
    } catch (err) {
      throw new Error(`Failed to connect over CDP (${cdpUrl}): ${err.message}. Make sure Chrome is running with --remote-debugging-port=9222.`);
    }
  } else {
    console.log(`Launching Chrome with persistent user data dir: ${USER_DATA_DIR}`);
    if (!fs.existsSync(USER_DATA_DIR)) {
      fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    }

    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      channel: 'chrome',
      viewport: { width: 1280, height: 850 },
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--start-maximized'
      ]
    });
  }

  const pages = context.pages();
  const page = pages.length > 0 ? pages[0] : await context.newPage();

  // Step 1: Ensure WhatsApp Web is ready
  console.log(`Navigating to WhatsApp Web...`);
  await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

  console.log(`Checking WhatsApp Web login state (Scan QR code if first time)...`);
  try {
    await page.waitForSelector('div[contenteditable="true"][data-tab="3"], #pane-side, div[role="textbox"]', {
      timeout: 90000
    });
    console.log(`✅ WhatsApp Web is logged in and ready!\n`);
  } catch (e) {
    console.warn(`Waiting for login timed out. Please ensure you scan the QR code in the browser window.`);
  }

  const results = [];

  // Step 2: Loop through contacts and prepare drafts
  for (let i = 0; i < targetContacts.length; i++) {
    const contact = targetContacts[i];
    const cleanPhone = cleanPhoneNumber(contact.phone);
    const message = renderTemplate(templateText, contact.variables || contact);

    const progressInfo = {
      index: i + 1,
      total: targetContacts.length,
      contact: contact.name,
      phone: cleanPhone,
      status: 'processing'
    };
    onProgress(progressInfo);

    console.log(`[${i + 1}/${targetContacts.length}] Processing ${contact.name} (${cleanPhone})...`);

    if (!cleanPhone || cleanPhone.length < 8) {
      console.log(`   ⚠️ Skipped: Invalid phone number.`);
      results.push({ contact: contact.name, phone: contact.phone, status: 'invalid_number' });
      continue;
    }

    const waUrl = `https://web.whatsapp.com/send?phone=${cleanPhone}&text=${encodeURIComponent(message)}`;

    try {
      await page.goto(waUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });

      // Selector for chat message box
      const inputSelector = 'footer div[contenteditable="true"], div[data-lexical-editor="true"], div[role="textbox"][contenteditable="true"]';

      // Check for either the input box OR an error dialog
      const chatLoaded = await Promise.race([
        page.waitForSelector(inputSelector, { timeout: 25000 }).then(() => 'ready'),
        page.waitForSelector('button:has-text("OK"), div[data-animate-modal-body="true"]', { timeout: 25000 }).then(() => 'invalid_modal')
      ]).catch(() => 'timeout');

      if (chatLoaded === 'invalid_modal') {
        console.log(`   ❌ Number not registered on WhatsApp or invalid.`);
        const okBtn = await page.$('button:has-text("OK")');
        if (okBtn) await okBtn.click();
        results.push({ contact: contact.name, phone: cleanPhone, status: 'not_on_whatsapp' });
        continue;
      }

      if (chatLoaded === 'timeout') {
        console.log(`   ⚠️ Timeout waiting for chat to load.`);
        results.push({ contact: contact.name, phone: cleanPhone, status: 'timeout' });
        continue;
      }

      // Input box loaded
      const inputBox = await page.$(inputSelector);
      if (inputBox) {
        await inputBox.focus();

        const currentText = await inputBox.innerText();
        if (!currentText || !currentText.trim()) {
          console.log(`   Typing text into input box...`);
          await inputBox.fill(message);
        }

        console.log(`   📝 Draft created in chat!`);
        console.log(`   🛑 SAFE: NO ENTER / NO SEND.`);

        // Wait 3 seconds for WhatsApp Web local registration & mobile sync
        await page.waitForTimeout(DEFAULT_DELAY_MS);

        results.push({ contact: contact.name, phone: cleanPhone, status: 'drafted', message });
        progressInfo.status = 'drafted';
        onProgress(progressInfo);
      } else {
        results.push({ contact: contact.name, phone: cleanPhone, status: 'input_not_found' });
      }

    } catch (err) {
      console.error(`   Error processing ${contact.name}:`, err.message);
      results.push({ contact: contact.name, phone: cleanPhone, status: 'error', error: err.message });
    }

    // Safe pause between contacts
    if (i < targetContacts.length - 1) {
      const pause = 2000 + Math.random() * 1000;
      await page.waitForTimeout(pause);
    }
  }

  console.log(`\n======================================================`);
  console.log(`✅ Draft Dispatch Complete for tab: "${activeTabName}"`);
  console.log(`📊 Total: ${targetContacts.length} | Drafted: ${results.filter(r => r.status === 'drafted').length}`);
  console.log(`📱 All chats are now drafted in WhatsApp. Tap Send manually!`);
  console.log(`======================================================\n`);

  return {
    tabName: activeTabName,
    total: targetContacts.length,
    drafted: results.filter(r => r.status === 'drafted').length,
    results
  };
}

// Allow CLI execution: `node draft_dispatcher.js --gid=0`
if (require.main === module) {
  const args = process.argv.slice(2);
  const gidArg = args.find(a => a.startsWith('--gid='))?.split('=')[1] || null;
  const limitArg = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '200', 10);
  const cdpArg = args.includes('--cdp');

  runDraftDispatcher({
    gid: gidArg,
    limit: limitArg,
    useExistingCdp: cdpArg
  }).then(() => {
    console.log('Script execution finished.');
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = {
  runDraftDispatcher,
  cleanPhoneNumber,
  renderTemplate,
  loadContacts
};
