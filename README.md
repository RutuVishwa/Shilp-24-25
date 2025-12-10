# Annual Magazine – eBook Edition

A single-page, offline-ready flipbook experience that renders `magazine.pdf` on the fly using PDF.js and Turn.js. Just drop a PDF named `magazine.pdf` in the project root and open `index.html` in any modern browser.

## Features

- Automatic loading of `/magazine.pdf` (no hardcoded page counts).
- Realistic page-turn animation powered by Turn.js.
- Canvas → image rendering pipeline via PDF.js per page.
- Sidebar table of contents backed by editable JSON (`assets/toc.json`).
- Top toolbar with TOC toggle, zoom controls, fullscreen toggle.
- Bottom pager with previous/next buttons, page indicator, and jump-to-page input.
- Responsive layout with swipe/tap gestures on mobile (Turn.js default behavior).
- Lightweight in-memory page cache to keep navigation smooth without persisting data.

## Project structure

```
├── assets/
│   ├── toc.json          # Placeholder TOC data (edit titles/pages as needed)
│   └── turn.mp3          # Drop your page-turn sound here (can be replaced later)
├── libs/
│   ├── jquery/jquery.min.js
│   ├── pdfjs/pdf.min.js
│   ├── pdfjs/pdf.worker.min.js
│   └── turnjs/turn.min.js
├── magazine.pdf          # Your magazine (required, kept at project root)
├── index.html
├── style.css
├── script.js
└── README.md
```

## Usage

1. Ensure `magazine.pdf` sits at the project root (same level as `index.html`).
2. (Optional) Update `assets/toc.json` with the desired section titles and page numbers. The viewer fetches it at runtime without caching, so edits are immediately reflected on refresh.
3. (Optional) Place a page-turn sound at `assets/turn.mp3`. Until an audio file is added, the flipbook works silently.
4. Open `index.html` in a browser or host the folder on any static server (GitHub Pages, college intranet, etc.). All assets are local, so no build step is required.

## Customization notes

- **TOC**: Modify `assets/toc.json` to match your magazine’s structure. Each entry needs a `title` and `page` number.
- **Styling**: Adjust colors, fonts, and spacing in `style.css`. The flipbook dimensions adapt automatically to the container.
- **Zoom limits**: Tweak `minZoom`, `maxZoom`, and `zoomStep` inside `script.js` to suit your design.
- **Sound**: Replace `assets/turn.mp3` with any MP3 clip. The `<audio>` element autoloads it and plays on each turn.

## Browser compatibility

Tested with the latest Chrome, Edge, Safari, and Firefox. Requires ES6 modules and `requestFullscreen` support (common in modern browsers).

## Deployment

- **Local**: Double-click `index.html` or serve via `npx serve` / `python -m http.server`.
- **GitHub Pages**: Push the repository; Pages will serve the static files directly.
- **Offline kiosks**: Keep the directory on disk or a USB drive; everything runs without network access.

## Troubleshooting

- **Blank viewer**: Confirm `magazine.pdf` exists and isn’t locked/corrupted.
- **Worker errors**: Check the console; ensure `libs/pdfjs/pdf.worker.min.js` is present. The code falls back gracefully, but mismatched versions can break rendering.
- **Slow rendering**: Large PDFs may take time the first time each page is visited. The short-lived in-memory cache limits re-rendering without violating the “no persistent caching” requirement.

Enjoy your interactive e-magazine experience! 🎉
