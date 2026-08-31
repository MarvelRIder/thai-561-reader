const express = require('express');
const AdmZip = require('adm-zip');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SEC_LIST_URL = 'https://market.sec.or.th/public/idisc/en/Viewmore/fs-r561';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const INDEX_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const ZIP_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const ZIP_CACHE_MAX = 15;

let indexCache = { rows: [], byName: new Map(), fetchedAt: 0 };
const zipCache = new Map(); // zipUrl -> { buf, ts }

// ---------- helpers ----------

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

async function fetchWithRetry(url, opts = {}, retries = 3, backoffMs = 800) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, backoffMs * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

const STOPWORDS = new Set([
  'PUBLIC', 'COMPANY', 'LIMITED', 'PCL', 'PLC', 'CO', 'LTD', 'THE',
  'CORPORATION', 'CORP', 'HOLDING', 'HOLDINGS', 'GROUP', 'INTERNATIONAL',
]);

function normalizeName(name) {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9ก-๙ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(name) {
  return normalizeName(name)
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w));
}

function scoreMatch(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return inter / union;
}

// ---------- SEC 56-1 filing index ----------

async function loadIndex(force = false) {
  if (!force && indexCache.rows.length && Date.now() - indexCache.fetchedAt < INDEX_TTL_MS) {
    return indexCache;
  }
  const res = await fetchWithRetry(SEC_LIST_URL, { headers: { Referer: SEC_LIST_URL } });
  const html = await res.text();

  const rowRe =
    /<tr><td class="RgCol_Left">([\s\S]*?)<\/td><td class="RgCol_Center">([\s\S]*?)<\/td><td class="RgCol_Center">([\s\S]*?)<\/td><td class="icon30 text-center"><a href="([^"]+)"/g;

  const rows = [];
  let m;
  while ((m = rowRe.exec(html))) {
    const name = decodeEntities(m[1]);
    const year = decodeEntities(m[2]);
    const receiveDate = decodeEntities(m[3]);
    const zipUrl = decodeEntities(m[4]);
    if (!name || !zipUrl) continue;
    rows.push({ name, year, receiveDate, zipUrl });
  }

  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, []);
    byName.get(r.name).push(r);
  }
  for (const list of byName.values()) {
    list.sort((a, b) => b.year.localeCompare(a.year));
  }

  indexCache = { rows, byName, fetchedAt: Date.now() };
  return indexCache;
}

// ---------- symbol -> company name resolution via Yahoo Finance search ----------

async function yahooCandidates(query) {
  const tries = [`${query}.BK`, query];
  const seen = new Map();
  for (const q of tries) {
    try {
      const res = await fetchWithRetry(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`,
        {},
        1,
      );
      const data = await res.json();
      for (const quote of data.quotes || []) {
        if (quote.exchange === 'SET' && quote.longname) {
          seen.set(quote.symbol, quote);
        }
      }
    } catch (e) {
      // ignore, best effort
    }
  }
  return [...seen.values()];
}

// ---------- zip fetching / extraction ----------

function pruneZipCache() {
  if (zipCache.size <= ZIP_CACHE_MAX) return;
  const entries = [...zipCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  while (entries.length > ZIP_CACHE_MAX) {
    const [key] = entries.shift();
    zipCache.delete(key);
  }
}

async function getZipBuffer(zipUrl) {
  const cached = zipCache.get(zipUrl);
  if (cached && Date.now() - cached.ts < ZIP_CACHE_TTL_MS) return cached.buf;
  const res = await fetchWithRetry(zipUrl, { headers: { Referer: SEC_LIST_URL } });
  const buf = Buffer.from(await res.arrayBuffer());
  zipCache.set(zipUrl, { buf, ts: Date.now() });
  pruneZipCache();
  return buf;
}

function pdfEntriesOf(buf) {
  const zip = new AdmZip(buf);
  return zip
    .getEntries()
    .filter((e) => /\.pdf$/i.test(e.entryName))
    .map((e) => ({ entryName: e.entryName, size: e.header.size, entry: e }));
}

function pickPrimaryPdf(entries) {
  const oneReport = entries.find((e) => /ONEREPORT|56.?1/i.test(e.entryName));
  if (oneReport) return oneReport;
  return entries.slice().sort((a, b) => b.size - a.size)[0];
}

// ---------- routes ----------

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'missing q' });

    const [idx, yQuotes] = await Promise.all([loadIndex(), yahooCandidates(q)]);

    const targets = yQuotes.map((c) => c.longname);
    if (!targets.length) targets.push(q);

    const scored = [];
    for (const [name, filings] of idx.byName) {
      let best = 0;
      for (const t of targets) best = Math.max(best, scoreMatch(name, t));
      if (name.toUpperCase().includes(q.toUpperCase()) && q.length >= 3) {
        best = Math.max(best, 0.35);
      }
      if (best > 0.15) scored.push({ name, score: best, filings });
    }
    scored.sort((a, b) => b.score - a.score);

    res.json({
      query: q,
      yahoo: yQuotes.map((c) => ({ symbol: c.symbol, longname: c.longname })),
      best: scored[0] || null,
      alternates: scored.slice(1, 6),
      indexAgeMs: Date.now() - idx.fetchedAt,
    });
  } catch (e) {
    res.status(502).json({ error: 'ค้นหาไม่สำเร็จ: ' + e.message });
  }
});

app.get('/api/report-list', async (req, res) => {
  try {
    const { name, year } = req.query;
    if (!name || !year) return res.status(400).json({ error: 'missing name/year' });
    const idx = await loadIndex();
    const filings = idx.byName.get(name.toString());
    const filing = filings && filings.find((f) => f.year === year.toString());
    if (!filing) return res.status(404).json({ error: 'ไม่พบรายงานปีดังกล่าว' });

    const buf = await getZipBuffer(filing.zipUrl);
    const entries = pdfEntriesOf(buf).map(({ entryName, size }) => ({ entryName, size }));
    res.json({ name, year, entries });
  } catch (e) {
    res.status(502).json({ error: 'โหลดรายการเอกสารไม่สำเร็จ: ' + e.message });
  }
});

app.get('/api/report', async (req, res) => {
  try {
    const { name, year, entry } = req.query;
    if (!name || !year) return res.status(400).json({ error: 'missing name/year' });
    const idx = await loadIndex();
    const filings = idx.byName.get(name.toString());
    const filing = filings && filings.find((f) => f.year === year.toString());
    if (!filing) return res.status(404).json({ error: 'ไม่พบรายงานปีดังกล่าว' });

    const buf = await getZipBuffer(filing.zipUrl);
    const pdfEntries = pdfEntriesOf(buf);
    if (!pdfEntries.length) return res.status(500).json({ error: 'ไม่พบไฟล์ PDF ในเอกสารที่ยื่น' });

    const chosen = entry
      ? pdfEntries.find((e) => e.entryName === entry) || pickPrimaryPdf(pdfEntries)
      : pickPrimaryPdf(pdfEntries);

    const pdfBuf = chosen.entry.getData();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(name + '_' + year + '.pdf')}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=1800');
    res.send(pdfBuf);
  } catch (e) {
    res.status(502).json({ error: 'เปิดรายงานไม่สำเร็จ: ' + e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, indexRows: indexCache.rows.length, indexAgeMs: Date.now() - indexCache.fetchedAt });
});

app.listen(PORT, () => {
  console.log(`Thai 56-1 reader running at http://localhost:${PORT}`);
  loadIndex().then(
    (idx) => console.log(`Loaded ${idx.rows.length} filing rows from SEC.`),
    (e) => console.warn('Initial index load failed (will retry lazily):', e.message),
  );
});
