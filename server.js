const express = require('express');
const AdmZip = require('adm-zip');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const SEC_LIST_URL_EN = 'https://market.sec.or.th/public/idisc/en/Viewmore/fs-r561';
const SEC_LIST_URL_TH = 'https://market.sec.or.th/public/idisc/th/Viewmore/fs-r561';
// kept for the Referer header used on zip downloads
const SEC_LIST_URL = SEC_LIST_URL_EN;
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

const ROW_RE =
  /<tr><td class="RgCol_Left">([\s\S]*?)<\/td><td class="RgCol_Center">([\s\S]*?)<\/td><td class="RgCol_Center">([\s\S]*?)<\/td><td class="icon30 text-center"><a href="([^"]+)"/g;

function parseRows(html) {
  const rows = [];
  let m;
  ROW_RE.lastIndex = 0;
  while ((m = ROW_RE.exec(html))) {
    const name = decodeEntities(m[1]);
    const year = decodeEntities(m[2]);
    const receiveDate = decodeEntities(m[3]);
    const zipUrl = decodeEntities(m[4]);
    if (!name || !zipUrl) continue;
    const codeMatch = zipUrl.match(/\/f56\/F?(\d+)/i);
    rows.push({ name, year, receiveDate, zipUrl, code: codeMatch ? codeMatch[1] : null });
  }
  return rows;
}

// Thai rows use the Buddhist calendar (year +543, same day/month) for both the
// fiscal year label and the receive date. Convert a Thai dd/mm/yyyy string to
// its Gregorian equivalent so it can be matched against the English listing.
function thaiDateToGregorian(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return dateStr;
  const [d, mo, yBE] = parts;
  const yAD = Number(yBE) - 543;
  return `${d}/${mo}/${yAD}`;
}

// The "year" column sometimes carries extra text, e.g.
// "2569 (กรณีเปลี่ยนธุรกิจ/ผู้ถือหุ้น)" — pull out just the leading number.
function extractYearNum(yearStr) {
  const m = String(yearStr).match(/\d{4}/);
  return m ? Number(m[0]) : null;
}

// dd/mm/yyyy -> a sortable number (yyyymmdd), for picking the most recent of
// several same-year filings.
function dateToComparable(dateStr) {
  const parts = dateStr.split('/');
  if (parts.length !== 3) return 0;
  const [d, mo, y] = parts;
  return Number(y) * 10000 + Number(mo) * 100 + Number(d);
}

// The site's active page language seems to live in server-side
// session/application state rather than being derived purely from the URL:
// fetching /en/ and /th/ concurrently (or back-to-back) can race and both
// come back in the same language. Detect that and retry with a short pause.
function looksEnglish(html) {
  return /PUBLIC COMPANY LIMITED/i.test(html);
}
function looksThai(html) {
  return /จำกัด\s*\(มหาชน\)/.test(html);
}

async function fetchListPage(url, validate, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchWithRetry(url, { headers: { Referer: url } });
    const html = await res.text();
    if (validate(html)) return html;
    console.warn(`SEC ${label} page came back in the wrong language (attempt ${attempt + 1}), retrying...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`SEC ${label} page kept returning the wrong language after retries`);
}

let indexLoadInFlight = null;

// Guards against the classic cold-start pile-up: the server kicks off a
// background refresh at startup, and if a request lands before that
// finishes it would otherwise start its *own* full fetch+parse of both SEC
// listing pages (multiple megabytes, a slow/flaky host) in parallel with
// the one already running. Route every caller through the same promise
// instead.
async function loadIndex(force = false) {
  if (!force && indexCache.rows.length && Date.now() - indexCache.fetchedAt < INDEX_TTL_MS) {
    return indexCache;
  }
  if (indexLoadInFlight) return indexLoadInFlight;

  indexLoadInFlight = loadIndexUncached(force).finally(() => {
    indexLoadInFlight = null;
  });
  return indexLoadInFlight;
}

async function loadIndexUncached(force) {
  if (!force && indexCache.rows.length && Date.now() - indexCache.fetchedAt < INDEX_TTL_MS) {
    return indexCache;
  }

  let htmlEn, htmlTh;
  try {
    // Fetched sequentially (not in parallel) and validated, see note above.
    htmlEn = await fetchListPage(SEC_LIST_URL_EN, looksEnglish, 'English');
    htmlTh = await fetchListPage(SEC_LIST_URL_TH, looksThai, 'Thai');
  } catch (e) {
    if (indexCache.rows.length) {
      console.warn(`Refreshing the SEC filing index failed (${e.message}); keeping the previous copy.`);
      return indexCache;
    }
    throw e;
  }

  const rowsEn = parseRows(htmlEn);
  const rowsTh = parseRows(htmlTh);

  // Companies commonly file the Thai and English copies of the same fiscal
  // year's report weeks or months apart — Thai first (it's due sooner),
  // then an English translation later, sometimes not at all yet. So the
  // two listings can't just be zipped together by row: build them per
  // (company code, Gregorian fiscal year) and take the union, so a year
  // that only has a Thai filing so far (e.g. a just-missed EN deadline)
  // still shows up instead of disappearing entirely.
  const enByCodeYear = new Map(); // code|year -> { zipUrl, receiveDate }
  const enNameByCode = new Map(); // code -> most-recently-seen English name
  for (const r of rowsEn) {
    if (!r.code) continue;
    const yearNum = extractYearNum(r.year);
    if (yearNum == null) continue;
    enByCodeYear.set(`${r.code}|${yearNum}`, { zipUrl: r.zipUrl, receiveDate: r.receiveDate });
    const existingName = enNameByCode.get(r.code);
    if (!existingName || dateToComparable(r.receiveDate) > dateToComparable(existingName.receiveDate)) {
      enNameByCode.set(r.code, { name: r.name, receiveDate: r.receiveDate });
    }
  }

  const dateKeyToZip = new Map(); // code|receiveDate(AD) -> Thai zipUrl, for exact-date matches
  const thByCodeYear = new Map(); // code|year -> { zipUrl, receiveDate(AD), dateNum }
  for (const r of rowsTh) {
    if (!r.code) continue;
    const receiveDateAD = thaiDateToGregorian(r.receiveDate);
    dateKeyToZip.set(`${r.code}|${receiveDateAD}`, r.zipUrl);

    const yearNum = extractYearNum(r.year);
    if (yearNum == null) continue;
    const key = `${r.code}|${yearNum - 543}`;
    const dateNum = dateToComparable(receiveDateAD);
    const existing = thByCodeYear.get(key);
    if (!existing || dateNum > existing.dateNum) {
      thByCodeYear.set(key, { zipUrl: r.zipUrl, receiveDate: receiveDateAD, dateNum });
    }
  }

  const codeYearKeys = new Set([...enByCodeYear.keys(), ...thByCodeYear.keys()]);
  const rows = [];
  for (const key of codeYearKeys) {
    const [code, yearStr] = key.split('|');
    const name = enNameByCode.get(code)?.name;
    if (!name) continue; // no known English name for this company — can't be searched for anyway

    const en = enByCodeYear.get(key) || null;
    const th = en ? dateKeyToZip.get(`${code}|${en.receiveDate}`) : null;
    const thFallback = thByCodeYear.get(key) || null;

    rows.push({
      name,
      year: yearStr,
      receiveDate: en ? en.receiveDate : thFallback.receiveDate,
      code,
      urls: {
        en: en ? en.zipUrl : null,
        th: th || (thFallback ? thFallback.zipUrl : null),
      },
    });
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
        2,
      );
      const data = await res.json();
      for (const quote of data.quotes || []) {
        if (quote.exchange === 'SET' && quote.longname) {
          seen.set(quote.symbol, quote);
        }
      }
    } catch (e) {
      // Best effort — but log it, since a Yahoo failure with no fallback
      // means the search comes back empty with no indication why.
      console.warn(`Yahoo Finance lookup failed for "${q}": ${e.message}`);
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

// Some filings bundle both language PDFs in a single zip (e.g. Land and
// Houses' Thai submission also contains an "E_ONE_REPORT_..." English copy),
// and naming isn't fully consistent (underscores, "ONE_REPORT" vs
// "ONEREPORT"). Score each candidate for the language we actually want.
function pickPrimaryPdf(entries, lang) {
  const isOneReport = (name) => /ONE[_\s]*REPORT|56.?1/i.test(name);
  const pool = entries.filter((e) => isOneReport(e.entryName));
  const candidates = pool.length ? pool : entries;

  const score = (name) => {
    const upper = name.toUpperCase();
    const isEnglish = /^E[_-]/.test(upper) || upper.includes('ENGLISH') || /E\.PDF$/.test(upper);
    const isThai = /T\.PDF$/.test(upper) && !isEnglish;
    if (lang === 'en') return isEnglish ? 2 : isThai ? -1 : 0;
    return isThai ? 2 : isEnglish ? -1 : 0;
  };

  return candidates
    .slice()
    .sort((a, b) => score(b.entryName) - score(a.entryName) || b.size - a.size)[0];
}

// ---------- Infrastructure / Property Fund annual reports (MRAP) ----------
//
// Infrastructure funds and (older-style) property funds — e.g. DIF — are
// organised as mutual funds ("กองทุนรวม"), not public companies, so they
// never file a 56-1 One Report. Their annual reports instead live on the
// SEC's separate "MRAP" (Mutual Fund Report and Prospectus) system, an
// ASP.NET WebForms app that requires replaying its __VIEWSTATE/
// __EVENTVALIDATION postback fields to search. Modern REITs (a Trust
// structure, not a fund) are NOT covered by this — they aren't in MRAP
// either, as far as we've found.

const MRAP_URL = 'https://market.sec.or.th/public/mrap/MRAPDefault.aspx';
const MRAP_VIEW_URL = 'https://market.sec.or.th/public/mrap/MRAPView.aspx';
const MRAP_FILE_PREFIX = 'https://market.sec.or.th/public/mrap/MRAPFile.aspx?';

function extractHiddenField(html, id) {
  const re = new RegExp(`id="${id}"[^>]*value="([^"]*)"`);
  const m = html.match(re);
  return m ? m[1] : '';
}

async function mrapSearchCandidates(query) {
  const res1 = await fetchWithRetry(MRAP_URL, {}, 1);
  const html1 = await res1.text();
  const cookies = typeof res1.headers.getSetCookie === 'function' ? res1.headers.getSetCookie() : [];
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');

  const body = new URLSearchParams({
    ctl00_ToolkitScriptManager1_HiddenField: extractHiddenField(html1, 'ctl00_ToolkitScriptManager1_HiddenField'),
    __EVENTTARGET: '',
    __EVENTARGUMENT: '',
    __VIEWSTATE: extractHiddenField(html1, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: extractHiddenField(html1, '__VIEWSTATEGENERATOR'),
    __SCROLLPOSITIONX: '0',
    __SCROLLPOSITIONY: '0',
    __EVENTVALIDATION: extractHiddenField(html1, '__EVENTVALIDATION'),
    'ctl00$contentMain$ddlFundType': '',
    'ctl00$contentMain$txtSearchName': query,
    'ctl00$contentMain$ddlCompany': '',
    'ctl00$contentMain$ddlFundStatus': 'AC',
    'ctl00$contentMain$cpe_ClientState': 'true',
    'ctl00$contentMain$ddlInvestorType': '',
    'ctl00$contentMain$ddlProjectType': '',
    'ctl00$contentMain$ddlInvestmentPolicyPolicy': '',
    'ctl00$contentMain$ddlSpecialFundType': '',
    'ctl00$contentMain$ddlForeignInvestmentInvestType': '',
    'ctl00$contentMain$ddlDividendInfoDividendPolicy': '',
    ctl00_contentMain_gvwFund_ClientState: '',
    'ctl00$contentMain$btnSearch.x': '10',
    'ctl00$contentMain$btnSearch.y': '10',
  });

  const res2 = await fetchWithRetry(
    MRAP_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookieHeader,
        Referer: MRAP_URL,
      },
      body: body.toString(),
    },
    1,
  );
  const html2 = await res2.text();

  const rowRe =
    /<a id="[^"]*_lnkView" href="MRAPView\.aspx\?FTYPE=([A-Z])&amp;PID=(\d+)&amp;PYR=(\d+)"[^>]*>([^<]*)<\/a>[\s\S]*?<a id="[^"]*_lnkView2"[^>]*>([^<]*)<\/a>[\s\S]*?<td class="alignleft">([^<]*)<\/td>/g;

  const candidates = [];
  let m;
  while ((m = rowRe.exec(html2))) {
    candidates.push({
      shortName: decodeEntities(m[4]).trim(),
      fullName: decodeEntities(m[5]).trim(),
      status: decodeEntities(m[6]).trim(),
      ftype: m[1],
      pid: m[2],
      pyr: m[3],
    });
  }
  return candidates;
}

async function mrapAnnualReports(ftype, pid, pyr) {
  const url = `${MRAP_VIEW_URL}?FTYPE=${ftype}&PID=${pid}&PYR=${pyr}`;
  const res = await fetchWithRetry(url, { headers: { Referer: MRAP_URL } });
  const html = await res.text();

  const linkRe = /<a[^>]*href="(MRAPFile\.aspx\?[^"]*REPORTID=46[^"]*)"[^>]*>/g;
  const seen = new Map();
  let m;
  while ((m = linkRe.exec(html))) {
    const href = decodeEntities(m[1]);
    const periodMatch = href.match(/PERIOD=(\d{4}-\d{2}-\d{2})/);
    if (!periodMatch) continue;
    const period = periodMatch[1];
    const year = period.slice(0, 4);
    // some periods appear more than once (e.g. amended filings); keep one per year
    if (!seen.has(year)) {
      seen.set(year, { year, period, url: 'https://market.sec.or.th/public/mrap/' + href });
    }
  }
  return [...seen.values()].sort((a, b) => b.year.localeCompare(a.year));
}

async function findFund(query) {
  const q = query.trim().toUpperCase();
  if (!q) return null;
  let candidates;
  try {
    candidates = await mrapSearchCandidates(q);
  } catch (e) {
    console.warn('MRAP fund search failed:', e.message);
    return null;
  }
  // Exact short-code match only — a prefix match (e.g. "CPN" loosely
  // matching the unrelated fund "CPNCG") would hijack real stock searches
  // that happen to be a prefix of some fund's short code.
  const match = candidates.find((c) => c.shortName.toUpperCase() === q);
  if (!match) return null;

  const filings = await mrapAnnualReports(match.ftype, match.pid, match.pyr);
  if (!filings.length) return null;
  return { name: match.fullName, shortName: match.shortName, filings };
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

    // The fund lookup (MRAP) is a slow multi-request round-trip to a
    // government ASP.NET app — only pay for it when the normal 56-1 match
    // isn't already confident, so a plain company search (the common case)
    // stays fast.
    const fund = !scored.length || scored[0].score < 0.6 ? await findFund(q) : null;

    res.json({
      query: q,
      yahoo: yQuotes.map((c) => ({ symbol: c.symbol, longname: c.longname })),
      best: scored[0] || null,
      alternates: scored.slice(1, 6),
      fund: fund || null,
      indexAgeMs: Date.now() - idx.fetchedAt,
    });
  } catch (e) {
    res.status(502).json({ error: 'ค้นหาไม่สำเร็จ: ' + e.message });
  }
});

function resolveZipUrl(filing, lang) {
  const wanted = lang === 'en' ? 'en' : 'th';
  const other = wanted === 'th' ? 'en' : 'th';
  const zipUrl = filing.urls[wanted] || filing.urls[other];
  const usedLang = filing.urls[wanted] ? wanted : other;
  return { zipUrl, usedLang };
}

app.get('/api/report-list', async (req, res) => {
  try {
    const { name, year, lang } = req.query;
    if (!name || !year) return res.status(400).json({ error: 'missing name/year' });
    const idx = await loadIndex();
    const filings = idx.byName.get(name.toString());
    const filing = filings && filings.find((f) => f.year === year.toString());
    if (!filing) return res.status(404).json({ error: 'ไม่พบรายงานปีดังกล่าว' });

    const { zipUrl, usedLang } = resolveZipUrl(filing, lang);
    if (!zipUrl) return res.status(404).json({ error: 'ไม่พบไฟล์เอกสารสำหรับรายงานนี้' });

    const buf = await getZipBuffer(zipUrl);
    const entries = pdfEntriesOf(buf).map(({ entryName, size }) => ({ entryName, size }));
    res.json({ name, year, lang: usedLang, entries });
  } catch (e) {
    res.status(502).json({ error: 'โหลดรายการเอกสารไม่สำเร็จ: ' + e.message });
  }
});

app.get('/api/report', async (req, res) => {
  try {
    const { name, year, entry, lang } = req.query;
    if (!name || !year) return res.status(400).json({ error: 'missing name/year' });
    const idx = await loadIndex();
    const filings = idx.byName.get(name.toString());
    const filing = filings && filings.find((f) => f.year === year.toString());
    if (!filing) return res.status(404).json({ error: 'ไม่พบรายงานปีดังกล่าว' });

    const wantedLang = lang === 'en' ? 'en' : 'th';
    const { zipUrl } = resolveZipUrl(filing, lang);
    if (!zipUrl) return res.status(404).json({ error: 'ไม่พบไฟล์เอกสารสำหรับรายงานนี้' });

    const buf = await getZipBuffer(zipUrl);
    const pdfEntries = pdfEntriesOf(buf);
    if (!pdfEntries.length) return res.status(500).json({ error: 'ไม่พบไฟล์ PDF ในเอกสารที่ยื่น' });

    // Pick by the language the caller actually asked for (not just which zip
    // we ended up fetching) — some Thai submissions bundle an English PDF
    // too, so even a fallback-fetched zip may contain what was asked for.
    const chosen = entry
      ? pdfEntries.find((e) => e.entryName === entry) || pickPrimaryPdf(pdfEntries, wantedLang)
      : pickPrimaryPdf(pdfEntries, wantedLang);

    const pdfBuf = chosen.entry.getData();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(name + '_' + year + '_' + wantedLang + '.pdf')}"`,
    );
    res.setHeader('Cache-Control', 'private, max-age=1800');
    res.send(pdfBuf);
  } catch (e) {
    res.status(502).json({ error: 'เปิดรายงานไม่สำเร็จ: ' + e.message });
  }
});

app.get('/api/fund-report', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !url.toString().startsWith(MRAP_FILE_PREFIX)) {
      return res.status(400).json({ error: 'invalid url' });
    }
    const upstream = await fetchWithRetry(url.toString(), { headers: { Referer: MRAP_VIEW_URL } });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline'); // upstream sends "attachment" — we want it viewable in-tab
    res.setHeader('Cache-Control', 'private, max-age=1800');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: 'เปิดรายงานกองทุนไม่สำเร็จ: ' + e.message });
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
