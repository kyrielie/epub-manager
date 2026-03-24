'use strict';

// ── Constants ──────────────────────────────────────────────────────────────
const ELO_K       = 32;
const ELO_DEFAULT = 1000;
const ROW_H       = 148; // must match CSS .book-row height
const OVERSCAN    = 8;   // extra rows rendered above/below the visible window

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  calibreBooks: [],
  bookMap:      {},
  searchIndex:  [],
  userBooks:    {},
  libraryPath:  '',
  filter:       'all',
  sort:         'title',
  search:       '',
  detailId:     null,
  visibleList:  [],
};

// Settings — persisted alongside userBooks
const settings = {
  hiddenFilters: {},  // keys to HIDE: rating levels, rel keys, 'ao3', fandom names
  extraFandoms:  [],
};

function isHidden(key) { return !!settings.hiddenFilters[key]; }
function setHidden(key, hidden) {
  if (hidden) settings.hiddenFilters[key] = true;
  else delete settings.hiddenFilters[key];
}

// ── Fandom detection ────────────────────────────────────────────────────────
const BUILTIN_FANDOMS = [
  'Avatar: The Last Airbender','Batman','Supergirl','Bungou Stray Dogs',
  'Check Please!','Chronicles of Narnia','Dream SMP','Genshin Impact',
  'Good Omens','Gravity Falls','Hannibal','Harry Potter','Heartstopper',
  'How to Train Your Dragon','Lord of the Rings','Lunar Chronicles',
  'Marvel Cinematic Universe','Captain America','Guardians of the Galaxy',
  'Thor','Iron Man','Loki','Spiderman','The Avengers','Venom',
  'Merlin','Miraculous Ladybug','My Hero Academia',
  'My Little Pony: Friendship is Magic','Mythology','Naruto',
  'Neon Genesis Evangelion','Omniscient Reader','Original Work',
  'Parks and Recreation','Percy Jackson','Red White & Royal Blue',
  'Rise of the Guardians','Scott Pilgrim','Six of Crows','Star Trek',
  'Star Wars','Supernatural','Tangled','Teen Wolf','The Devil Wears Prada',
  'The Incredibles','Twilight','Unknown','Voltron: Legendary Defender',
  'Warriors','Yuri!!! on Ice','Zootopia',
];

function allFandoms() {
  return [...BUILTIN_FANDOMS, ...(settings.extraFandoms || [])];
}

// Fuzzy: normalize both sides, check substring containment both ways
function normStr(s) { return s.toLowerCase().replace(/[^a-z0-9]/g, ''); }

function detectFandoms(book) {
  const tags = [...(book.tags || []), ...(book.customTags || [])];
  const fandoms = [];
  const fandomList = allFandoms();
  for (const tag of tags) {
    const tn = normStr(tag);
    for (const f of fandomList) {
      const fn = normStr(f);
      if (tn === fn || tn.includes(fn) || fn.includes(tn)) {
        if (!fandoms.includes(f)) fandoms.push(f);
        break;
      }
    }
  }
  return fandoms;
}

// ── Relationship category detection ────────────────────────────────────────
const REL_PATTERNS = [
  { key: 'M/M',   pattern: 'm/m'   },
  { key: 'F/M',   pattern: 'f/m'   },
  { key: 'F/F',   pattern: 'f/f'   },
  { key: 'Gen',   pattern: 'gen'   },
  { key: 'Multi', pattern: 'multi' },
  { key: 'Other', pattern: 'other' },
];

function detectRelationship(book) {
  const tags = [...(book.tags || []), ...(book.customTags || [])].map(t => t.toLowerCase().trim());
  for (const { key, pattern } of REL_PATTERNS) {
    if (tags.some(t => t === pattern || t === key.toLowerCase())) return key;
  }
  return null;
}

function isAo3Book(book) {
  return (book.publisher || '').toLowerCase().includes('ao3') ||
         (book.publisher || '').toLowerCase().includes('archiveofourown') ||
         (book.tags || []).some(t => /ao3|archive of our own/i.test(t));
}

// ── Compare seen pairs (prevent duplicates) ─────────────────────────────────
const seenPairs = new Set();
function pairKey(a, b) { return [a, b].sort().join('|'); }

// Compare session stats
const compareStats = { total: 0, sessionStart: Date.now() };

// Rating detection for tag highlighting
const RATING_TAGS = {
  explicit: 'explicit',
  mature:   'mature',
  teen:     'teen and up',
  general:  'general audiences',
  notrated: 'not rated',
};

function bookRating(book) {
  const allTags = [...(book.tags || []), ...(book.customTags || [])].map(t => t.toLowerCase());
  for (const [level, pattern] of Object.entries(RATING_TAGS)) {
    if (allTags.some(t => t.includes(pattern))) return level;
  }
  return null;
}

// ── Unified content filter ──────────────────────────────────────────────────
function bookPassesRatingFilter(book) { return bookPassesContentFilter(book); }

function bookPassesContentFilter(book) {
  if (!Object.keys(settings.hiddenFilters).length) return true;

  // Rating
  const rating = bookRating(book);
  if (rating && isHidden(rating)) return false;

  // Relationship
  const rel = detectRelationship(book);
  if (rel && isHidden(rel)) return false;

  // Publisher (AO3)
  if (isHidden('ao3') && isAo3Book(book)) return false;

  // Fandom — hide only if ALL detected fandoms are hidden
  if (isAo3Book(book)) {
    const fandoms = detectFandoms(book);
    if (fandoms.length > 0 && fandoms.every(f => isHidden(f))) return false;
  }

  return true;
}

// Match history lives outside state so it's not mixed with per-book userBooks keys.
// Each entry: { winnerId, loserId, winnerEloBefore, loserEloBefore, winnerEloAfter, loserEloAfter, ts }
let matchHistory = [];   // newest first

// ── ELO ────────────────────────────────────────────────────────────────────
function eloUpdate(wR, lR) {
  const expW = 1 / (1 + Math.pow(10, (lR - wR) / 400));
  return {
    winner: Math.round(wR + ELO_K * (1 - expW)),
    loser:  Math.round(lR + ELO_K * (0 - (1 - expW))),
  };
}

// ── User records ───────────────────────────────────────────────────────────
function getUser(id) {
  if (!state.userBooks[id])
    state.userBooks[id] = { read: false, customTags: [], elo: ELO_DEFAULT, matchCount: 0 };
  return state.userBooks[id];
}

function mergedBook(book) {
  const u = getUser(book.id);
  return {
    id: book.id, title: book.title, author: book.author,
    description: book.description, tags: book.tags, fandom: book.fandom,
    series: book.series, seriesIndex: book.seriesIndex,
    publisher: book.publisher, epubPath: book.epubPath, custom: book.custom,
    read: u.read, customTags: u.customTags, elo: u.elo, matchCount: u.matchCount,
  };
}

// ── Search index ───────────────────────────────────────────────────────────
function buildSearchIndex(books) {
  return books.map(b =>
    [b.title, b.author, b.fandom || '', b.series || '', ...b.tags].join('\0').toLowerCase()
  );
}

// ── Filtering / sorting → visibleList ──────────────────────────────────────
function recomputeVisible() {
  const q      = state.search.toLowerCase();
  const filter = state.filter;
  const sort   = state.sort;
  const books  = state.calibreBooks;
  const idx    = state.searchIndex;
  const uBooks = state.userBooks;

  const result = [];
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    const u = uBooks[b.id] || { read: false, customTags: [], elo: ELO_DEFAULT, matchCount: 0 };

    if (filter === 'read'     && !u.read) continue;
    if (filter === 'unread'   &&  u.read) continue;
    if (filter === 'later'    && !(u.customTags && u.customTags.includes('later')))    continue;
    if (filter === 'rejected' && !(u.customTags && u.customTags.includes('rejected'))) continue;

    if (!bookPassesRatingFilter(b)) continue;

    if (q) {
      const inIndex  = idx[i].includes(q);
      const inCustom = !inIndex && u.customTags.some(t => t.toLowerCase().includes(q));
      if (!inIndex && !inCustom) continue;
    }

    result.push(b);
  }

  if (sort === 'elo') {
    result.sort((a, b) => {
      const ua = uBooks[a.id] || { elo: ELO_DEFAULT };
      const ub = uBooks[b.id] || { elo: ELO_DEFAULT };
      return ub.elo - ua.elo;
    });
  } else if (sort === 'author') {
    result.sort((a, b) => a.author < b.author ? -1 : a.author > b.author ? 1 : 0);
  }
  // title sort: already in Calibre DB order, no re-sort needed

  state.visibleList = result;
}

// ── Persistence ────────────────────────────────────────────────────────────
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.saveAppData({
      libraryPath: state.libraryPath,
      books: state.userBooks,
      history: matchHistory,
      settings,
    });
  }, 600);
}

// ── Boot ───────────────────────────────────────────────────────────────────
async function boot() {
  const data = await window.api.getAppData();
  if (data.books)    state.userBooks = data.books;
  if (data.history)  matchHistory    = data.history;
  if (data.settings) Object.assign(settings, data.settings);
  attachEvents();
  if (data.libraryPath) {
    await loadLibrary(data.libraryPath);
  } else {
    showEmptyState();
  }
}

async function loadLibrary(libPath) {
  document.getElementById('book-count-label').textContent = 'Loading…';
  const result = await window.api.loadLibrary(libPath);
  if (!result.ok) {
    alert('Could not load library:\n\n' + result.error);
    showEmptyState();
    return;
  }
  state.libraryPath    = libPath;
  state.calibreBooks   = result.books;
  state.bookMap        = {};
  result.books.forEach(b => { state.bookMap[b.id] = b; getUser(b.id); });
  state.searchIndex    = buildSearchIndex(result.books);
  recomputeVisible();
  hideEmptyState();
  renderAll();
}

// ── Virtual scroller ───────────────────────────────────────────────────────
let vsLastStart = -1;

function vsRender() {
  const list   = document.getElementById('book-list');
  const spacer = document.getElementById('vscroll-spacer');
  const rowsEl = document.getElementById('vscroll-rows');
  const books  = state.visibleList;
  const total  = books.length;
  const viewH  = list.clientHeight;
  const scrollY = list.scrollTop;

  spacer.style.height = (total * ROW_H) + 'px';

  if (total === 0) { rowsEl.innerHTML = ''; vsLastStart = -1; return; }

  const startIdx = Math.max(0, Math.floor(scrollY / ROW_H) - OVERSCAN);
  const endIdx   = Math.min(total, Math.ceil((scrollY + viewH) / ROW_H) + OVERSCAN);

  if (startIdx === vsLastStart && rowsEl.childElementCount === endIdx - startIdx) return;
  vsLastStart = startIdx;

  rowsEl.style.transform = 'translateY(' + (startIdx * ROW_H) + 'px)';

  const frag = document.createDocumentFragment();
  for (let i = startIdx; i < endIdx; i++) {
    frag.appendChild(makeBookRow(mergedBook(books[i])));
  }
  rowsEl.innerHTML = '';
  rowsEl.appendChild(frag);
}

function initVscroll() {
  const list = document.getElementById('book-list');
  if (!document.getElementById('vscroll-spacer')) {
    const spacer = document.createElement('div');
    spacer.id = 'vscroll-spacer';
    const rows = document.createElement('div');
    rows.id = 'vscroll-rows';
    list.appendChild(spacer);
    list.appendChild(rows);
  }
  list.addEventListener('scroll', () => vsRender(), { passive: true });
}

// ── Rendering ──────────────────────────────────────────────────────────────
function renderAll() {
  updateCountBar();
  vsRender();
  renderStats();
  updateRankPair();
  if (document.getElementById('view-rankings').classList.contains('active')) {
    renderRankings();
  }
}

function updateCountBar() {
  const total   = state.calibreBooks.length;
  const showing = state.visibleList.length;
  document.getElementById('book-count-label').textContent =
    total === 0 ? '' : 'Showing ' + showing.toLocaleString() + ' of ' + total.toLocaleString() + ' books';
}

function makeBookRow(book) {
  const row = document.createElement('div');
  row.className = 'book-row';
  row.dataset.id = book.id;

  // ── Left: all text content ─────────────────────────────────────────────
  const info = document.createElement('div');
  info.className = 'book-info';

  // Line 1: TITLE by AUTHOR
  const titleLine = document.createElement('div');
  titleLine.className = 'book-title-line';
  const titleSpan  = document.createElement('span');
  titleSpan.className = 'book-title';
  titleSpan.textContent = book.title;
  const bySpan = document.createElement('span');
  bySpan.className = 'book-by';
  bySpan.textContent = 'by';
  const authorSpan = document.createElement('span');
  authorSpan.className = 'book-author book-author-link';
  authorSpan.textContent = book.author;
  authorSpan.addEventListener('click', e => {
    e.stopPropagation();
    filterByAuthor(book.author);
  });
  titleLine.append(titleSpan, bySpan, authorSpan);

  // Line 2: fandom + relationship (AO3 only, separate line)
  const fandomLine = document.createElement('div');
  fandomLine.className = 'book-fandom-line';
  if (isAo3Book(book)) {
    detectFandoms(book).forEach(f => {
      if (settings.showFandomTag !== false) fandomLine.appendChild(makeTag(f, 'tag-fandom', filterByTag));
    });
    const rel = detectRelationship(book);
    if (rel) fandomLine.appendChild(makeTag(rel, 'tag-rel'));
  }

  // Line 3: tags (one line, overflow hidden) — clickable to filter
  const tagsLine = document.createElement('div');
  tagsLine.className = 'book-tags-line';
  const allTags = [...book.customTags, ...book.tags];
  allTags.forEach(t => tagsLine.appendChild(makeTag(t, '', filterByTag)));

  // Line 3–5: description (3 lines max via CSS clamp)
  const desc = document.createElement('div');
  desc.className = 'book-desc';
  desc.textContent = book.description || '';

  // Line 6: publisher (settings-controlled)
  const pub = document.createElement('div');
  pub.className = 'book-publisher';
  pub.textContent = (settings.showPublisherTag !== false) ? (book.publisher || '') : '';

  const infoChildren = [titleLine];
  if (fandomLine.children.length) infoChildren.push(fandomLine);
  infoChildren.push(tagsLine, desc, pub);
  info.append(...infoChildren);

  // ── Right: toggle switch ───────────────────────────────────────────────
  const toggleWrap = document.createElement('label');
  toggleWrap.className = 'toggle-wrap';
  toggleWrap.title = book.read ? 'Mark unread' : 'Mark as read';
  toggleWrap.addEventListener('click', e => e.stopPropagation());

  const toggleInput = document.createElement('input');
  toggleInput.type = 'checkbox';
  toggleInput.checked = book.read;
  toggleInput.addEventListener('change', () => toggleRead(book.id));

  const toggleTrack = document.createElement('span');
  toggleTrack.className = 'toggle-track';
  const toggleThumb = document.createElement('span');
  toggleThumb.className = 'toggle-thumb';
  toggleTrack.appendChild(toggleThumb);

  toggleWrap.append(toggleInput, toggleTrack);

  row.append(info, toggleWrap);
  row.addEventListener('click', () => openDetail(book.id));
  return row;
}

// Rating tag detection for highlighting
const RATING_TAG_PATTERNS = [
  { pattern: 'explicit',          cls: 'tag-rating-explicit' },
  { pattern: 'mature',            cls: 'tag-rating-mature'   },
  { pattern: 'teen and up',       cls: 'tag-rating-teen'     },
  { pattern: 'general audiences', cls: 'tag-rating-general'  },
  { pattern: 'not rated',         cls: 'tag-rating-unrated'  },
];

function ratingClass(text) {
  const tl = text.toLowerCase();
  for (const { pattern, cls } of RATING_TAG_PATTERNS) {
    if (tl.includes(pattern)) return cls;
  }
  return null;
}

function makeTag(text, cls, onClick) {
  const t = document.createElement('span');
  const rCls = ratingClass(text);
  t.className = 'tag' + (cls ? ' ' + cls : '') + (rCls ? ' ' + rCls : '');
  t.textContent = text;
  if (onClick) {
    t.classList.add('tag-clickable');
    t.addEventListener('click', function(e) { e.stopPropagation(); onClick(text); });
  }
  return t;
}

// ── Tag filter ─────────────────────────────────────────────────────────────
function filterByTag(tag) {
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  searchInput.value = tag;
  state.search = tag;
  searchClear.classList.add('visible');
  state.filter = 'all';
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  document.querySelector('.pill[data-filter="all"]').classList.add('active');
  recomputeVisible();
  vsLastStart = -1;
  switchView('library');
  renderAll();
}

// ── Detail panel ───────────────────────────────────────────────────────────
function openDetail(id) {
  state.detailId = id;
  const book = mergedBook(state.bookMap[id]);

  const badges = document.getElementById('detail-badges');
  badges.innerHTML = '';
  if (book.read)   badges.appendChild(makeTag('read ✓', 'read'));
  if (book.fandom) badges.appendChild(makeTag(book.fandom, 'fandom'));

  document.getElementById('detail-title').textContent  = book.title;
  document.getElementById('detail-author').textContent = book.author;
  document.getElementById('detail-series').textContent =
    book.series ? book.series + (book.seriesIndex != null ? ' #' + book.seriesIndex : '') : '';
  document.getElementById('detail-desc').textContent   =
    book.description
      ? (book.description.length > 600 ? book.description.slice(0, 600) + '…' : book.description)
      : '';

  const epubTagsEl = document.getElementById('detail-epub-tags');
  epubTagsEl.innerHTML = '';
  book.tags.forEach(t => epubTagsEl.appendChild(makeTag(t)));

  renderCustomTags(book);

  const readBtn = document.getElementById('btn-toggle-read');
  readBtn.textContent = book.read ? 'Mark unread' : 'Mark as read';
  readBtn.onclick = () => toggleRead(id);

  const openBtn = document.getElementById('btn-open-epub');
  openBtn.style.opacity = book.epubPath ? '1' : '0.4';
  openBtn.onclick = () => book.epubPath && window.api.openEpub(book.epubPath);

  document.getElementById('detail-elo-val').textContent = book.elo;
  document.getElementById('detail-matches').textContent =
    book.matchCount > 0 ? book.matchCount + ' matches' : 'no matches yet';

  document.getElementById('tag-input').value = '';
  document.getElementById('custom-tag-section').style.display = book.read ? '' : 'none';

  document.getElementById('detail-panel').classList.add('open');
  document.getElementById('detail-overlay').classList.add('open');
}

function closeDetail() {
  document.getElementById('detail-panel').classList.remove('open');
  document.getElementById('detail-overlay').classList.remove('open');
  state.detailId = null;
}

function renderCustomTags(book) {
  const el = document.getElementById('detail-custom-tags');
  el.innerHTML = '';
  book.customTags.forEach(tag => {
    const wrap = document.createElement('span');
    wrap.className = 'tag-removable';
    wrap.textContent = tag + ' ';
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.onclick = e => { e.stopPropagation(); removeCustomTag(book.id, tag); };
    wrap.appendChild(rm);
    el.appendChild(wrap);
  });
}

function addCustomTag(id) {
  const input = document.getElementById('tag-input');
  const tag   = input.value.trim();
  if (!tag) return;
  const u = getUser(id);
  if (!u.customTags.includes(tag)) {
    u.customTags.push(tag);
    scheduleSave();
    vsRender();
    if (state.detailId === id) renderCustomTags(mergedBook(state.bookMap[id]));
  }
  input.value = '';
}

function removeCustomTag(id, tag) {
  getUser(id).customTags = getUser(id).customTags.filter(t => t !== tag);
  scheduleSave();
  vsRender();
  if (state.detailId === id) renderCustomTags(mergedBook(state.bookMap[id]));
}

function toggleRead(id) {
  const u = getUser(id);
  u.read = !u.read;
  scheduleSave();
  recomputeVisible();
  renderAll();
  if (state.detailId === id) openDetail(id);
}

// ── Author filter ───────────────────────────────────────────────────────────
function filterByAuthor(author) {
  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');
  searchInput.value = author;
  state.search = author;
  searchClear.classList.add('visible');
  // Reset read filter to all so all books by this author show
  state.filter = 'all';
  document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
  document.querySelector('.pill[data-filter="all"]').classList.add('active');
  recomputeVisible();
  vsLastStart = -1;
  switchView('library');
  renderAll();
}

// ── Stats ──────────────────────────────────────────────────────────────────
function renderStats() {
  let read = 0, ranked = 0;
  for (const id in state.userBooks) {
    const u = state.userBooks[id];
    if (u.read)           read++;
    if (u.matchCount > 0) ranked++;
  }
  document.getElementById('stat-total').textContent  = state.calibreBooks.length.toLocaleString();
  document.getElementById('stat-read').textContent   = read.toLocaleString();
  document.getElementById('stat-ranked').textContent = ranked.toLocaleString();
}

// ── Rankings ───────────────────────────────────────────────────────────────
function renderRankings() {
  const readBooks = state.calibreBooks
    .filter(b => getUser(b.id).read && bookPassesRatingFilter(b))
    .map(b => mergedBook(b))
    .sort((a, b) => b.elo - a.elo);

  const list  = document.getElementById('rankings-list');
  const empty = document.getElementById('rankings-empty');

  if (readBooks.length === 0) {
    list.innerHTML = ''; empty.classList.add('visible'); return;
  }
  empty.classList.remove('visible');

  const maxElo = readBooks[0].elo;
  const minElo = readBooks[readBooks.length - 1].elo;
  const range  = maxElo - minElo || 1;

  // ── Histogram ────────────────────────────────────────────────────────────
  const BINS = 20;
  const binSize = range / BINS;
  const counts = new Array(BINS).fill(0);
  readBooks.forEach(b => {
    const idx = Math.min(BINS - 1, Math.floor((b.elo - minElo) / binSize));
    counts[idx]++;
  });
  const maxCount = Math.max(...counts, 1);

  const histWrap = document.createElement('div');
  histWrap.className = 'hist-wrap';
  const histTitle = document.createElement('div');
  histTitle.className = 'hist-title';
  histTitle.textContent = 'ELO distribution — ' + readBooks.length + ' ranked books';
  histWrap.appendChild(histTitle);
  const histBars = document.createElement('div');
  histBars.className = 'hist-bars';
  counts.forEach((count, i) => {
    const bar = document.createElement('div');
    bar.className = 'hist-bar';
    const fill = document.createElement('div');
    fill.className = 'hist-bar-fill';
    fill.style.height = Math.round((count / maxCount) * 100) + '%';
    bar.title = Math.round(minElo + i * binSize) + ' ELO · ' + count + ' book' + (count !== 1 ? 's' : '');
    bar.appendChild(fill);
    histBars.appendChild(bar);
  });
  const histAxis = document.createElement('div');
  histAxis.className = 'hist-axis';
  const axisMin = document.createElement('span'); axisMin.textContent = minElo;
  const axisMid = document.createElement('span'); axisMid.textContent = Math.round((minElo + maxElo) / 2);
  const axisMax = document.createElement('span'); axisMax.textContent = maxElo;
  histAxis.append(axisMin, axisMid, axisMax);
  histWrap.append(histBars, histAxis);

  // ── Author rankings ───────────────────────────────────────────────────────
  const authorMap = {};
  readBooks.forEach(b => {
    if (!authorMap[b.author]) authorMap[b.author] = { total: 0, count: 0 };
    authorMap[b.author].total += b.elo;
    authorMap[b.author].count++;
  });
  const authorRanked = Object.entries(authorMap)
    .map(([name, d]) => ({ name, total: d.total, count: d.count, avg: Math.round(d.total / d.count) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  const authorSection = document.createElement('div');
  authorSection.className = 'hist-wrap';
  authorSection.style.marginTop = '8px';
  const authorTitle = document.createElement('div');
  authorTitle.className = 'hist-title';
  authorTitle.textContent = 'Top authors by combined ELO';
  authorSection.appendChild(authorTitle);

  const maxAuthorTotal = authorRanked[0] ? authorRanked[0].total : 1;
  authorRanked.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'author-rank-row';
    const pct = Math.round((a.total / maxAuthorTotal) * 100);
    row.innerHTML =
      '<div class="rank-num' + (i < 3 ? ' top' : '') + '">#' + (i + 1) + '</div>' +
      '<div class="rank-bar-wrap">' +
        '<div class="rank-title">' + escHtml(a.name) + '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;margin-top:4px">' +
          '<div class="rank-bar-bg" style="flex:1"><div class="rank-bar-fill author-bar" style="width:' + pct + '%"></div></div>' +
          '<span style="font-size:.65rem;color:var(--dim);font-family:var(--mono);flex-shrink:0">' + a.count + ' book' + (a.count !== 1 ? 's' : '') + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="rank-elo-col">' +
        '<div class="rank-elo-n">' + a.total + '</div>' +
        '<div class="rank-matches">avg ' + a.avg + '</div>' +
      '</div>';
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => filterByAuthor(a.name));
    authorSection.appendChild(row);
  });

  // ── Book ranked list ──────────────────────────────────────────────────────
  const frag = document.createDocumentFragment();
  frag.appendChild(histWrap);
  frag.appendChild(authorSection);

  const bookHeader = document.createElement('div');
  bookHeader.className = 'rankings-section-label';
  bookHeader.textContent = 'Books';
  frag.appendChild(bookHeader);

  readBooks.forEach((book, i) => {
    const pct = Math.round(((book.elo - minElo) / range) * 100);
    const row = document.createElement('div');
    row.className = 'rank-row';
    row.innerHTML =
      '<div class="rank-num' + (i < 3 ? ' top' : '') + '">#' + (i + 1) + '</div>' +
      '<div class="rank-bar-wrap">' +
        '<div class="rank-title">' + escHtml(book.title) + '</div>' +
        '<div class="rank-author-line">by ' + escHtml(book.author) + '</div>' +
        '<div class="rank-bar-bg"><div class="rank-bar-fill" style="width:' + pct + '%"></div></div>' +
      '</div>' +
      '<div class="rank-elo-col">' +
        '<div class="rank-elo-n">' + book.elo + '</div>' +
        '<div class="rank-matches">' + book.matchCount + ' match' + (book.matchCount !== 1 ? 'es' : '') + '</div>' +
      '</div>';
    // Open detail panel over this view — do NOT switch to library
    row.addEventListener('click', () => openDetail(book.id));
    frag.appendChild(row);
  });

  list.innerHTML = '';
  list.appendChild(frag);
}

// ── Shared card content builder (Compare + Sort) ────────────────────────────
function buildCardContent(el, book, opts) {
  // opts: { showElo, samplePlaceholder }
  el.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'rank-card-title';
  title.textContent = book.title;

  const author = document.createElement('div');
  author.className = 'rank-card-author';
  author.textContent = book.author;

  // Fandom row (AO3 books only, detected from tags)
  const fandoms = isAo3Book(book) ? detectFandoms(book) : [];
  const rel     = isAo3Book(book) ? detectRelationship(book) : null;

  const metaRow = document.createElement('div');
  metaRow.className = 'card-meta-row';
  if (settings.showFandomTag) {
    fandoms.forEach(f => {
      const t = makeTag(f, 'tag-fandom', filterByTag);
      metaRow.appendChild(t);
    });
  }
  if (rel) metaRow.appendChild(makeTag(rel, 'tag-rel'));

  const tagsEl = document.createElement('div');
  tagsEl.className = 'sort-card-tags';
  [...(book.customTags || []), ...(book.tags || [])].forEach(t => tagsEl.appendChild(makeTag(t, '', filterByTag)));

  const divider = document.createElement('div');
  divider.className = 'sort-card-divider';

  const desc = document.createElement('div');
  desc.className = 'sort-card-desc';
  desc.textContent = book.description || '';

  const divider2 = document.createElement('div');
  divider2.className = 'sort-card-divider';

  const sampleEl = document.createElement('div');
  sampleEl.className = 'sort-card-sample';
  sampleEl.textContent = opts.samplePlaceholder || '';

  if (settings.showPublisher && book.publisher) {
    const pub = document.createElement('div');
    pub.className = 'sort-card-publisher';
    pub.textContent = book.publisher;
    el.appendChild(pub);  // will be re-ordered below
  }

  const children = [title, author];
  if (metaRow.children.length) children.push(metaRow);
  if (book.tags.length || book.customTags.length) children.push(tagsEl);
  if (book.description) children.push(divider, desc);
  children.push(divider2, sampleEl);
  if (settings.showPublisher && book.publisher) {
    const pub2 = document.createElement('div');
    pub2.className = 'sort-card-publisher';
    pub2.textContent = book.publisher;
    children.push(pub2);
  }
  if (opts.showElo) {
    const eloEl = document.createElement('div');
    eloEl.className = 'rank-card-elo';
    eloEl.textContent = 'ELO ' + book.elo + ' · ' + book.matchCount + ' matches';
    children.push(eloEl);
  }

  children.forEach(c => el.appendChild(c));
  return sampleEl;  // caller fills this async
}

// ── ELO comparison ─────────────────────────────────────────────────────────
let rankPair = null;
let compareAnimating = false;

function updateRankPair() {
  const readBooks = state.calibreBooks.filter(b => getUser(b.id).read && bookPassesRatingFilter(b));
  const empty   = document.getElementById('rank-empty');
  const pair    = document.getElementById('rank-pair');
  const actions = document.getElementById('rank-actions');

  if (readBooks.length < 2) {
    empty.style.display = ''; pair.style.display = 'none'; actions.style.display = 'none';
    return;
  }
  empty.style.display = 'none'; pair.style.display = ''; actions.style.display = '';
  if (!rankPair) pickNewPair(readBooks);

  // Update stats display
  const statsEl = document.getElementById('compare-stats');
  if (statsEl) {
    const elapsed = (Date.now() - compareStats.sessionStart) / 1000 / 3600;
    const pace = elapsed > 0.01 ? Math.round(compareStats.total / elapsed) : 0;
    statsEl.textContent = compareStats.total + ' comparisons this session' +
      (pace > 0 ? ' · ' + pace + '/hr' : '');
  }
}

function pickNewPair(readBooks) {
  if (!readBooks) readBooks = state.calibreBooks.filter(b => getUser(b.id).read && bookPassesRatingFilter(b));
  if (readBooks.length < 2) return;

  // Try to find a pair we haven't seen yet; give up after 200 attempts and clear history
  const sorted = [...readBooks].sort((a, b) => getUser(a.id).matchCount - getUser(b.id).matchCount);
  const pool   = sorted.slice(0, Math.max(4, Math.ceil(sorted.length * 0.3)));

  let a, b, attempts = 0;
  do {
    a = pool[Math.floor(Math.random() * pool.length)];
    b = readBooks[Math.floor(Math.random() * readBooks.length)];
    attempts++;
    if (attempts > 200) { seenPairs.clear(); break; }
  } while (b.id === a.id || seenPairs.has(pairKey(a.id, b.id)));

  seenPairs.add(pairKey(a.id, b.id));
  rankPair = [mergedBook(a), mergedBook(b)];
  fillRankCard('rank-a', rankPair[0]);
  fillRankCard('rank-b', rankPair[1]);
}

function fillRankCard(elId, book) {
  const el = document.getElementById(elId);
  el.dataset.id = book.id;
  el.classList.remove('anim-swipe-left', 'anim-swipe-right');

  const sampleEl = buildCardContent(el, book, { showElo: true, samplePlaceholder: book.epubPath ? 'Loading sample…' : '' });

  if (book.epubPath) {
    const btn = document.createElement('button');
    btn.className = 'ghost-btn rank-card-open-btn';
    btn.textContent = 'Open in reader';
    btn.addEventListener('click', e => { e.stopPropagation(); window.api.openEpub(book.epubPath); });
    el.appendChild(btn);

    window.api.epubSample(book.epubPath).then(sample => {
      sampleEl.innerHTML = '';
      if (!sample) { sampleEl.textContent = '(no readable sample found)'; return; }
      sample.split(/\n+/).forEach(para => {
        const p = document.createElement('p');
        p.textContent = para.trim();
        if (p.textContent) sampleEl.appendChild(p);
      });
    });
  } else {
    sampleEl.textContent = '(no epub file)';
  }
}

function recordWin(winnerId) {
  if (!rankPair || compareAnimating) return;
  const loserId = rankPair[0].id === winnerId ? rankPair[1].id : rankPair[0].id;
  const winCard = winnerId === rankPair[0].id ? 'rank-a' : 'rank-b';
  const loseCard = winCard === 'rank-a' ? 'rank-b' : 'rank-a';

  compareAnimating = true;
  compareStats.total++;

  const uW = getUser(winnerId), uL = getUser(loserId);
  const wBefore = uW.elo, lBefore = uL.elo;
  const { winner, loser } = eloUpdate(uW.elo, uL.elo);
  uW.elo = winner; uW.matchCount++;
  uL.elo = loser;  uL.matchCount++;

  matchHistory.unshift({
    winnerId, loserId,
    winnerEloBefore: wBefore, loserEloBefore: lBefore,
    winnerEloAfter: winner,   loserEloAfter: loser,
    ts: Date.now(),
  });

  scheduleSave();

  // Animate: winner slides right, loser slides left
  const wEl = document.getElementById(winCard);
  const lEl = document.getElementById(loseCard);
  wEl.classList.add('anim-swipe-right');
  lEl.classList.add('anim-swipe-left');

  setTimeout(() => {
    compareAnimating = false;
    rankPair = null;
    renderAll();
    if (document.getElementById('view-history').classList.contains('active')) renderHistory();
  }, 340);
}

function revertMatch(index) {
  const entry = matchHistory[index];
  if (!entry) return;

  if (entry.type === 'triage') {
    // Undo triage decision
    const u = getUser(entry.bookId);
    if (entry.action === 'read') {
      u.read = false;
    } else if (entry.action === 'later') {
      u.customTags = u.customTags.filter(t => t !== 'later');
    } else if (entry.action === 'rejected') {
      u.customTags = u.customTags.filter(t => t !== 'rejected');
    }
  } else {
    // Undo ELO match
    const uW = getUser(entry.winnerId);
    const uL = getUser(entry.loserId);
    uW.elo = entry.winnerEloBefore; if (uW.matchCount > 0) uW.matchCount--;
    uL.elo = entry.loserEloBefore;  if (uL.matchCount > 0) uL.matchCount--;
  }

  matchHistory.splice(index, 1);
  scheduleSave();
  renderAll();
  renderHistory();
}

function renderHistory() {
  const list  = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');

  if (matchHistory.length === 0) {
    list.innerHTML = ''; empty.classList.add('visible'); return;
  }
  empty.classList.remove('visible');

  const ACTION_LABEL = { read: 'Read', later: 'Later', rejected: 'Rejected' };
  const ACTION_CLS   = { read: 'win',  later: 'later', rejected: 'loss' };

  const frag = document.createDocumentFragment();
  matchHistory.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'history-row';

    const when = new Date(entry.ts);
    const timeStr = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
                    ' ' + when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

    if (entry.type === 'triage') {
      const book = state.bookMap[entry.bookId];
      if (!book) return;
      const cls = ACTION_CLS[entry.action] || '';
      const lbl = ACTION_LABEL[entry.action] || entry.action;
      row.innerHTML =
        '<div class="history-time">' + escHtml(timeStr) + '</div>' +
        '<div class="history-pair">' +
          '<div class="history-winner">' +
            '<span class="history-badge ' + cls + '">' + lbl + '</span>' +
            '<span class="history-book-title">' + escHtml(book.title) + '</span>' +
            '<span class="history-elo-change" style="color:var(--dim)">triage</span>' +
          '</div>' +
        '</div>' +
        '<button class="history-revert ghost-btn">Revert</button>';
    } else {
      const winner = state.bookMap[entry.winnerId];
      const loser  = state.bookMap[entry.loserId];
      if (!winner || !loser) return;
      row.innerHTML =
        '<div class="history-time">' + escHtml(timeStr) + '</div>' +
        '<div class="history-pair">' +
          '<div class="history-winner">' +
            '<span class="history-badge win">W</span>' +
            '<span class="history-book-title">' + escHtml(winner.title) + '</span>' +
            '<span class="history-elo-change">' + entry.winnerEloBefore + ' → ' + entry.winnerEloAfter + '</span>' +
          '</div>' +
          '<div class="history-loser">' +
            '<span class="history-badge loss">L</span>' +
            '<span class="history-book-title">' + escHtml(loser.title) + '</span>' +
            '<span class="history-elo-change">' + entry.loserEloBefore + ' → ' + entry.loserEloAfter + '</span>' +
          '</div>' +
        '</div>' +
        '<button class="history-revert ghost-btn">Revert</button>';
    }

    row.querySelector('.history-revert').addEventListener('click', () => revertMatch(i));
    frag.appendChild(row);
  });

  list.innerHTML = '';
  list.appendChild(frag);
}

// Extend scheduleSave to also save matchHistory — handled by the single scheduleSave above

// ── Sort / triage view ─────────────────────────────────────────────────────
const sortState = {
  queue: [],       // book ids not yet triaged in this session
  current: null,   // id of card currently shown
  animating: false,
};

function initSortQueue() {
  // Queue = all unread, non-series books, shuffled
  sortState.queue = state.calibreBooks
    .filter(b => !getUser(b.id).read && !b.series && bookPassesRatingFilter(b))
    .map(b => b.id);
  for (let i = sortState.queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [sortState.queue[i], sortState.queue[j]] = [sortState.queue[j], sortState.queue[i]];
  }
  sortState.current = null;
}

function showSortView() {
  const noBooks = document.getElementById('sort-no-books');
  const empty   = document.getElementById('sort-empty');
  const arena   = document.getElementById('sort-arena');
  const header  = document.getElementById('sort-view-header');

  if (state.calibreBooks.length === 0) {
    noBooks.classList.add('visible');
    empty.classList.remove('visible');
    arena.style.display = 'none';
    header.style.display = 'none';
    return;
  }

  noBooks.classList.remove('visible');
  arena.style.display = '';
  header.style.display = '';

  // Re-init queue if empty or first visit
  if (sortState.queue.length === 0 && !sortState.current) {
    initSortQueue();
  }

  advanceSortCard(false);
}

function advanceSortCard(animate, direction) {
  const card  = document.getElementById('sort-card');
  const empty = document.getElementById('sort-empty');
  const arena = document.getElementById('sort-arena');

  // Filter queue to remove any books marked read since last visit
  sortState.queue = sortState.queue.filter(id => !getUser(id).read);

  // Pick next from queue
  const nextId = sortState.queue.shift() || null;

  const doShow = () => {
    sortState.current = nextId;
    if (!nextId) {
      empty.classList.add('visible');
      arena.style.display = 'none';
      updateSortProgress();
      return;
    }
    empty.classList.remove('visible');
    arena.style.display = '';
    renderSortCard(nextId);
    updateSortProgress();
    // Slide-in animation on new card
    card.classList.remove('anim-left', 'anim-right', 'anim-up', 'anim-down', 'anim-in', 'hint-left', 'hint-right');
    void card.offsetWidth; // force reflow
    card.classList.add('anim-in');
    card.addEventListener('animationend', () => {
      card.classList.remove('anim-in');
      sortState.animating = false;
    }, { once: true });
  };

  if (animate && direction) {
    sortState.animating = true;
    card.classList.add('anim-' + direction);
    card.addEventListener('animationend', doShow, { once: true });
  } else {
    sortState.animating = false;
    doShow();
  }
}

// Triage session timing — reset when sort view is first opened each session
const triageSession = {
  startTime:  null,   // Date.now() when this session started
  countStart: 0,      // triaged count at session start (to compute pace)
};

function triageCount() {
  // Total decisions made = read + tagged-later + tagged-rejected
  let n = 0;
  for (const id in state.userBooks) {
    const u = state.userBooks[id];
    if (u.read) n++;
    else if (u.customTags && (u.customTags.includes('later') || u.customTags.includes('rejected'))) n++;
  }
  return n;
}

async function renderSortCard(id) {
  const book = mergedBook(state.bookMap[id]);
  const card = document.getElementById('sort-card');

  const sampleEl = buildCardContent(card, book, { showElo: false, samplePlaceholder: book.epubPath ? 'Loading sample…' : '' });

  // Zone labels
  const labelLeft = document.createElement('div');
  labelLeft.className = 'sort-zone-label left';
  labelLeft.textContent = '← skip';
  const labelRight = document.createElement('div');
  labelRight.className = 'sort-zone-label right';
  labelRight.textContent = 'read →';
  card.appendChild(labelLeft);
  card.appendChild(labelRight);

  // Open-in-reader button
  const btnWrap = document.getElementById('sort-open-btns');
  btnWrap.innerHTML = '';
  if (book.epubPath) {
    const b1 = document.createElement('button');
    b1.className = 'ghost-btn sort-open-btn';
    b1.textContent = 'Open in reader';
    b1.addEventListener('click', () => window.api.openEpub(book.epubPath));
    btnWrap.appendChild(b1);

    window.api.epubSample(book.epubPath).then(sample => {
      if (sortState.current !== id) return;
      sampleEl.innerHTML = '';
      if (!sample) { sampleEl.textContent = '(no readable sample found)'; return; }
      sample.split(/\n+/).forEach(para => {
        const p = document.createElement('p');
        p.textContent = para.trim();
        if (p.textContent) sampleEl.appendChild(p);
      });
    });
  } else {
    sampleEl.textContent = '(no epub file)';
  }
}

function updateSortProgress() {
  let readCount = 0, laterCount = 0, rejectedCount = 0;
  for (const id in state.userBooks) {
    const u = state.userBooks[id];
    if (u.read) { readCount++; continue; }
    if (u.customTags) {
      if (u.customTags.includes('later'))    laterCount++;
      if (u.customTags.includes('rejected')) rejectedCount++;
    }
  }

  const remaining = sortState.queue.length + (sortState.current ? 1 : 0);

  // Session pace
  const now = Date.now();
  let paceStr = '—', etaStr = '—', todayStr = '—';

  if (triageSession.startTime) {
    const elapsed = (now - triageSession.startTime) / 1000 / 3600; // hours
    const sessionDone = triageCount() - triageSession.countStart;

    if (elapsed > 0.005 && sessionDone > 0) {
      const perHour = Math.round(sessionDone / elapsed);
      paceStr = perHour.toLocaleString();
      if (remaining > 0 && perHour > 0) {
        const hrsLeft = remaining / perHour;
        if (hrsLeft < 1)      etaStr = Math.round(hrsLeft * 60) + 'm';
        else if (hrsLeft < 24) etaStr = hrsLeft.toFixed(1) + 'h';
        else                   etaStr = Math.round(hrsLeft / 24) + 'd';
      }
    }

    // Today: decisions since midnight
    const midnight = new Date(); midnight.setHours(0,0,0,0);
    todayStr = (triageSession.startTime >= midnight.getTime()
      ? sessionDone
      : '—'
    ).toString();
  }

  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  set('ss-remaining', remaining.toLocaleString());
  set('ss-read',      readCount.toLocaleString());
  set('ss-later',     laterCount.toLocaleString());
  set('ss-rejected',  rejectedCount.toLocaleString());
  set('ss-today',     todayStr);
  set('ss-pace',      paceStr);
  set('ss-eta',       etaStr);
}

function sortDecide(action) {
  // action: 'skip' | 'read' | 'later' | 'rejected'
  if (sortState.animating || !sortState.current) return;
  const id = sortState.current;
  const u  = getUser(id);

  if (action === 'read') {
    u.read = true;
    u.customTags = u.customTags.filter(t => t !== 'later' && t !== 'rejected');
  } else if (action === 'later') {
    if (!u.customTags.includes('later')) u.customTags.push('later');
    u.customTags = u.customTags.filter(t => t !== 'rejected');
  } else if (action === 'rejected') {
    if (!u.customTags.includes('rejected')) u.customTags.push('rejected');
    u.customTags = u.customTags.filter(t => t !== 'later');
  }
  // 'skip' = no change

  if (action !== 'skip') {
    // Record triage decision in history so it can be reverted
    matchHistory.unshift({ type: 'triage', bookId: id, action, ts: Date.now() });
    scheduleSave();
    renderStats();
    if (document.getElementById('view-history').classList.contains('active')) renderHistory();
  }

  const dirMap = { read: 'right', skip: 'left', later: 'up', rejected: 'down' };
  advanceSortCard(true, dirMap[action] || 'left');
}

function attachSortEvents() {
  const card = document.getElementById('sort-card');

  card.addEventListener('click', function(e) {
    if (sortState.animating) return;
    const rect = card.getBoundingClientRect();
    const mid  = rect.left + rect.width / 2;
    sortDecide(e.clientX < mid ? 'skip' : 'read');
  });

  card.addEventListener('mousemove', function(e) {
    if (sortState.animating) return;
    const rect = card.getBoundingClientRect();
    const mid  = rect.left + rect.width / 2;
    card.classList.toggle('hint-left',  e.clientX < mid);
    card.classList.toggle('hint-right', e.clientX >= mid);
  });

  card.addEventListener('mouseleave', function() {
    card.classList.remove('hint-left', 'hint-right');
  });

  document.addEventListener('keydown', function(e) {
    if (!document.getElementById('view-sort').classList.contains('active')) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight') { e.preventDefault(); sortDecide('read');     return; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); sortDecide('skip');     return; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); sortDecide('later');    return; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); sortDecide('rejected'); return; }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); sortDecide('later');    return; }
    if (e.key === 'x' || e.key === 'X') { e.preventDefault(); sortDecide('rejected'); return; }
  });

  document.getElementById('btn-sort-later').addEventListener('click',  () => sortDecide('later'));
  document.getElementById('btn-sort-reject').addEventListener('click', () => sortDecide('rejected'));

  document.getElementById('btn-sort-restart').addEventListener('click', function() {
    triageSession.startTime  = Date.now();
    triageSession.countStart = triageCount();
    initSortQueue();
    showSortView();
  });
}

// ── View switching ─────────────────────────────────────────────────────────
function switchView(name) {
  document.querySelectorAll('.view').forEach(v    => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelector('.nav-btn[data-view="' + name + '"]').classList.add('active');
  if (name === 'rank')     pickNewPair();
  if (name === 'rankings') renderRankings();
  if (name === 'library')  vsRender();
  if (name === 'sort') {
    if (!triageSession.startTime) {
      triageSession.startTime  = Date.now();
      triageSession.countStart = triageCount();
    }
    showSortView();
  }
  if (name === 'history')  renderHistory();
  if (name === 'settings') renderSettings();
}

// ── Settings view ──────────────────────────────────────────────────────────
function renderSettings() {
  const body = document.getElementById('settings-body');
  if (!body) return;
  body.innerHTML = '';

  // Helper: build one toggle row
  function makeToggleRow(label, key, tagCls) {
    const row = document.createElement('label');
    row.className = 'settings-toggle-row';

    const left = document.createElement('span');
    left.className = 'settings-toggle-label';
    if (tagCls) {
      const swatch = document.createElement('span');
      swatch.className = 'tag ' + tagCls;
      swatch.style.marginRight = '6px';
      swatch.textContent = label;
      left.appendChild(swatch);
    } else {
      left.textContent = label;
    }

    const sw = document.createElement('span');
    sw.className = 'sw-track';
    const thumb = document.createElement('span');
    thumb.className = 'sw-thumb';
    sw.appendChild(thumb);

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.style.display = 'none';
    input.checked = !isHidden(key);
    if (!isHidden(key)) sw.classList.add('sw-on');

    input.addEventListener('change', () => {
      setHidden(key, !input.checked);
      sw.classList.toggle('sw-on', input.checked);
      scheduleSave();
      recomputeVisible(); vsLastStart = -1; renderAll();
    });
    sw.addEventListener('click', () => { input.checked = !input.checked; input.dispatchEvent(new Event('change')); });

    row.append(left, input, sw);
    return row;
  }

  // Helper: build a section
  function makeSection(title, rows) {
    const sec = document.createElement('section');
    sec.className = 'settings-section';
    const h = document.createElement('div');
    h.className = 'settings-section-title';
    h.textContent = title;
    sec.appendChild(h);
    rows.forEach(r => sec.appendChild(r));
    return sec;
  }

  // ── Ratings ───────────────────────────────────────────────────────────────
  body.appendChild(makeSection('Ratings', [
    makeToggleRow('Explicit',          'explicit', 'tag-rating-explicit'),
    makeToggleRow('Mature',            'mature',   'tag-rating-mature'),
    makeToggleRow('Teen and Up',       'teen',     'tag-rating-teen'),
    makeToggleRow('General Audiences', 'general',  'tag-rating-general'),
    makeToggleRow('Not Rated',         'notrated', 'tag-rating-unrated'),
  ]));

  // ── Relationship Category ─────────────────────────────────────────────────
  body.appendChild(makeSection('Relationship Category', [
    makeToggleRow('M/M',   'M/M',   'tag-rel'),
    makeToggleRow('F/M',   'F/M',   'tag-rel'),
    makeToggleRow('Gen',   'Gen',   'tag-rel'),
    makeToggleRow('F/F',   'F/F',   'tag-rel'),
    makeToggleRow('Multi', 'Multi', 'tag-rel'),
    makeToggleRow('Other', 'Other', 'tag-rel'),
  ]));

  // ── Publisher ─────────────────────────────────────────────────────────────
  body.appendChild(makeSection('Publisher', [
    makeToggleRow('Archive of Our Own', 'ao3', ''),
  ]));

  // ── Fandom ────────────────────────────────────────────────────────────────
  const fandomRows = allFandoms().map(f => makeToggleRow(f, f, 'tag-fandom'));

  // Extra fandom add row
  const addRow = document.createElement('div');
  addRow.className = 'extra-fandom-row';
  const fi = document.createElement('input');
  fi.id = 'extra-fandom-input';
  fi.type = 'text';
  fi.placeholder = 'Add fandom…';
  fi.style.flex = '1';
  const fa = document.createElement('button');
  fa.className = 'action-btn';
  fa.style.width = 'auto';
  fa.style.padding = '6px 14px';
  fa.textContent = 'Add';
  const doAdd = () => {
    const v = fi.value.trim();
    if (!v || allFandoms().includes(v)) { fi.value = ''; return; }
    settings.extraFandoms.push(v);
    scheduleSave();
    renderSettings();
  };
  fa.addEventListener('click', doAdd);
  fi.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); });
  addRow.style.display = 'flex';
  addRow.style.gap = '8px';
  addRow.style.marginTop = '6px';
  addRow.append(fi, fa);
  fandomRows.push(addRow);

  body.appendChild(makeSection('Fandom', fandomRows));

  // ── Data ──────────────────────────────────────────────────────────────────
  const dataRow = document.createElement('div');
  dataRow.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'ghost-btn';
  clearBtn.style.color = 'var(--danger)';
  clearBtn.style.borderColor = 'var(--danger)';
  clearBtn.textContent = 'Clear ELO & match history';
  clearBtn.addEventListener('click', () => {
    if (!confirm('Clear all ELO scores and match history? Read/tag data will be kept.')) return;
    for (const id in state.userBooks) {
      state.userBooks[id].elo = ELO_DEFAULT;
      state.userBooks[id].matchCount = 0;
    }
    matchHistory.length = 0;
    seenPairs.clear();
    compareStats.total = 0;
    scheduleSave(); renderAll();
  });
  const folderBtn = document.createElement('button');
  folderBtn.className = 'ghost-btn';
  folderBtn.textContent = 'Open data folder';
  folderBtn.addEventListener('click', () => window.api.openDataFolder());
  dataRow.append(clearBtn, folderBtn);
  body.appendChild(makeSection('Data', [dataRow]));
}

// ── Debounce ───────────────────────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return function() {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, arguments), ms);
  };
}

// ── Utility ────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function showEmptyState() { document.getElementById('empty-state').classList.add('visible'); }
function hideEmptyState() { document.getElementById('empty-state').classList.remove('visible'); }

// ── Event wiring ───────────────────────────────────────────────────────────
function attachEvents() {
  initVscroll();
  attachSortEvents();

  document.querySelectorAll('.nav-btn').forEach(btn =>
    btn.addEventListener('click', () => switchView(btn.dataset.view))
  );

  async function doPickLibrary() {
    const p = await window.api.pickLibrary();
    if (p) await loadLibrary(p);
  }
  document.getElementById('btn-open-library').addEventListener('click', doPickLibrary);
  document.getElementById('btn-open-library-empty').addEventListener('click', doPickLibrary);

  const searchInput = document.getElementById('search-input');
  const searchClear = document.getElementById('search-clear');

  const onSearch = debounce(function() {
    recomputeVisible();
    vsLastStart = -1;
    renderAll();
  }, 180);

  searchInput.addEventListener('input', function() {
    state.search = searchInput.value;
    searchClear.classList.toggle('visible', !!state.search);
    onSearch();
  });

  searchClear.addEventListener('click', function() {
    searchInput.value = ''; state.search = '';
    searchClear.classList.remove('visible');
    recomputeVisible(); vsLastStart = -1; renderAll();
  });

  document.querySelectorAll('.pill').forEach(pill =>
    pill.addEventListener('click', function() {
      document.querySelectorAll('.pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      state.filter = pill.dataset.filter;
      recomputeVisible(); vsLastStart = -1; renderAll();
    })
  );

  document.getElementById('sort-select').addEventListener('change', function(e) {
    state.sort = e.target.value;
    recomputeVisible(); vsLastStart = -1; renderAll();
  });

  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-overlay').addEventListener('click', closeDetail);

  document.getElementById('tag-add-btn').addEventListener('click', function() {
    if (state.detailId) addCustomTag(state.detailId);
  });
  document.getElementById('tag-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && state.detailId) addCustomTag(state.detailId);
  });

  document.getElementById('rank-a').addEventListener('click', function() {
    if (rankPair) recordWin(rankPair[0].id);
  });
  document.getElementById('rank-b').addEventListener('click', function() {
    if (rankPair) recordWin(rankPair[1].id);
  });
  document.getElementById('btn-skip').addEventListener('click', function() {
    rankPair = null; pickNewPair();
  });
  document.getElementById('btn-go-rankings').addEventListener('click', function() {
    switchView('rankings');
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') closeDetail();
    if (e.key === 'f' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); searchInput.focus();
    }
  });
}

// ── Start ──────────────────────────────────────────────────────────────────
boot();
