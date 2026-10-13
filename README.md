# 💬 WhatsApp Automation Dispatcher with Google Sheets

A fast, lightweight, and modern WhatsApp automation dashboard that connects directly to **Google Sheets**. Load your contacts/leads from Google Sheets, select or customize message templates with dynamic tags, and dispatch personalized messages via official WhatsApp Web / Mobile with one click.

---

## 🚀 Features

- **📊 Direct Google Sheets Integration**: Connect any Google Sheet in seconds by simply pasting its link. No complex Google Cloud credentials or OAuth required!
- **🤖 Semi-Automation Auto-Draft Bot (Playwright)**: Launches persistent Google Chrome, navigates to each contact, and types the message into the box as an **unsent draft**. Strictly obeys the safety rule: **DOES NOT SEND OR HIT ENTER**. Syncs drafts across devices so you can tap Send manually!
- **▲ Vercel Postgres & Cloud Storage**: Seamlessly connect Vercel Postgres (Neon) or Supabase. Permanently stores **only Name & Phone** (contacts), while message text and templates remain ephemeral in memory.
- **⚡ Deploy to Vercel in 1-Click**: Pre-configured `vercel.json` to deploy your full dashboard to a free public Vercel URL.
- **👥 Contact Groups (Audience Segments)**: Auto-detects a `Group` / `Tag` column from Google Sheets (e.g., `VIP`, `New Leads`, `Wholesale`). Filter contacts by group and inspect/copy all numbers in any group in one click!
- **🖼️ Media Templates (Photos & Videos)**: Attach photos or videos to any template via direct file upload or URL. Clicking **Send** automatically copies the image to your clipboard ready for instant `Cmd+V` paste into WhatsApp Web!
- **⚡ 1-Click Global Template Selection**: Set a default template from the top control bar to apply across all contacts in a group instantly.
- **🔄 Live Sync / Refresh**: Modify rows, add leads, or update statuses in Google Sheets and click **Refresh** to reload without restarting the server.
- **🏷️ Dynamic Variable Replacement**: Automatically injects values like `{{name}}`, `{{orderId}}`, `{{status}}`, `{{time}}`, or **any custom column** from your Google Sheet directly into your WhatsApp message.
- **⚡ Official `wa.me` Deep-Links**: Generates standard WhatsApp URLs (`https://wa.me/...`) that open directly in WhatsApp Web or the WhatsApp Desktop/Mobile app with your message pre-filled.
- **✅ Sent Status Tracking**: Automatically marks contacts as **Sent** when you click to dispatch, complete with Quick Stats (Total, Sent, Pending) and filter tabs.
- **📝 In-App Template Editor**: Create, customize, and save multiple message templates directly from the web interface.
- **📥 Sample CSV Export**: Comes with sample lead data and a one-click CSV download to get started immediately.

---

## 📋 How to Format Your Google Sheet

1. Create a spreadsheet on [Google Sheets](https://sheets.new).
2. Set row 1 as your headers. Recommended headers:
   | Name | Phone | OrderId | Status | Time | Template |
   |------|-------|---------|--------|------|----------|
   | Rohit Sharma | +91 98765 43210 | ORD-101 | Out for delivery | 3:00 PM | order_update |
   | Priya Singh | 9123456789 | ORD-102 | Processing | 5:30 PM | welcome |
   | Amit Patel | +91 99887 76655 | ORD-103 | Ready for pickup | 11:00 AM | reminder |

> **Note**: You can also add custom columns like `Address`, `Item`, `Amount`, `TrackingUrl`, etc. Any column name can be used in your message template as `{{columnName}}`!

### Connecting Your Sheet:
1. Click the green **Share** button at the top-right of your Google Sheet.
2. Under **General access**, change from *Restricted* to **"Anyone with the link can view"**.
3. Copy the URL from your browser address bar.
4. Paste it into the dashboard and click **🔗 Connect & Sync**.

---

## 🛠️ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure (Optional)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
You can optionally set:
- `PORT=1212`
- `GOOGLE_SHEET_URL=https://docs.google.com/spreadsheets/d/...`
- `DEFAULT_COUNTRY_CODE=91` (defaults to 91 for India; automatically prepends to 10-digit numbers)

### 3. Start the Server
```bash
npm start
```

### 4. Open the Dashboard
Open your browser and navigate to:
```
http://localhost:1212
```

---

## 📁 Project Structure

```
.
├── index.js             # Express server, API routes, and dashboard UI
├── googleSheets.js      # Google Sheets CSV fetcher and normalizer
├── config.json          # Persistent configuration (sheet URL, templates)
├── sample_leads.csv     # Sample contact dataset
├── package.json         # Project metadata and dependencies
└── README.md            # Documentation
```

---

## 🔒 Privacy & Safety
- Messages are opened using official `wa.me` links directly in your browser.
- No third-party WhatsApp bot APIs or unofficial scrapers that risk WhatsApp account bans.
- Your Google Sheet remains hosted securely on your Google account.

