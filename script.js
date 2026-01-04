const isFileProtocol = window.location.protocol === 'file:';
const PDF_URL = isFileProtocol ? 'magazine.pdf' : '/magazine.pdf';

const state = {
  pdfDoc: null,
  numPages: 0,
  currentZoom: 1,
  minZoom: 0.8,
  maxZoom: 3,
  zoomStep: 0.1,
  renderQueue: new Map(),
  pageCache: new Map(),
  maxCacheSize: 8,
  baseSize: { width: 960, height: 620 },
  currentSize: { width: 960, height: 620 },
  pageRatio: 960 / 620,
  displayMode: 'double',
  // Pan state (in CSS pixels), applied as translate on the scaled flipbook
  pan: { x: 0, y: 0 },
  isDragging: false,
  dragStart: { x: 0, y: 0 },
  panStart: { x: 0, y: 0 },
  // touch gesture state
  pinchStartDist: 0,
  pinchStartZoom: 1
};

const flipbookFrame = document.getElementById('flipbookFrame');
const flipbookZoom = document.getElementById('flipbookZoom');
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
const multiTurnSound = document.getElementById('multiTurnSound');

// Debounce helper function
function debounce(func, wait) {
  let timeout;
  return function() {
    const context = this;
    const args = arguments;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
}

// Initialize resize observer for responsive behavior
let resizeObserver;

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

  // Initialize resize observer
  resizeObserver = new ResizeObserver(debounce(() => {
    if (state.pdfDoc) {
      resizeFlipbook();
    }
  }, 100));
  resizeObserver.observe(flipContainer);

  loadPDF().catch(console.error);
}

// Initialize the application
init();

function handleSectionJump(rawTargetPage) {
  if (!state.pdfDoc) return;
  const targetPage = clamp(rawTargetPage, 1, state.numPages);
  const currentView = $(flipbookEl).turn('page') || 1;
  if (targetPage === currentView) return;

  state.jumpAnimation?.cancel?.();
  const direction = targetPage > currentView ? 1 : -1;
  const pageDelta = Math.abs(targetPage - currentView);
  const totalDuration = 4000;
  const frameRate = 12;
  const steps = Math.max(Math.min(pageDelta, frameRate * 4), 4);
  const interval = totalDuration / steps;
  const pages = [];
  const stepSize = pageDelta / steps;
  for (let i = 1; i <= steps; i += 1) {
    const nextPage = Math.round(currentView + direction * Math.min(pageDelta, i * stepSize));
    pages.push(clamp(nextPage, 1, state.numPages));
  }

  if (window.multiTurnSound && window.multiTurnSound.dataset.ready === 'true') {
    try {
      window.multiTurnSound.currentTime = 0;
      window.multiTurnSound.play().catch(() => {});
    } catch (err) {
      console.warn('Multi flip audio failed', err);
    }
  }

  const animation = {
    cancel() {
      clearTimeout(this.timer);
      this.active = false;
    },
    active: true,
    timer: null,
    queue: [...pages],
    start() {
      const next = this.queue.shift();
      if (next == null || !this.active) return;
      $(flipbookEl).turn('page', next);
      ensureRenderedAround(next);
      this.timer = setTimeout(() => this.start(), interval);
    }
  };

  state.jumpAnimation = animation;
  animation.start();
}
if (typeof window !== 'undefined') {
  window.handleSectionJump = handleSectionJump;
}

async function determinePageRatio() {
  if (!state.pdfDoc) return;
  try {
    const firstPage = await state.pdfDoc.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1 });
    if (viewport.width && viewport.height) {
      state.pageRatio = viewport.width / viewport.height;
    }
    firstPage.cleanup?.();
  } catch (err) {
    console.warn('Unable to determine PDF page ratio', err);
  }
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
  document.addEventListener('keydown', handleGlobalKeydown);

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

  // Wheel to pan; Ctrl+wheel to zoom at pointer
  flipContainer.addEventListener('wheel', (event) => {
    if (event.ctrlKey) {
      event.preventDefault();
      const focus = { clientX: event.clientX, clientY: event.clientY };
      event.deltaY < 0 ? doZoomIn(focus) : doZoomOut(focus);
      return;
    }
    // Otherwise pan
    const speed = 1; // direct pixels
    state.pan.x -= event.deltaX * speed;
    state.pan.y -= event.deltaY * speed;
    applyViewportTransform();
  }, { passive: false });

  // Drag-to-pan
  flipbookFrame.addEventListener('mousedown', (e) => {
    state.isDragging = true;
    flipbookFrame.classList.add('dragging');
    state.dragStart = { x: e.clientX, y: e.clientY };
    state.panStart = { ...state.pan };
  });
  window.addEventListener('mousemove', (e) => {
    if (!state.isDragging) return;
    const dx = e.clientX - state.dragStart.x;
    const dy = e.clientY - state.dragStart.y;
    state.pan.x = state.panStart.x + dx;
    state.pan.y = state.panStart.y + dy;
    applyViewportTransform();
  });
  const endDrag = () => {
    if (!state.isDragging) return;
    state.isDragging = false;
    flipbookFrame.classList.remove('dragging');
  };
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('mouseleave', endDrag);

  // Touch: 1 finger pan, 2 finger pinch-to-zoom with mobile optimizations
  flipbookFrame.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      state.isDragging = true;
      state.dragStart = { x: t.clientX, y: t.clientY };
      state.panStart = { ...state.pan };
      // Prevent default only if we're handling the gesture
      if (state.currentZoom > 1) {
        e.preventDefault();
      }
    } else if (e.touches.length === 2) {
      state.isDragging = false; // prefer pinch over drag
      const [t1, t2] = e.touches;
      state.pinchStartDist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      state.pinchStartZoom = state.currentZoom;
      e.preventDefault(); // Always prevent default for pinch
    }
  }, { passive: false });

  flipbookFrame.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && state.isDragging) {
      e.preventDefault();
      const t = e.touches[0];
      const dx = t.clientX - state.dragStart.x;
      const dy = t.clientY - state.dragStart.y;
      state.pan.x = state.panStart.x + dx;
      state.pan.y = state.panStart.y + dy;
      applyViewportTransform();
    } else if (e.touches.length === 2 && state.pinchStartDist > 0) {
      e.preventDefault();
      const [t1, t2] = e.touches;
      const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
      const factor = dist / state.pinchStartDist;
      const nextZoom = state.pinchStartZoom * factor;
      // midpoint as focus point
      const focus = { clientX: (t1.clientX + t2.clientX) / 2, clientY: (t1.clientY + t2.clientY) / 2 };
      setZoom(nextZoom, focus);
    }
  }, { passive: false });

  const endTouch = () => {
    state.isDragging = false;
    state.pinchStartDist = 0;
  };
  flipbookFrame.addEventListener('touchend', endTouch, { passive: true });
  flipbookFrame.addEventListener('touchcancel', endTouch, { passive: true });

  window.addEventListener('resize', throttle(() => resizeFlipbook(true), 160));
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape') {
    toggleSidebar(false);
    return;
  }

  const activeEl = document.activeElement;
  const isTyping = activeEl && ['input', 'textarea'].includes(activeEl.tagName?.toLowerCase());
  if (isTyping) return;

  const key = event.key.toLowerCase();
  const prevKeys = ['arrowleft', 'a'];
  const nextKeys = ['arrowright', 'd'];

  if (prevKeys.includes(key)) {
    event.preventDefault();
    $(flipbookEl).turn('previous');
  } else if (nextKeys.includes(key)) {
    event.preventDefault();
    $(flipbookEl).turn('next');
  }
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
    await determinePageRatio();
    inputPage.max = state.numPages;
    inputPage.placeholder = `1-${state.numPages}`;
    updatePageIndicator(1);

    buildPageShells(state.numPages);
    await initFlipbook();
    await ensureRenderedAround(1);
    $(flipbookEl).turn('page', 1);
    
    // Check mobile after initialization
    checkMobileOnLoad();
    ensureNoPageOverlap();
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
    const scroller = document.createElement('div');
    scroller.className = 'flip-page-scroll';
    scroller.innerHTML = `<div class="page-loading">Loading page ${i}…</div>`;
    page.appendChild(scroller);
    flipbookEl.appendChild(page);
  }
}

async function initFlipbook() {
  const { width, height, display } = computeBaseSize();
  state.baseSize = { width, height };
  state.currentSize = { width, height };
  state.displayMode = display;
  updateDisplayModeClass(display);
  setFrameSize(width, height);
  setContentSize({ frame: { width, height }, scaled: { width, height }, zoom: 1 });

  $(flipbookEl).turn({
    width: state.currentSize.width,
    height: state.currentSize.height,
    display: state.displayMode,
    acceleration: true, // Enable 3D acceleration for smooth animations
    autoCenter: true,
    duration: 600, // Optimized duration for natural feel
    gradients: true, // Enable gradients for realistic page curl
    elevation: 50, // Add subtle page lift effect
    turnCorners: 'bl,br', // Only show bottom corners for page turn
    when: {
      start: function(e, page, view) {
        // Ensure smooth start
        return new Promise(resolve => {
          requestAnimationFrame(() => {
            setTimeout(resolve, 50);
          });
        });
      },
      turning: function(e, page, view) {
        ensureRenderedAround(page);
        // Apply smooth 3D transforms during animation
        $(e.currentTarget).css({
          'transform-style': 'preserve-3d',
          'backface-visibility': 'hidden',
          'perspective': '1000px'
        });
      },
      turned: function(e, page, view) {
        updatePageIndicator(page);
        playTurnSound();
        trimCacheAround(page);
        // Reset transforms after animation completes
        $(e.currentTarget).css({
          'transform-style': '',
          'perspective': ''
        });
      }
    }
  });
  
  // Apply optimized 3D transforms for smooth page animations
  $('.turn-page').css({
    'transform-style': 'preserve-3d',
    'backface-visibility': 'hidden',
    'transition': 'transform 0.6s cubic-bezier(0.4, 0, 0.2, 1)',
    'will-change': 'transform'
  });
  
  // Ensure no page overlap on mobile
  ensureNoPageOverlap();
}

function resizeFlipbook(forceRender = false) {
  if (!state.pdfDoc) return;
  const { width, height, display } = computeBaseSize();
  state.baseSize = { width, height };
  const scaled = {
    width: width * state.currentZoom,
    height: height * state.currentZoom
  };
  state.currentSize = scaled;

  // The frame stays at base size; content grows to scaled size and becomes scrollable
  setFrameSize(width, height);
  setContentSize({ frame: { width, height }, scaled, zoom: state.currentZoom });

  if ($(flipbookEl).data('turn')) {
    // Keep Turn.js surface at base size; we scale the DOM element instead
    $(flipbookEl).turn('size', width, height);
    if (display !== state.displayMode) {
      state.displayMode = display;
      $(flipbookEl).turn('display', display);
    }
    updateDisplayModeClass(state.displayMode);
  } else {
    state.displayMode = display;
    updateDisplayModeClass(display);
  }

  if (forceRender) {
    const view = ($(flipbookEl).data('turn') && $(flipbookEl).turn('view')) || [];
    view.filter(Boolean).forEach((page) => renderPage(page, { force: true }));
  }
  
  // Ensure no page overlap after resize
  ensureNoPageOverlap();
}

function computeBaseSize() {
  // Use the full available container size; padding is already minimal in CSS
  const containerWidth = Math.max(320, flipContainer.clientWidth);
  const containerHeight = Math.max(320, flipContainer.clientHeight);
  const pageRatio = state.pageRatio || (960 / 620);

  // Check if we're on mobile (<= 767px)
  const isMobile = window.innerWidth <= 767;
  const isTablet = window.innerWidth >= 768 && window.innerWidth <= 1023;

  const calcSize = (pagesAcross) => {
    let leafWidth = containerWidth / pagesAcross;
    let height = leafWidth / pageRatio;
    if (height > containerHeight) {
      height = containerHeight;
      leafWidth = height * pageRatio;
    }
    return { leafWidth, height };
  };

  let pagesAcross = 2;
  let { leafWidth, height } = calcSize(pagesAcross);

  // Force single page on mobile
  if (isMobile) {
    pagesAcross = 1;
    ({ leafWidth, height } = calcSize(pagesAcross));
  }
  // On tablet, use single page if leaf width is too small
  else if (isTablet && leafWidth < 300) {
    pagesAcross = 1;
    ({ leafWidth, height } = calcSize(pagesAcross));
  }
  // On desktop, use single page if leaf width is too small
  else if (leafWidth < 260) {
    pagesAcross = 1;
    ({ leafWidth, height } = calcSize(pagesAcross));
  }

  const width = leafWidth * pagesAcross;
  const display = pagesAcross === 2 ? 'double' : 'single';

  return { width, height, display };
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
  const currentPage = $(flipbookEl).turn('page') || 1;
  const delta = Math.abs(page - currentPage);
  if (delta > 2) {
    handleSectionJump(page);
  } else {
    state.jumpAnimation?.cancel?.();
    $(flipbookEl).turn('page', page);
    ensureRenderedAround(page);
  }
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

function handleFullscreenChange() {
  flipbookEl.style.display = 'none';
  flipbookEl.offsetHeight; // Trigger reflow
  flipbookEl.style.display = '';

  setTimeout(() => {
    $(flipbookEl).turn('size', flipbookEl.clientWidth, flipbookEl.clientHeight);
    applyViewportTransform();
  }, 50);
}

function updateFullscreenIndicator() {
  const isFull = isFullscreen();
  btnFullscreen.textContent = isFull ? '⤡' : '⤢';
  
  handleFullscreenChange();
}

function doZoomIn(focus) {
  setZoom(state.currentZoom + state.zoomStep, focus);
}

function doZoomOut(focus) {
  setZoom(state.currentZoom - state.zoomStep, focus);
}

function setZoom(next, focus) {
  const clamped = clamp(next, state.minZoom, state.maxZoom);
  if (Math.abs(clamped - state.currentZoom) < 0.01) return;
  // Adjust pan so the zoom focuses around the pointer (or center)
  const frameRect = flipbookFrame.getBoundingClientRect();
  const fx = focus?.clientX ?? (frameRect.left + frameRect.width / 2);
  const fy = focus?.clientY ?? (frameRect.top + frameRect.height / 2);
  const before = clientToContentPoint(fx, fy);

  state.currentZoom = clamped;
  updateZoomLabel();
  resizeFlipbook(true);

  const after = clientToContentPoint(fx, fy);
  // Keep the same logical content point under the cursor by shifting pan
  state.pan.x += (after.x - before.x) * clamped;
  state.pan.y += (after.y - before.y) * clamped;
  applyViewportTransform();
}

function updateZoomLabel() {
  zoomLabel.textContent = `${Math.round(state.currentZoom * 100)}%`;
}

function updateDisplayModeClass(display) {
  flipbookEl.classList.toggle('is-double', display === 'double');
}

function setFrameSize(width, height) {
  if (flipbookFrame) {
    flipbookFrame.style.width = `${width}px`;
    flipbookFrame.style.height = `${height}px`;
  }
}

function setContentSize({ frame, scaled, zoom }) {
  // Viewport wrapper remains at frame size (no scrollbars)
  if (flipbookZoom) {
    flipbookZoom.style.width = `${frame.width}px`;
    flipbookZoom.style.height = `${frame.height}px`;
  }
  // Flipbook retains base logical size but is scaled and translated for pan/centering
  flipbookEl.style.width = `${frame.width}px`;
  flipbookEl.style.height = `${frame.height}px`;
  flipbookEl.style.transformOrigin = 'top left';
  applyViewportTransform();
}

// Zoom now uses transform on the flipbook element with a larger wrapper for scrollability

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

// Compute and apply the centered translate + scale transform to the flipbook element
function applyViewportTransform() {
  const base = state.baseSize;
  const zoom = state.currentZoom;
  // Auto-center within the frame
  const frameW = base.width;
  const frameH = base.height;
  const contentW = frameW * zoom;
  const contentH = frameH * zoom;
  const autoX = (frameW - contentW) / 2;
  const autoY = (frameH - contentH) / 2;
  const tx = autoX + state.pan.x;
  const ty = autoY + state.pan.y;
  flipbookEl.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
}

// Convert a client (viewport) point to the flipbook's unscaled content coordinates
function clientToContentPoint(clientX, clientY) {
  const rect = flipbookFrame.getBoundingClientRect();
  const localX = clientX - rect.left;
  const localY = clientY - rect.top;
  const base = state.baseSize;
  const zoom = state.currentZoom;
  const frameW = base.width;
  const frameH = base.height;
  const contentW = frameW * zoom;
  const contentH = frameH * zoom;
  const autoX = (frameW - contentW) / 2;
  const autoY = (frameH - contentH) / 2;
  // Reverse the current transform: subtract translate (auto + pan) and divide by scale
  return {
    x: (localX - autoX - state.pan.x) / zoom,
    y: (localY - autoY - state.pan.y) / zoom
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
    // Render sharper as we zoom; include a subtle oversample factor
    const oversample = 1.0;
    const scale = Math.min(leafWidth / viewport.width, maxHeight / viewport.height) * deviceScale * oversample;
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
  const scrollEl = pageEl.querySelector('.flip-page-scroll') || pageEl;
  const img = new Image();
  img.src = dataUrl;
  img.alt = `Magazine page ${pageNum}`;
  img.decoding = 'async';
  scrollEl.innerHTML = '';
  scrollEl.appendChild(img);
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

// Handle missing multiTurnSound gracefully
if (multiTurnSound) {
  multiTurnSound.addEventListener('canplaythrough', () => {
    multiTurnSound.dataset.ready = 'true';
  });
  multiTurnSound.addEventListener('error', () => {
    console.warn('turn_multiple_pages.mp3 not found - using regular page sound instead.');
    // Set multiTurnSound to null to prevent usage
    window.multiTurnSound = null;
  });
} else {
  window.multiTurnSound = null;
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
      handleSectionJump(Number(section.page));
    });
    tocContainer.appendChild(block);
  });
}

// Initialize responsive behavior
function initResponsiveBehavior() {
  // Add resize listener
  window.addEventListener('resize', debounce(() => {
    if (state.pdfDoc) {
      resizeFlipbook();
    }
  }, 250));
  
  // Handle orientation change on mobile
  window.addEventListener('orientationchange', () => {
    setTimeout(() => {
      if (state.pdfDoc) {
        resizeFlipbook();
      }
    }, 100);
  });
}

// Initialize responsive behavior when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  initResponsiveBehavior();
  checkMobileOnLoad();
});

// Ensure pages don't overlap on mobile
function ensureNoPageOverlap() {
  const isMobile = window.innerWidth <= 767;
  if (isMobile && $(flipbookEl).data('turn')) {
    // Force single page display on mobile
    const currentDisplay = $(flipbookEl).turn('display');
    if (currentDisplay === 'double') {
      $(flipbookEl).turn('display', 'single');
      updateDisplayModeClass('single');
      console.log('Switched to single page mode on mobile');
    }
    
    // Also force resize to ensure proper layout
    setTimeout(() => {
      resizeFlipbook();
    }, 100);
  }
}

// Add mobile detection on load
function checkMobileOnLoad() {
  const isMobile = window.innerWidth <= 767;
  if (isMobile) {
    document.body.classList.add('mobile-view');
    // Force single page mode immediately
    if ($(flipbookEl).data('turn')) {
      $(flipbookEl).turn('display', 'single');
      updateDisplayModeClass('single');
    }
  }
}
