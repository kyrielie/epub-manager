# epub-manager

Fast Calibre library browser for macOS. Reads your existing Calibre `metadata.db` directly
— no Calibre process needed. Supports custom tagging and ELO-based ranking.

## Features

- **Instant load** — reads Calibre's SQLite `metadata.db` directly (thousands of books in < 1s)
- **Full metadata** — title, author, series, description, fandom, publisher, all tags, custom columns
- **Cover art** — lazy-loaded from `cover.jpg` in each book folder
- **Open in reader** — launches the `.epub` in your default app (e.g. Apple Books)
- **Custom tags** — add/remove your own tags per book (stored separately, never touches Calibre)
- **Read tracking** — mark books read/unread
- **ELO ranking** — compare two read books head-to-head; builds a ranked list over time
- **Search & filter** — search title, author, fandom, tags; filter read/unread; sort by title/author/ELO
- **Persisted locally** — your tags, read status, and ELO data saved to `~/.epub-manager/data.json`

## Requirements

- Node.js 18+ and npm
- macOS 12+

## Setup

```bash
cd epub-manager
npm install
npm start
```

On first run, click **Open library folder** and select your Calibre library root
(the folder containing `metadata.db`).

## Building a distributable .app

```bash
npm run build
```

Produces a `.dmg` in the `dist/` folder.

## Data storage

Your custom data (tags, read status, ELO scores) is stored at:

```
~/.epub-manager/data.json
```

It is completely separate from your Calibre library — nothing is ever written to Calibre's files.

## Keyboard shortcuts

| Key         | Action                    |
|-------------|---------------------------|
| `⌘F`        | Focus search              |
| `Esc`       | Close detail panel        |

## Fandom detection

The app uses two strategies to identify fandom tags:

1. **Custom Calibre columns** — if you have a column named `fandom`, `universe`, or `series`,
   it reads that directly.
2. **Tag heuristics** — tags containing `/` (common in fanfic pairings like `Harry/Draco`)
   are treated as fandom tags. Common genre words (romance, angst, fluff, etc.) are excluded.

You can always see all raw Calibre tags in the detail panel.

## Project structure

```
epub-manager/
├── src/
│   ├── main.js      # Electron main process (SQLite, IPC, window)
│   ├── preload.js   # Context bridge (safe IPC API)
│   ├── index.html   # App shell
│   ├── style.css    # All styles
│   └── app.js       # Renderer logic (state, filtering, ELO, DOM)
├── package.json
└── README.md
```
