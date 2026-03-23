'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── App data (custom tags, read status, ELO) stored separately from Calibre ──
const APP_DATA_PATH = path.join(os.homedir(), '.epub-manager', 'data.json');

function loadAppData() {
  try {
    if (fs.existsSync(APP_DATA_PATH)) {
      return JSON.parse(fs.readFileSync(APP_DATA_PATH, 'utf8'));
    }
  } catch (e) {}
  return { libraryPath: '', books: {} };
}

function saveAppData(data) {
  const dir = path.dirname(APP_DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(APP_DATA_PATH, JSON.stringify(data, null, 2));
}

// ── Calibre metadata.db reader ────────────────────────────────────────────────
function readCalibreDb(libraryPath) {
  const Database = require('better-sqlite3');
  const dbPath = path.join(libraryPath, 'metadata.db');

  if (!fs.existsSync(dbPath)) {
    throw new Error(`No metadata.db found in: ${libraryPath}\nIs this a Calibre library folder?`);
  }

  const db = new Database(dbPath, { readonly: true });

  // All books
  const books = db.prepare(`
    SELECT b.id, b.title, b.sort, b.path, b.has_cover, b.timestamp, b.series_index
    FROM books b ORDER BY b.sort COLLATE NOCASE
  `).all();

  // Authors
  const authorsMap = {};
  db.prepare(`
    SELECT ba.book, GROUP_CONCAT(a.name, ' & ') as authors
    FROM books_authors_link ba JOIN authors a ON a.id = ba.author
    GROUP BY ba.book
  `).all().forEach(r => { authorsMap[r.book] = r.authors; });

  // Tags
  const tagsMap = {};
  db.prepare(`
    SELECT bt.book, GROUP_CONCAT(t.name, '||') as tags
    FROM books_tags_link bt JOIN tags t ON t.id = bt.tag
    GROUP BY bt.book
  `).all().forEach(r => { tagsMap[r.book] = r.tags ? r.tags.split('||') : []; });

  // Series (series_index lives on the books table, not books_series_link)
  const seriesMap = {};
  db.prepare(`
    SELECT bs.book, s.name as series
    FROM books_series_link bs JOIN series s ON s.id = bs.series
  `).all().forEach(r => { seriesMap[r.book] = { name: r.series }; });

  // Descriptions
  const descMap = {};
  db.prepare(`SELECT book, text FROM comments`).all()
    .forEach(r => { descMap[r.book] = stripHtml(r.text); });

  // Publishers
  const pubMap = {};
  db.prepare(`
    SELECT bp.book, p.name FROM books_publishers_link bp JOIN publishers p ON p.id = bp.publisher
  `).all().forEach(r => { pubMap[r.book] = r.name; });

  // Custom columns (fandom, etc.)
  const customMap = {};
  try {
    const cols = db.prepare(`SELECT id, label, datatype FROM custom_columns`).all();
    for (const col of cols) {
      const table = `custom_column_${col.id}`;
      try {
        const rows = db.prepare(`SELECT book, value FROM "${table}"`).all();
        rows.forEach(r => {
          if (!customMap[r.book]) customMap[r.book] = {};
          customMap[r.book][col.label] = r.value;
        });
      } catch (_) {}
    }
  } catch (_) {}

  // Formats (epub paths)
  const formatsMap = {};
  db.prepare(`SELECT book, format, name FROM data`).all().forEach(r => {
    if (!formatsMap[r.book]) formatsMap[r.book] = [];
    formatsMap[r.book].push({ format: r.format, name: r.name });
  });

  db.close();

  return books
    .filter(row => !seriesMap[row.id])  // exclude any book that belongs to a series
    .map(row => {
    const tags = tagsMap[row.id] || [];
    const custom = customMap[row.id] || {};

    // Fandom detection: explicit custom column first, then tag heuristics
    let fandom = custom['fandom'] || custom['universe'] || custom['series'] || '';
    const fandonTags = fandom ? [] : tags.filter(looksLikeFandom);
    if (!fandom && fandonTags.length) fandom = fandonTags[0];
    const otherTags = tags.filter(t => t !== fandom && !fandonTags.includes(t));

    const bookPath = path.join(libraryPath, row.path);
    const coverPath = path.join(bookPath, 'cover.jpg');
    const epubFormats = (formatsMap[row.id] || []).filter(f => f.format === 'EPUB');
    const epubPath = epubFormats.length
      ? path.join(bookPath, `${epubFormats[0].name}.epub`)
      : null;

    return {
      id: String(row.id),
      title: row.title || 'Unknown Title',
      author: authorsMap[row.id] || 'Unknown Author',
      description: descMap[row.id] || '',
      tags: otherTags,
      fandom,
      series: seriesMap[row.id] ? seriesMap[row.id].name : '',
      seriesIndex: row.series_index && row.series_index !== 1.0 ? row.series_index : null,
      publisher: pubMap[row.id] || '',
      hasCover: !!row.has_cover,
      coverPath: fs.existsSync(coverPath) ? coverPath : null,
      epubPath,
      custom: Object.fromEntries(
        Object.entries(custom).filter(([k]) => !['fandom','universe'].includes(k))
      ),
    };
  });  // end .map()
}  // end _read_from_sqlite

function looksLikeFandom(tag) {
  const genres = ['romance','action','sci-fi','fantasy','horror','mystery','thriller',
    'comedy','drama','angst','fluff','hurt','comfort','complete','incomplete',
    'english','spanish','french','german','slash','femslash','gen','het'];
  const tl = tag.toLowerCase();
  if (genres.some(g => tl.includes(g))) return false;
  if (tag.includes('/') && tag.length > 3) return true;
  return false;
}

function stripHtml(html) {
  if (!html) return '';
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── IPC handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('pick-library', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('load-library', async (_, libraryPath) => {
  try {
    const books = readCalibreDb(libraryPath);
    return { ok: true, books };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-app-data', () => loadAppData());

ipcMain.handle('save-app-data', (_, data) => {
  saveAppData(data);
  return true;
});

ipcMain.handle('open-epub', async (_, epubPath) => {
  if (epubPath && fs.existsSync(epubPath)) {
    shell.openPath(epubPath);
    return true;
  }
  return false;
});

ipcMain.handle('epub-sample', async (_, epubPath) => {
  if (!epubPath || !fs.existsSync(epubPath)) return null;
  try {
    // EPUBs are zips — find the 2nd content HTML document and extract plain text
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(epubPath);
    const entries = zip.getEntries()
      .filter(e => {
        const n = e.entryName.toLowerCase();
        return (n.endsWith('.html') || n.endsWith('.xhtml') || n.endsWith('.htm')) &&
               !n.includes('toc') && !n.includes('nav') && !n.includes('cover');
      })
      .sort((a, b) => a.entryName.localeCompare(b.entryName));

    // Skip the first two entries (title/cover page, chapter header), use the third
    const entry = entries[2] || entries[1] || entries[0];
    if (!entry) return null;

    const html = zip.readAsText(entry);
    // Strip all tags, decode common entities, preserve paragraph breaks
    const text = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<\/(p|div|br|li|h[1-6])[^>]*>/gi, '\n')   // block-level closes → newline
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, '')
      .replace(/[^\S\n]+/g, ' ')          // collapse spaces/tabs but keep newlines
      .replace(/\n{3,}/g, '\n\n')         // max two consecutive newlines
      .trim();

    // Drop first 4 non-empty lines (usually repeated title/chapter heading)
    const lines = text.split('\n');
    let skipped = 0;
    const trimmed = [];
    for (const line of lines) {
      if (skipped < 4 && line.trim()) { skipped++; continue; }
      trimmed.push(line);
    }
    const result = trimmed.join('\n').replace(/^\n+/, '').trim();

    return result.length > 800 ? result.slice(0, 800) + '…' : result;
  } catch (e) {
    return null;
  }
});

ipcMain.handle('cover-data-url', async (_, coverPath) => {
  try {
    if (coverPath && fs.existsSync(coverPath)) {
      const data = fs.readFileSync(coverPath);
      return `data:image/jpeg;base64,${data.toString('base64')}`;
    }
  } catch (_) {}
  return null;
});

// ── Window ────────────────────────────────────────────────────────────────────

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#0f0f11',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
