const isFileProtocol = window.location.protocol === 'file:';
const PDF_URL = isFileProtocol ? 'magazine.pdf' : '/magazine.pdf';

const state = {
  pdfDoc: null,
  numPages: 0,
  currentZoom: 1,
  minZoom: 0.8,
  maxZoom: 2,
  zoomStep: 0.1,
  renderQueue: new Map(),
  pageCache: new Map(),
  maxCacheSize: 8,
  baseSize: { width: 960, height: 620 },
  currentSize: { width: 960, height: 620 },
  displayMode: 'double'
};

const flipbookEl = document.getElementById('flipbook');
const flipContainer = document.getElementById('flipContainer');
const flipWrapper = document.getElementById('flipWrapper');
const pageIndicator = document.getElementById('pageIndicator');
const inputPage = document.getElementById('inputPage');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnGo = document.getElementById('btnGo');
const btnToc = document.getElementById('btnToc');
const btnCloseToc = document.getElementById('btnCloseToc');
const sidebar = document.getElementById('sidebar');
const btnFullscreen = document.getElementById('btnFullscreen');
const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const zoomLabel = document.getElementById('zoomLabel');
const tocContainer = document.getElementById('tocContainer');
const pageSound = document.getElementById('pageSound');

init();

async function init() {
  if (!window.pdfjsLib) {
    console.error('PDF.js failed to load.');
    return;
  }

  wireControls();
  updateZoomLabel();

  try {
    await loadTOC();
  } catch (err) {
    console.warn('TOC load failed', err);
  }

  await loadPDF();
}

function wireControls() {
  btnPrev.addEventListener('click', () => $(flipbookEl).turn('previous'));
  btnNext.addEventListener('click', () => $(flipbookEl).turn('next'));
  btnGo.addEventListener('click', handleGoToPage);
  inputPage.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleGoToPage();
    }
  });

  btnToc.addEventListener('click', () => toggleSidebar(true));
  btnCloseToc.addEventListener('click', () => toggleSidebar(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleSidebar(false);
  });

  btnFullscreen.addEventListener('click', () => {
    if (isFullscreen()) {
      exitFullscreen();
    } else {
      requestFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', updateFullscreenIndicator);

  btnZoomIn.addEventListener('click', doZoomIn);
  btnZoomOut.addEventListener('click', doZoomOut);

  flipContainer.addEventListener('wheel', (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
      event.deltaY < 0 ? doZoomIn() : doZoomOut();
    }
  }, { passive: false });

  window.addEventListener('resize', throttle(() => resizeFlipbook(true), 160));
}

async function loadPDF() {
  try {
    if (!isFileProtocol && window.pdfjsLib.GlobalWorkerOptions) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdfjs/pdf.worker.min.js';
    }

    const loadingTask = window.pdfjsLib.getDocument({
      url: PDF_URL,
      cMapPacked: true,
      disableFontFace: false,
      disableWorker: isFileProtocol
    });

    state.pdfDoc = await loadingTask.promise;
    state.numPages = state.pdfDoc.numPages;
    inputPage.max = state.numPages;
    inputPage.placeholder = `1-${state.numPages}`;
    updatePageIndicator(1);

    buildPageShells(state.numPages);
    await initFlipbook();
    await ensureRenderedAround(1);
    $(flipbookEl).turn('page', 1);
  } catch (err) {
    console.error('Failed to load magazine.pdf', err);
    flipbookEl.innerHTML = `
      <div class="page-loading page-error">
        Unable to load magazine.pdf.<br/>
        ${err && err.message ? err.message : 'Please confirm the PDF is present and accessible.'}
      </div>
    `;
    state.numPages = 0;
    updatePageIndicator(0);
  }
}

function buildPageShells(count) {
  flipbookEl.innerHTML = '';
  for (let i = 1; i <= count; i += 1) {
    const page = document.createElement('div');
    page.className = 'flip-page';
    page.dataset.page = String(i);
    page.innerHTML = `<div class="page-loading">Loading page ${i}…</div>`;
    flipbookEl.appendChild(page);
  }
}

async function initFlipbook() {
  const { width, height } = computeBaseSize();
  state.baseSize = { width, height };
  state.currentSize = { width, height };
  flipbookEl.style.width = `${width}px`;
  flipbookEl.style.height = `${height}px`;

  $(flipbookEl).turn({
    width,
    height,
    autoCenter: true,
    elevation: 50,
    duration: 1100,
    gradients: true,
    display: width < 700 ? 'single' : 'double',
    when: {
      turning: function (_event, page) {
        ensureRenderedAround(page);
        playTurnSound();
      },
      turned: function (_event, page) {
        updatePageIndicator(page);
        inputPage.value = String(page);
        trimCacheAround(page);
      }
    }
  });
}

function resizeFlipbook(forceRender = false) {
  if (!state.pdfDoc) return;
  const { width, height } = computeBaseSize();
  state.baseSize = { width, height };
  const scaled = {
    width: width * state.currentZoom,
    height: height * state.currentZoom
  };
  state.currentSize = scaled;

  flipbookEl.style.width = `${scaled.width}px`;
  flipbookEl.style.height = `${scaled.height}px`;

  if ($(flipbookEl).data('turn')) {
    $(flipbookEl).turn('size', scaled.width, scaled.height);
    const nextDisplay = scaled.width < 640 ? 'single' : 'double';
    if (nextDisplay !== state.displayMode) {
      state.displayMode = nextDisplay;
      $(flipbookEl).turn('display', nextDisplay);
    }
  }

  if (forceRender) {
    const view = ($(flipbookEl).data('turn') && $(flipbookEl).turn('view')) || [];
    view.filter(Boolean).forEach((page) => renderPage(page, { force: true }));
  }
}

function computeBaseSize() {
  const containerWidth = Math.max(320, flipContainer.clientWidth - 40);
  const containerHeight = Math.max(320, flipContainer.clientHeight - 30);
  const pageRatio = 960 / 620;
  let width = containerWidth;
  let height = width / pageRatio;

  if (height > containerHeight) {
    height = containerHeight;
    width = height * pageRatio;
  }

  return { width, height };
}

function updatePageIndicator(page) {
  if (!state.numPages) return;
  const safePage = Math.min(Math.max(page, 1), state.numPages);
  pageIndicator.textContent = `Page ${safePage} of ${state.numPages}`;
}

function handleGoToPage() {
  if (!state.pdfDoc) return;
  const target = Number(inputPage.value);
  if (Number.isNaN(target)) return;
  const page = clamp(target, 1, state.numPages);
  $(flipbookEl).turn('page', page);
}

function toggleSidebar(forceOpen) {
  sidebar.classList.toggle('open', forceOpen ?? !sidebar.classList.contains('open'));
}

function requestFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  req?.call(el);
}

function exitFullscreen() {
  const doc = document;
  const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || doc.msExitFullscreen;
  exit?.call(doc);
}

function isFullscreen() {
  return Boolean(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
}

function updateFullscreenIndicator() {
  btnFullscreen.classList.toggle('active', isFullscreen());
}

function doZoomIn() {
  setZoom(state.currentZoom + state.zoomStep);
}

function doZoomOut() {
  setZoom(state.currentZoom - state.zoomStep);
}

function setZoom(next) {
  const clamped = clamp(next, state.minZoom, state.maxZoom);
  if (Math.abs(clamped - state.currentZoom) < 0.01) return;
  state.currentZoom = clamped;
  updateZoomLabel();
  resizeFlipbook(true);
}

function updateZoomLabel() {
  zoomLabel.textContent = `${Math.round(state.currentZoom * 100)}%`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function throttle(fn, wait) {
  let timer = null;
  return (...args) => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn.apply(null, args);
    }, wait);
  };
}

async function ensureRenderedAround(page) {
  if (!state.pdfDoc) return;
  const tasks = new Set();
  for (let offset = -2; offset <= 2; offset += 1) {
    const target = page + offset;
    if (target >= 1 && target <= state.numPages) {
      tasks.add(target);
    }
  }
  await Promise.all(Array.from(tasks).map((p) => renderPage(p)));
}

async function renderPage(pageNum, { force = false } = {}) {
  if (state.pageCache.has(pageNum) && !force) {
    applyPageImage(pageNum, state.pageCache.get(pageNum));
    return;
  }
  if (state.renderQueue.has(pageNum)) {
    return state.renderQueue.get(pageNum);
  }

  const job = (async () => {
    const page = await state.pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const displayMode = ($(flipbookEl).data('turn') && $(flipbookEl).turn('display')) || state.displayMode;
    const leafWidth = (state.currentSize?.width || flipbookEl.clientWidth) / (displayMode === 'double' ? 2 : 1);
    const maxHeight = state.currentSize?.height || flipbookEl.clientHeight;
    const deviceScale = window.devicePixelRatio || 1;
    const scale = Math.min(leafWidth / viewport.width, maxHeight / viewport.height) * deviceScale;
    const canvas = document.createElement('canvas');
    const view = page.getViewport({ scale: scale });
    canvas.width = Math.floor(view.width);
    canvas.height = Math.floor(view.height);
    const ctx = canvas.getContext('2d', { alpha: false });

    await page.render({ canvasContext: ctx, viewport: view }).promise;

    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    applyPageImage(pageNum, dataUrl);
    state.pageCache.set(pageNum, dataUrl);
    trimCacheSize();
  })().finally(() => {
    state.renderQueue.delete(pageNum);
  });

  state.renderQueue.set(pageNum, job);
  return job;
}

function applyPageImage(pageNum, dataUrl) {
  const pageEl = flipbookEl.querySelector(`.flip-page[data-page="${pageNum}"]`);
  if (!pageEl) return;
  const img = new Image();
  img.src = dataUrl;
  img.alt = `Magazine page ${pageNum}`;
  img.decoding = 'async';
  pageEl.innerHTML = '';
  pageEl.appendChild(img);
}

function trimCacheSize() {
  while (state.pageCache.size > state.maxCacheSize) {
    const firstKey = state.pageCache.keys().next().value;
    state.pageCache.delete(firstKey);
  }
}

function trimCacheAround(page) {
  const keep = new Set();
  for (let offset = -2; offset <= 3; offset += 1) {
    const target = page + offset;
    if (target >= 1 && target <= state.numPages) keep.add(target);
  }
  Array.from(state.pageCache.keys()).forEach((key) => {
    if (!keep.has(key)) state.pageCache.delete(key);
  });
}

function playTurnSound() {
  if (!pageSound || !pageSound.src || pageSound.src.endsWith('/')) return;
  if (pageSound.dataset.ready !== 'true') return;
  try {
    pageSound.currentTime = 0;
    pageSound.play().catch(() => {});
  } catch (err) {
    console.warn('Audio playback failed', err);
  }
}

async function loadTOC() {
  const response = await fetch('assets/toc.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('TOC missing');
  const data = await response.json();
  renderTOC(data.sections || []);
}

// Mark audio ready once metadata is available to avoid play() rejection.
if (pageSound) {
  pageSound.addEventListener('canplaythrough', () => {
    pageSound.dataset.ready = 'true';
  });
  pageSound.addEventListener('error', () => {
    console.warn('turn.mp3 failed to load.');
  });
}

function renderTOC(sections) {
  tocContainer.innerHTML = '';
  if (!sections.length) {
    tocContainer.innerHTML = '<div class="toc-empty">No sections defined yet.</div>';
    return;
  }
  sections.forEach((section) => {
    const block = document.createElement('div');
    block.className = 'toc-section';
    block.innerHTML = `
      <div class="toc-section-title">${section.title}</div>
      <a class="toc-link" data-page="${section.page}" href="#">
        <span>Jump to section</span>
        <span class="page">p.${section.page}</span>
      </a>
    `;
    const link = block.querySelector('a');
    link.addEventListener('click', (event) => {
      event.preventDefault();
      toggleSidebar(false);
      $(flipbookEl).turn('page', clamp(Number(section.page), 1, state.numPages));
    });
    tocContainer.appendChild(block);
  });
}
