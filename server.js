// Minimal REST server: POST /api/schematics { netlist, filename? } -> .schdoc
// Requires: npm i express puppeteer

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7080;
// The app is served by this same server, so default to same-origin URL
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}/`;

async function generateSchdocViaHeadless(netlistText, filename) {
  const browser = await puppeteer.launch({ headless: 'new' });
  try {
    const page = await browser.newPage();
    await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 120000 });

    // Ensure autoAPI exists
    await page.waitForFunction(() => typeof window.autoAPI !== 'undefined', { timeout: 60000 });

    // Import netlist
    await page.evaluate((txt) => {
      window.autoAPI.importNetlist(txt);
    }, netlistText);

    // Place and route
    await page.evaluate(() => {
      return window.autoAPI.placeAndRoute();
    });

    // Export schdoc and return content
    const content = await page.evaluate(async (fname) => {
      const txt = await window.autoAPI.exportSchdoc(fname || 'schematic.schdoc');
      return txt;
    }, filename);

    return content;
  } finally {
    await browser.close();
  }
}

const app = express();
app.use(express.json({ limit: '10mb' }));
// Serve static files (index.html, modules, svglib, etc.) from project root
app.use(express.static(__dirname));

app.post('/api/schematics', async (req, res) => {
  try {
    const { netlist, filename } = req.body || {};
    if (!netlist || typeof netlist !== 'string') {
      return res.status(400).json({ error: 'netlist (string) is required' });
    }
    const name = filename && typeof filename === 'string' ? filename : 'schematic.schdoc';

    const schdocContent = await generateSchdocViaHeadless(netlist, name);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(Buffer.from(schdocContent, 'utf8'));
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message || 'Internal Server Error' });
  }
});

// List svglib SVG files (for client to load without directory index)
app.get('/api/svglib/list', (req, res) => {
  try {
    const dir = path.join(__dirname, 'svglib');
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isFile() && d.name.toLowerCase().endsWith('.svg'))
      .map(d => `/svglib/${d.name}`);
    res.json({ files });
  } catch (err) {
    console.error('list svglib error:', err);
    res.status(500).json({ error: 'failed_to_list_svglib' });
  }
});

app.listen(PORT, () => {
  console.log(`[api] listening on port ${PORT}`);
  console.log(`[api] serving static app at ${APP_URL}`);
});


