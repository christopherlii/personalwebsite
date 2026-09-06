// ========================================
// SITE RENDERER
// ========================================

class Site {
  constructor() {
    this.posts = [];
    this.reading = [];
    this.solaces = [];
    this.view = 'home';
    this.slug = null;
    this.init();
  }

  init() {
    this.setupNavigation();
    this.setupScrollLock();
    this.setupBanner();
    this.setupCopyEmail();
  }

  // ========================================
  // BANNER
  // ========================================
  //
  // One sticky banner sits above every view. It opens to --banner-height and
  // shrinks with the scroll, so the height tracks how far you have read rather
  // than which view you are on. Stats is the exception — a dense data page,
  // not something you read or browse, so it stays a --banner-bar strip.
  // Articles show their own cover in the same card frame; home is the photo.

  setupBanner() {
    this.mobileMq = window.matchMedia('(max-width: 640px)');
    this.banner = document.getElementById('banner');
    this.bannerLayers = Array.from(document.querySelectorAll('.banner-media'));
    this.activeLayer = 0;
    this.bannerPhoto = null;
    this.bannerSpacer = document.getElementById('banner-spacer');
    this.breadcrumbEl = document.getElementById('breadcrumb');

    this.readBannerTokens();

    this.updateBanner = () => {
      if (!this.banner) return;
      const target = this.view === 'stats' ? this.bannerBar : this.bannerFull;

      // Phones: the banner never condenses — it stays a full hero on every
      // view (scrolling away natively), so navigation never animates height;
      // view fades and photo cross-fades carry the transition instead.
      if (this.mobileMq.matches) {
        this.banner.style.height = `${this.bannerFull}px`;
        this.banner.style.top = '';
        this.banner.classList.remove('condensed');
        if (this.bannerSpacer) this.bannerSpacer.style.height = '0px';
        return;
      }

      // Articles: the cover does not condense — the banner rides away at
      // full height with the scroll, like any other content, and long posts
      // get the full column back.
      if (this.view === 'thought') {
        this.banner.style.height = `${target}px`;
        this.banner.classList.remove('condensed');
        if (this.bannerSpacer) this.bannerSpacer.style.height = '0px';
        this.banner.style.top = `${this.bannerTop - window.scrollY}px`;
        return;
      }

      const h = Math.max(this.bannerBar, target - window.scrollY);

      this.banner.style.height = `${h}px`;
      this.banner.classList.toggle('condensed', h <= this.bannerBar + 1);
      if (this.bannerSpacer) this.bannerSpacer.style.height = `${target - h}px`;
      this.banner.style.top = `${this.bannerTop}px`;
    };

    this.onBannerResize = () => {
      this.readBannerTokens();
      this.updateBanner();
    };

    const grid = document.getElementById('banner-collage');
    if (grid) {
      grid.innerHTML = '<div class="collage-cell"></div>'.repeat(6);
      // Tapping a tile: a thing with more photos cycles through them; a
      // single-photo memory JOGS — it summons a different memory from the
      // same category (one not already on screen) into its tile.
      grid.addEventListener('click', e => {
        const cell = e.target.closest('.collage-cell');
        if (!cell) return;
        const img = cell.querySelector('.cell-layer:last-child img');
        if (!img) return;
        const thing = this.thingByLabel(img.getAttribute('alt'));
        if (!thing) return;
        if (thing.photos.length > 1) {
          const cur = img.getAttribute('src');
          const next = thing.photos[(thing.photos.indexOf(cur) + 1) % thing.photos.length];
          this.popLayer(cell, { src: next, label: thing.label });
          return;
        }
        const onScreen = new Set([...grid.querySelectorAll('.cell-layer img')]
          .map(i => i.getAttribute('alt')));
        const pool = this.allThings().filter(t =>
          t.cat === thing.cat && !onScreen.has(t.label));
        if (!pool.length) return;
        const jog = pool[Math.floor(Math.random() * pool.length)];
        const cellIndex = [...grid.querySelectorAll('.collage-cell')].indexOf(cell);
        this._slotMemory = this._slotMemory || {};
        this._slotMemory[jog.label] = cellIndex;
        this.popLayer(cell, {
          src: jog.photos[Math.floor(Math.random() * jog.photos.length)],
          label: jog.label
        });
      });
    }

    window.addEventListener('scroll', this.updateBanner, { passive: true });
    window.addEventListener('resize', this.onBannerResize);

    // The panel shadow dies on the click itself — navigation work (view
    // exit fade, image decode) runs 150ms+ later, and a shadow fading
    // around an emptying box reads as an outline.
    const drawnHashes = new Set(['#thoughts', '#reading']);
    const linkOf = e => e.target.closest && e.target.closest('a[href^="#"]');
    // Trial: the shadow leaves on hover (quick, not a slow fade), before the
    // click even happens; hover away and it returns.
    document.addEventListener('mouseover', e => {
      const a = linkOf(e);
      if (!a) return;
      // hovering toward favs starts warming its photo pool early
      if (a.getAttribute('href') === '#favorites') this.warmFavsPhotos();
      if (!this.banner || this.banner.classList.contains('drawn')) return;
      if (drawnHashes.has(a.getAttribute('href'))) this.banner.classList.add('unshadow');
    });
    document.addEventListener('mouseout', e => {
      if (linkOf(e) && this.banner) this.banner.classList.remove('unshadow');
    });
    document.addEventListener('click', e => {
      const a = linkOf(e);
      if (a && this.banner && drawnHashes.has(a.getAttribute('href'))) {
        this.banner.classList.add('travel-pending');
        this.banner.style.transition = 'none';
        this.banner.offsetHeight;
        this.banner.style.transition = '';
      }
    });

    this.updateBanner();
  }

  // Articles and stats always scroll. Everything else is meant to be a fixed
  // frame — but only lock it when the page genuinely fits, otherwise a long
  // list on a phone would be unreachable.
  setupScrollLock() {
    this.syncScrollLock = () => {
      const root = document.documentElement;
      root.classList.remove('no-scroll');
      if (this.view === 'thought') return;

      // Measure the real content, not the page's trailing padding — that
      // padding only exists to give scrolling views room at the end, and
      // clipping empty space costs nothing.
      const page = document.querySelector('.view:not(.hidden) .page');
      const last = page && page.lastElementChild;
      if (!last) return;
      const bottom = last.getBoundingClientRect().bottom + window.scrollY;
      if (bottom <= window.innerHeight - 12) {
        root.classList.add('no-scroll');
      }
    };
    window.addEventListener('resize', this.syncScrollLock);
    // Images without reserved space change the page height as they arrive,
    // so re-measure rather than locking a page that is about to grow.
    document.addEventListener('load', (e) => {
      if (e.target.tagName === 'IMG') this.syncScrollLock();
    }, true);
  }

  readBannerTokens() {
    const s = getComputedStyle(document.documentElement);
    this.bannerFull = parseInt(s.getPropertyValue('--banner-height'), 10) || 380;
    this.bannerBar = parseInt(s.getPropertyValue('--banner-bar'), 10) || 60;
    this.bannerTop = parseInt(s.getPropertyValue('--banner-top'), 10) || 44;
    this.bannerMs = parseInt(s.getPropertyValue('--banner-ms'), 10) || 650;
    this.bannerFadeMs = parseInt(s.getPropertyValue('--banner-fade-ms'), 10) || 500;
    this.chromeMs = parseInt(s.getPropertyValue('--chrome-ms'), 10) || 300;
    this.bannerOpenMs = parseInt(s.getPropertyValue('--banner-open-ms'), 10) || 500;
  }

  // Two stacked layers so a photo change cross-fades instead of cutting.
  // The swap waits for the image to decode, so the incoming layer never
  // fades in as the bare navy background while the photo downloads.
  // frame: 'full' (photo, full-bleed) | 'window' (the drawn hero twin,
  // full-bleed behind the travelling torn window) | 'card' (article covers,
  // boxed card). Determines layer geometry and which transition runs.
  setBannerPhoto(src, position, frame) {
    if (!this.bannerLayers || this.bannerLayers.length < 2) return;
    const pos = position || 'center';
    if (this.bannerPhoto && this.bannerPhoto.src === src && this.bannerPhoto.position === pos &&
        (frame || 'full') === this.bannerFrame) {
      this.applyBannerMode();
      this.releasePhoto();
      return;
    }
    this.bannerPhoto = { src, position: pos };
    this.bannerFrame = frame || 'full';
    // Anything riding the photo's beat (the chrome's outfit change) waits
    // here until the image is actually on screen.
    this._photoPending = true;

    const swap = () => {
      // A later request may have superseded this one while it decoded.
      if (this.bannerPhoto.src !== src || this.bannerPhoto.position !== pos) return;

      const stale = () => this.bannerPhoto.src !== src || this.bannerPhoto.position !== pos;
      const wasDrawn = this.banner && this.banner.classList.contains('drawn');
      const drawn = this.bannerMode === 'drawn';
      const current = this.bannerLayers[this.activeLayer];
      const next = this.bannerLayers[1 - this.activeLayer];
      const showing = !!current.style.backgroundImage;
      const frame = this.bannerFrame || (drawn ? 'window' : 'full');
      const curFrame = current.classList.contains('card') ? 'card'
        : current.classList.contains('cropped') ? 'window' : 'full';
      // ONE travelling window, shared by both layers, with the dissolve
      // happening inside it — two windows moving separately shows two torn
      // outlines at once.
      const travelIn = drawn && !wasDrawn && showing && frame === 'window';
      const travelOut = !drawn && wasDrawn && showing;

      const run = () => {
        if (stale()) return;
        clearTimeout(this._bannerSettleT);

        // Hard-reset the incoming layer while invisible — kills any state left
        // by rapid navigation before it can flash.
        next.style.transition = 'none';
        next.classList.remove('active');
        next.classList.remove('travelling');
        next.classList.remove('opening');
        next.classList.toggle('card', frame === 'card');
        // Start states: travelling-in windows begin beyond the frame;
        // travelling-out photos begin behind the closed window; resting
        // window frames sit at the closed window permanently.
        next.classList.toggle('beyond', travelIn);
        next.classList.toggle('cropped', travelOut || (frame === 'window' && !travelIn));
        next.style.backgroundImage = `url("${src}")`;
        next.style.backgroundPosition = pos;
        next.style.zIndex = '1';
        current.style.zIndex = '0';
        next.offsetHeight; // commit image and start state
        next.style.transition = '';

        // The photo component changes as one beat: image, window, scrim,
        // and panel shadow all ride .drawn from this same frame.
        this.applyBannerMode();
        this.releasePhoto();
        next.classList.add('active');
        if (travelIn) {
          // Both layers' windows sweep in from beyond the frame in lockstep —
          // identical masks every frame, one tear, with the photo dissolving
          // into its aligned twin inside it.
          current.style.transition = 'none';
          current.classList.add('beyond');
          current.offsetHeight;
          current.style.transition = '';
          current.classList.remove('beyond');
          current.classList.add('cropped');
          next.classList.remove('beyond');
          next.classList.add('cropped');
        }
        if (travelOut) {
          // Both windows open from the card rect straight PAST the frame to
          // the oversized rest mask — one motion. Stopping at the boundary
          // parks a complete torn ring just inside the frame (the visible
          // "outline"). 'travelling' is a pure marker keeping the scrim and
          // panel shadow gated until the photo owns the frame.
          next.classList.remove('cropped');
          next.classList.add('beyond');
          next.classList.add('travelling');
          next.classList.add('opening');
          if (curFrame === 'window') {
            current.classList.remove('cropped');
            current.classList.add('beyond');
            current.classList.add('opening');
          }
        }

        // Retire the covered layer once the fade has fully occluded it —
        // instantly and with transitions off, so the mask reset can't ghost
        // into the margins.
        this._bannerSettleT = setTimeout(() => {
          if (stale()) return;
          next.classList.remove('opening');
          // Photo owns the frame — release the dressing gate. .beyond and
          // the rest mask are both fully off-frame, so this swap is invisible.
          next.style.transition = 'none';
          next.classList.remove('beyond');
          next.classList.remove('travelling');
          next.offsetHeight;
          next.style.transition = '';
          current.style.transition = 'none';
          current.classList.remove('active');
          current.classList.remove('cropped');
          current.classList.remove('beyond');
          current.classList.remove('travelling');
          current.classList.remove('opening');
          current.offsetHeight;
          current.style.transition = '';
        }, (travelOut ? Math.max(this.bannerOpenMs, this.bannerMs) : this.bannerFadeMs) + 60);

        this.activeLayer = 1 - this.activeLayer;
      };

      run();
    };

    // Gate on the load event only — decode() looks tempting but never
    // settles in hidden tabs, which would leave the banner empty for anyone
    // opening the site in the background. A failed download keeps the
    // current photo.
    const img = new Image();
    img.src = src;
    if (img.complete && img.naturalWidth) {
      swap();
    } else {
      img.addEventListener('load', swap, { once: true });
    }
  }

  // The incoming photo has landed — let anything held for its beat go.
  releasePhoto() {
    this._photoPending = false;
    const waiting = this._photoWaiters || [];
    this._photoWaiters = [];
    waiting.forEach(fn => fn());
  }

  // Resolves when the pending photo swap runs, or after capMs — a download
  // that never finishes must not leave the header stuck mid-change.
  photoSettled(capMs) {
    if (!this._photoPending) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        this._photoWaiters = (this._photoWaiters || []).filter(fn => fn !== done);
        resolve();
      }, capMs);
      this._photoWaiters = this._photoWaiters || [];
      this._photoWaiters.push(done);
    });
  }

  // Warm the covers a view is about to offer, so the cross-fade is instant.
  preloadImages(srcs) {
    this._preloaded = this._preloaded || new Set();
    srcs.filter(Boolean).forEach(src => {
      if (this._preloaded.has(src)) return;
      this._preloaded.add(src);
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
    });
  }

  // Runs the height/top change through a CSS transition rather than snapping.
  // (Desktop only in practice — on phones the banner height never changes.)
  animateBanner() {
    if (!this.banner) return;
    this.banner.classList.add('animating');
    this.banner.offsetHeight; // let the transition apply before the height moves
    clearTimeout(this._bannerAnimT);
    this._bannerAnimT = setTimeout(() => {
      this.banner.classList.remove('animating');
      // the banner's height animation moves everything below it — only now
      // is the page's true height measurable (stats locks against scroll)
      if (this.syncScrollLock) this.syncScrollLock();
    }, this.bannerMs + 60);
  }

  // Breadcrumb: name / section / detail. Clicking the name goes home, except
  // on the home page itself, where it opens the stats page.
  renderBreadcrumb(section, detail) {
    if (!this.breadcrumbEl) return;
    // The name node persists across navigations so its color change rides
    // the same 350ms transition as the social icons — a rebuilt node would
    // snap to the new color. Only the tail is replaced.
    if (!this.crumbTailEl) {
      this.breadcrumbEl.innerHTML =
        '<span class="crumb-name">Christopher Li</span><span class="crumb-tail"></span>';
      this.breadcrumbEl.querySelector('.crumb-name').addEventListener('click', () => {
        if (this.view === 'home') this.showStats();
        else this.showHome();
      });
      this.crumbTailEl = this.breadcrumbEl.querySelector('.crumb-tail');
      this._crumbSegs = [];
    }
    const segs = [];
    if (section) {
      segs.push({
        key: 'section:' + section.hash,
        html: `<span class="crumb-sep">/</span><a class="crumb-link" href="#${section.hash}">${section.label}</a>`
      });
    }
    if (detail) {
      segs.push({
        key: 'detail:' + detail,
        html: `<span class="crumb-sep">/</span><span class="crumb-current">${detail}</span>`
      });
    }
    if (this._chromeSwapping) {
      // A text swap is in flight — the tail lands inside it, invisibly.
      this._pendingTailSegs = segs;
      return;
    }
    this.applyTailSegs(segs, true);
  }

  // ========================================
  // ARTICLE ENHANCEMENTS
  // ========================================

  setupPhotoShuffle() {
    document.querySelectorAll('.article-body .photo-shuffle').forEach(container => {
      const imgs = Array.from(container.querySelectorAll('img'));
      if (imgs.length === 0) return;

      let idx = 0;
      const showNext = () => {
        imgs.forEach(img => img.classList.remove('visible'));
        imgs[idx].classList.add('visible');
        idx = (idx + 1) % imgs.length;
      };

      showNext();
      container.addEventListener('click', showNext);
    });
  }

  enhanceArticleImages(container) {
    const imgs = Array.from(container.querySelectorAll('.article-body img'));
    imgs.forEach((img, idx) => {
      img.decoding = 'async';
      if (idx === 0) {
        img.loading = 'eager';
        img.fetchPriority = 'high';
      } else {
        img.loading = 'lazy';
        img.fetchPriority = 'low';
      }
    });
  }

  setupNavigation() {
    document.querySelectorAll('a[href="/"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.showHome();
      });
    });

    // Back/forward fires popstate and then hashchange for the same move —
    // route once, not twice. Plain anchor clicks only fire hashchange.
    window.addEventListener('popstate', async () => {
      this._suppressHash = true;
      try {
        await this.handleRoute();
      } finally {
        setTimeout(() => { this._suppressHash = false; }, 0);
      }
    });
    window.addEventListener('hashchange', () => {
      if (this._suppressHash) return;
      this.handleRoute();
    });
  }

  // Push a history entry only when the address actually changes — clicking a
  // real anchor already set the hash before the router ran, and pushing again
  // would double the entry.
  syncUrl(url) {
    if (url === '/') {
      if (window.location.hash) history.pushState(null, '', '/');
    } else if (window.location.hash !== url) {
      history.pushState(null, '', url);
    }
  }

  // "2026-05-10" -> "may 10, 2026"
  formatDate(dateStr) {
    if (!dateStr) return '';
    const m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return dateStr;
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const [, year, month, day] = m;
    return `${months[parseInt(month, 10) - 1]} ${parseInt(day, 10)}, ${year}`;
  }

  // ========================================
  // DATA
  // ========================================

  parseFrontMatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { attributes: {}, body: content };

    const attributes = {};
    match[1].split('\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const key = line.substring(0, idx).trim();
        let value = line.substring(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map(item => item.trim().replace(/['"]/g, ''));
        }
        attributes[key] = value;
      }
    });

    return { attributes, body: match[2] };
  }

  // The index carries every post's metadata (build.py), so lists render
  // without downloading a single post body — bodies load on demand in
  // loadPostBody. Plain-filename entries (the old index format) still work.
  async loadPosts() {
    try {
      let entries = [];
      try {
        const resp = await fetch('/posts/index.json', { cache: 'no-store' });
        if (resp.ok) entries = await resp.json();
      } catch (_) {}

      this.posts = entries
        .map(e => (typeof e === 'string' ? { file: e } : e))
        .filter(e => e.file && e.file.endsWith('.md'))
        .map(e => ({
          filename: e.file.replace('.md', ''),
          title: e.title || e.file.replace('.md', '').replace(/-/g, ' '),
          date: e.date || '',
          tags: e.tags || [],
          description: e.description || '',
          cover: e.cover || '',
          coverPosition: e.coverPosition || '',
          words: e.words || 0,
          content: null
        }));
      this.posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    } catch (e) { console.error(e); }
  }

  async loadPostBody(post) {
    if (post.content !== null) return;
    try {
      const resp = await fetch(`/posts/${post.filename}.md`, { cache: 'no-store' });
      const raw = await resp.text();
      const { body } = this.parseFrontMatter(raw);
      if (!post.words) post.words = body.split(/\s+/).length;
      post.content = typeof marked !== 'undefined' ? marked.parse(body) : body;
    } catch (e) {
      console.error(e);
      post.content = '<p>this post refused to load. try a refresh?</p>';
    }
  }

  async loadReading() {
    try {
      const resp = await fetch('/reading/index.json', { cache: 'no-store' });
      if (resp.ok) this.reading = await resp.json();
    } catch (e) { console.error(e); }
  }

  async loadSolaces() {
    try {
      const resp = await fetch('/solaces/index.json', { cache: 'no-store' });
      if (resp.ok) this.solaces = await resp.json();
    } catch (e) { console.error(e); }
  }

  // ========================================
  // VIEW MANAGEMENT
  // ========================================

  async fadeToView(viewId, viewName) {
    const currentView = document.querySelector('.view:not(.hidden)');
    const targetView = document.getElementById(viewId);

    if (currentView && currentView.id === 'youre-already-here-view') {
      this.stopAgeCounter();
    }

    if (currentView && currentView !== targetView) {
      // A choreographed view (home) exits in reverse — last element in leaves
      // first — which needs a longer hold than the plain fade.
      const reverseExit = currentView.querySelector('.page-entrance') &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      currentView.classList.add(reverseExit ? 'exiting' : 'fade-out');
      await new Promise(resolve => setTimeout(resolve, reverseExit ? 320 : 150));
      currentView.classList.add('hidden');
      currentView.classList.remove('fade-out', 'exiting');
    }

    if (targetView) {
      targetView.classList.add('fade-out');
      targetView.classList.remove('hidden');
      targetView.offsetHeight; // force reflow
      targetView.classList.remove('fade-out');
      const page = targetView.querySelector('.page');
      if (page) {
        page.style.animation = 'none';
        page.offsetHeight;
        page.style.animation = '';
      }
    }

    this.view = viewName;
    this._collageView = viewName === 'solaces';

    // Articles let the bar scroll away, so they don't need the top fade;
    // every other view keeps it floating and needs the strip above covered.
    document.body.classList.toggle('no-top-fade', viewName === 'thought');

    document.documentElement.classList.remove('no-scroll');
    window.scrollTo(0, 0);
    this.syncScrollLock();
    // Run again once the view's content has actually been rendered.
    setTimeout(this.syncScrollLock, 0);

    this.animateBanner();
    if (this.updateBanner) this.updateBanner();
  }

  homePhoto() {
    return { src: '/static/images/hero/rock.jpg', position: 'center 74%' };
  }

  // A thing never lands in the slot where it was last seen — not the slot
  // it holds right now, and not the one it had in its previous deal even if
  // the mix showed in between (per-thing slot memory persists). Bounded
  // repair passes; with six slots a clean arrangement always falls out.
  placeAvoidingRepeats(tiles, prevLabels) {
    const mem = this._slotMemory || {};
    const bad = (t, i) => !!t && (t.label === prevLabels[i] || mem[t.label] === i);
    const arr = tiles.slice();
    for (let pass = 0; pass < 10; pass++) {
      let clean = true;
      for (let i = 0; i < arr.length; i++) {
        if (bad(arr[i], i)) {
          clean = false;
          const j = arr.findIndex((t, k) => k !== i && !bad(t, i) && !bad(arr[i], k));
          if (j >= 0) [arr[i], arr[j]] = [arr[j], arr[i]];
        }
      }
      if (clean) break;
    }
    return arr;
  }

  // Fill the favorites hero grid: six persistent cells, each holding
  // stacked layers. On swap every tile crossfades to its new image
  // independently, at its own small random delay — they pop in one by one
  // in a different order every time. keepOrder pins the given order (the
  // at-rest mix must match the flat collage jpg cell for cell).
  renderCollage(cells, fade, keepOrder) {
    const grid = document.getElementById('banner-collage');
    if (!grid) return;
    let six = cells.slice(0, 6);
    while (six.length < 6) six.push(null);
    if (fade && !keepOrder) {
      const prevLabels = [...grid.querySelectorAll('.collage-cell')].map(cell => {
        const img = cell.querySelector('.cell-layer:last-child img');
        return img ? img.getAttribute('alt') : null;
      });
      six = this.placeAvoidingRepeats(six, prevLabels);
      // memory records DEALT arrangements only — the fixed mix is checked
      // as the currently-visible grid but never remembered, or it would
      // clobber a thing's true last-deal slot during the interlude
      this._slotMemory = this._slotMemory || {};
      six.forEach((t, i) => { if (t) this._slotMemory[t.label] = i; });
    }
    const layerHtml = c => c
      ? `<img src="${c.src}" alt="${c.label}"><figcaption>${c.label}</figcaption>`
      : '';
    const seq = this._collageSeq = (this._collageSeq || 0) + 1;
    const layers = [];
    const decoding = [];
    grid.querySelectorAll('.collage-cell').forEach((cell, i) => {
      // settle any previous swap: keep only the newest layer
      while (cell.children.length > 1) cell.firstChild.remove();
      const layer = document.createElement('figure');
      layer.className = 'cell-layer' + (six[i] ? '' : ' empty');
      layer.innerHTML = layerHtml(six[i]);
      // every non-empty tile responds to a tap (cycle or jog)
      cell.classList.toggle('cyclable', !!six[i]);
      if (!fade) {
        cell.replaceChildren(layer);
        return;
      }
      layer.classList.add('incoming');
      cell.appendChild(layer);
      layers.push(layer);
      const img = layer.querySelector('img');
      if (img && img.decode) decoding.push(img.decode().catch(() => {}));
    });
    if (!fade) return;
    // A deal never pops half-loaded pixels: the reveal waits (bounded)
    // until every incoming image has decoded, then runs the stagger —
    // six jittered slots with a guaranteed minimum gap, shuffled, so no
    // two photos ever land on the same beat.
    Promise.race([
      Promise.allSettled(decoding),
      new Promise(r => setTimeout(r, 1500))
    ]).then(() => {
      if (seq !== this._collageSeq) return;
      if (this.banner) this.banner.classList.add('dealt'); // the hand is landing
      const slots = [0, 1, 2, 3, 4, 5].map(i => Math.round(i * 110 + Math.random() * 70));
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
      layers.forEach((layer, i) => {
        layer.style.transitionDelay = `${slots[i]}ms`;
        layer.offsetHeight; // commit the hidden start before revealing
        layer.classList.add('shown');
      });
      clearTimeout(this._collageSwapT);
      this._collageSwapT = setTimeout(() => {
        if (seq !== this._collageSeq) return;
        grid.querySelectorAll('.collage-cell').forEach(cell => {
          while (cell.children.length > 1) cell.firstChild.remove();
          const last = cell.lastElementChild;
          if (last) {
            last.classList.remove('incoming', 'shown');
            last.style.transitionDelay = '';
          }
        });
      }, 1300);
    });
  }

  // Leaving favs for home: each tile pops to ITS slice of the home photo
  // (cover center 74% math, cut 3x2), staggered like a deal — the hero
  // assembles square by square, and the grid then drops over identical
  // pixels, invisibly. Resolves when the assembly has settled.
  renderCollagePieces() {
    const grid = document.getElementById('banner-collage');
    if (!grid) return Promise.resolve();
    const W = grid.clientWidth, H = grid.clientHeight;
    const scale = W / 1142;                       // rock.jpg cover, width-bound
    const bgH = 1600 * scale;
    const offY = (bgH - H) * 0.74;
    const seq = this._collageSeq = (this._collageSeq || 0) + 1;
    const layers = [];
    grid.querySelectorAll('.collage-cell').forEach((cell, i) => {
      while (cell.children.length > 1) cell.firstChild.remove();
      const col = i % 3, row = (i / 3) | 0;
      const layer = document.createElement('div');
      layer.className = 'cell-layer incoming piece';
      layer.style.backgroundImage = "url('/static/images/hero/rock.jpg')";
      layer.style.backgroundSize = `${W}px ${Math.round(bgH)}px`;
      layer.style.backgroundPosition =
        `-${Math.round(col * W / 3)}px -${Math.round(offY + row * H / 2)}px`;
      cell.appendChild(layer);
      cell.classList.remove('cyclable');
      layers.push(layer);
    });
    const img = new Image();
    img.src = '/static/images/hero/rock.jpg';
    const ready = img.decode ? img.decode().catch(() => {}) : Promise.resolve();
    return ready.then(() => new Promise(done => {
      if (seq !== this._collageSeq) { done(); return; }
      const slots = [0, 1, 2, 3, 4, 5].map(i => Math.round(i * 90 + Math.random() * 55));
      for (let i = slots.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [slots[i], slots[j]] = [slots[j], slots[i]];
      }
      layers.forEach((layer, i) => {
        layer.style.transitionDelay = `${slots[i]}ms`;
        layer.offsetHeight;
        layer.classList.add('shown');
      });
      setTimeout(done, 505 + 480 + 80);
    }));
  }

  // Quietly fetch every favs photo in a few gentle lanes, so deals after
  // the first moments on the page never wait on the network.
  warmFavsPhotos() {
    if (this._favsWarmed || !this.solaces.length) return;
    this._favsWarmed = true;
    const srcs = this.allThings().flatMap(t => t.photos);
    let i = 0;
    const next = () => {
      if (i >= srcs.length) return;
      const img = new Image();
      img.decoding = 'async';
      img.onload = img.onerror = () => setTimeout(next, 25);
      img.src = srcs[i++];
    };
    for (let lane = 0; lane < 4; lane++) setTimeout(next, 500 + lane * 150);
  }

  allThings() {
    return this.solaces.flatMap(c => this.categoryThings(c));
  }

  thingByLabel(label) {
    return this.allThings().find(t => t.label === label);
  }

  // Pop a single new layer into one tile (used by tile clicks); the cell
  // settles itself down to one layer afterwards.
  popLayer(cell, thing) {
    const layer = document.createElement('figure');
    layer.className = 'cell-layer incoming';
    layer.innerHTML =
      `<img src="${thing.src}" alt="${thing.label}"><figcaption>${thing.label}</figcaption>`;
    cell.appendChild(layer);
    const img = layer.querySelector('img');
    const reveal = () => {
      layer.offsetHeight;
      layer.classList.add('shown');
    };
    if (img && img.decode) img.decode().catch(() => {}).then(reveal);
    else reveal();
    clearTimeout(cell._settleT);
    cell._settleT = setTimeout(() => {
      while (cell.children.length > 1) cell.firstChild.remove();
      const last = cell.lastElementChild;
      if (last) last.classList.remove('incoming', 'shown');
    }, 700);
  }

  // A thing and its photos: either a photos[] array or a single previewImage.
  categoryThings(cat) {
    return cat.items
      .map(i => ({ label: i.name, cat: cat.title,
                   photos: i.photos || (i.previewImage ? [i.previewImage] : []) }))
      .filter(t => t.photos.length);
  }

  shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Deal up to six tiles: shuffle the THINGS, take six, one randomly chosen
  // photo from each — so no two photos of the same thing ever share a set,
  // and a thing with several photos shows a different face across deals.
  dealSix(things) {
    return this.shuffled(things).slice(0, 6).map(th => ({
      src: th.photos[Math.floor(Math.random() * th.photos.length)],
      label: th.label
    }));
  }

  // A fresh deal never repeats what is currently on screen when it can
  // help it: unseen things first, then on-screen things wearing an unseen
  // photo, then (only to fill out six) anything left. Re-dealing a category
  // therefore keeps the same six things but flips their stills.
  dealFresh(things, allow) {
    const ok = allow || (() => true);
    const grid = document.getElementById('banner-collage');
    const current = grid
      ? [...grid.querySelectorAll('.collage-cell .cell-layer img')]
          .map(i => ({ label: i.getAttribute('alt'), src: i.getAttribute('src') }))
      : [];
    const curLabels = new Set(current.map(c => c.label));
    const curSrcs = new Set(current.map(c => new URL(c.src, location.href).pathname));
    const fresh = this.shuffled(things.filter(t => !curLabels.has(t.label)));
    const alts = this.shuffled(things.filter(t =>
      curLabels.has(t.label) && t.photos.some(ph => !curSrcs.has(ph))));
    const picks = [];
    for (const tier of [fresh, alts, this.shuffled(things)]) {
      for (const t of tier) {
        if (picks.length >= 6) break;
        if (!picks.includes(t) && ok(t, picks)) picks.push(t);
      }
    }
    return picks.map(t => {
      const unseen = t.photos.filter(ph => !curSrcs.has(ph));
      const pool = unseen.length ? unseen : t.photos;
      return { src: pool[Math.floor(Math.random() * pool.length)], label: t.label };
    });
  }

  // A randomize-style hand is compositionally balanced, not just capped:
  // exactly one media tile (sports or films), at least two friends, at
  // least two side quests, and one flex personal tile — so every hand has
  // one sports/movie, some group shots, some scenery. Freshness rules
  // apply within each quota bucket, and the final order is shuffled.
  // Used by the randomize button and by every arrival at the favs page.
  randomDeal() {
    const quotas = [
      { cats: ['sports', 'films'], n: 1 },
      { cats: ['friends'], n: 2 },
      { cats: ['side quests'], n: 2 },
      { cats: ['friends', 'side quests'], n: 1 },
    ];
    const taken = new Set();
    const hand = [];
    for (const q of quotas) {
      const pool = this.allThings().filter(t => q.cats.includes(t.cat) && !taken.has(t.label));
      for (const tile of this.dealFresh(pool).slice(0, q.n)) {
        taken.add(tile.label);
        hand.push(tile);
      }
    }
    return this.shuffled(hand);
  }

  // Empty every tile (fully transparent — not the placeholder block), so an
  // arrival can pop the images in one by one over the banner beneath.
  clearCollage() {
    const grid = document.getElementById('banner-collage');
    if (!grid) return;
    clearTimeout(this._collageSwapT);
    if (this.banner) this.banner.classList.remove('dealt');
    grid.querySelectorAll('.collage-cell').forEach(cell => cell.replaceChildren());
  }

  // 'photo' is the original full-bleed hero (home, article covers); 'drawn'
  // insets the image below the chrome as a torn-paper card. Only records the
  // request — the chrome class and the incoming layer's geometry are applied
  // inside the photo swap, so chrome colors, frame, and image all change on
  // the same frame, however long the image takes to decode.
  setBannerMode(mode) {
    const boundary = this.banner && this.bannerPhoto &&
      (mode === 'drawn') !== this.banner.classList.contains('drawn');
    this.bannerMode = mode;
    if (boundary) {
      // The panel shadow must die at CLICK time — the swap (and its gates)
      // waits for the image, and a shadow fading around an emptying box is
      // a visible outline.
      this.banner.classList.add('travel-pending');
      // Crossing the photo/drawn boundary, the text runs as its own single
      // component: out in the old outfit, restyle invisibly, back in the
      // new one. Going home it holds until the photo has mostly arrived.
      const hold = mode === 'drawn'
        ? 0
        : Math.max(0, Math.round(this.bannerOpenMs * 0.65) - this.chromeMs);
      this.swapChrome(hold);
    }
  }

  applyBannerMode() {
    if (!this.banner) return;
    this.banner.classList.remove('travel-pending');
    this.banner.classList.toggle('collage', this._holdCollage || this._collageView);
    this.banner.classList.toggle('drawn', this.bannerMode === 'drawn');
    // Outside a text swap (cold loads, same-image mode syncs), the text
    // outfit just follows the mode.
    if (!this._chromeSwapping) {
      this.banner.classList.toggle('ink', this.bannerMode === 'drawn');
    }
  }

  // The whole header (name, tail, icons) fades out, changes outfit and tail
  // while invisible, and fades back in with the tail sliding from behind the
  // name. All text change lives in this one gesture.
  swapChrome(holdMs) {
    const header = this.banner && this.banner.querySelector('.banner-header');
    if (!header) return;
    clearTimeout(this._chromeOutT);
    clearTimeout(this._chromeInT);
    const token = (this._chromeToken = (this._chromeToken || 0) + 1);
    this._chromeSwapping = true;
    header.classList.add('swapping');
    this._chromeOutT = setTimeout(async () => {
      // The outfit belongs to the photo's beat, not to a clock started at the
      // click: on a cold open the drawing can be a second behind, and
      // restyling on time lands ink text on the photograph still full-bleed
      // underneath it. Faded out, the wait costs nothing to look at.
      await this.photoSettled(1500);
      if (token !== this._chromeToken) return;
      this.banner.classList.toggle('ink', this.bannerMode === 'drawn');
      if (this._pendingTailSegs) {
        this.applyTailSegs(this._pendingTailSegs, false);
        this._pendingTailSegs = null;
      }
      this._chromeInT = setTimeout(() => {
        this._chromeSwapping = false;
        header.classList.remove('swapping');
        // The rebuilt tail slides out as one piece with the header's return.
        (this._crumbSegs || []).forEach(seg => {
          seg.el.classList.remove('seg-in');
          void seg.el.offsetWidth;
          seg.el.classList.add('seg-in');
        });
      }, holdMs);
    }, this.chromeMs);
  }

  // The tail changes incrementally: segments already in place stay put; a
  // removed segment slides back underneath what precedes it; an added one
  // slides out from behind it. Only the differing suffix ever moves.
  applyTailSegs(segs, animate) {
    const cur = this._crumbSegs || [];
    let k = 0;
    while (k < cur.length && k < segs.length && cur[k].key === segs[k].key) k++;
    if (k === cur.length && k === segs.length) return;
    for (let i = cur.length - 1; i >= k; i--) {
      const el = cur[i].el;
      if (animate) {
        // Freeze it out of the flow so a replacement takes its spot at once,
        // then let it slide under its predecessor and fade.
        el.style.left = `${el.offsetLeft}px`;
        el.style.top = `${el.offsetTop}px`;
        el.style.position = 'absolute';
        el.classList.add('seg-out');
        setTimeout(() => el.remove(), 450);
      } else {
        el.remove();
      }
    }
    const next = cur.slice(0, k);
    for (let i = k; i < segs.length; i++) {
      const el = document.createElement('span');
      el.className = 'crumb-seg';
      el.style.zIndex = String(30 - i); // earlier crumbs occlude later ones
      el.innerHTML = segs[i].html;
      this.crumbTailEl.appendChild(el);
      if (animate) el.classList.add('seg-in');
      next.push({ key: segs[i].key, el });
    }
    this._crumbSegs = next;
  }

  // The painting as rock.jpg's TWIN (baked by .context/bake_hero_card.py):
  // same aspect and anchor, so under identical cover math the two images
  // align at every window width. Shown behind the travelling torn window
  // (.cropped), never as a separate box.
  drawnPhoto() {
    return { src: '/static/images/hero/rock-drawn-hero.jpg', position: 'center 74%' };
  }

  // Home is the photograph, full-bleed. Every other view without a cover of
  // its own is the drawing, as a card.
  showDrawnHero() {
    this.setBannerMode('drawn');
    const photo = this.drawnPhoto();
    this.setBannerPhoto(photo.src, photo.position, 'window');
  }

  async showHome() {
    await this.fadeToView('home-view', 'home');
    const photo = this.homePhoto();
    const viaCollage = this.banner && this.banner.classList.contains('collage');
    this.setBannerMode('photo');
    if (viaCollage) {
      // the tiles assemble the home photo square by square, over the
      // dissolving backdrop; the grid then drops over identical pixels
      this._holdCollage = true;
      this.setBannerPhoto(photo.src, photo.position, 'full');
      this.renderCollagePieces().then(() => {
        this._holdCollage = false;
        this.applyBannerMode();
        setTimeout(() => this.clearCollage(), 700);
      });
    } else {
      this.setBannerPhoto(photo.src, photo.position, 'full');
    }
    this.preloadImages([this.drawnPhoto().src]);
    this.renderBreadcrumb(null, null);
    this.syncUrl('/');
  }

  async showThoughtsList() {
    await this.fadeToView('thoughts-view', 'thoughts');
    this.showDrawnHero();
    this.renderBreadcrumb({ label: 'writing', hash: 'thoughts' }, null);

    const list = document.getElementById('thoughts-full-list');
    list.innerHTML = this.posts.map(post => `
      <a class="thought-row" href="#thought/${post.filename}" data-post="${post.filename}">
        <span class="thought-title">${post.title}</span>
        <span class="thought-date">${this.formatDate(post.date)}</span>
      </a>
    `).join('') || '<p class="empty-note">no thoughts yet.</p>';

    this.preloadImages(this.posts.map(p => p.cover));

    this.syncUrl('#thoughts');
  }

  readingTime(post) {
    return Math.max(1, Math.round((post.words || 0) / 200));
  }

  async showThought(postId) {
    const post = this.posts.find(p => p.filename === postId);
    if (!post) return this.showThoughtsList();

    await Promise.all([
      this.fadeToView('thought-view', 'thought'),
      this.loadPostBody(post)
    ]);
    this.slug = postId;

    if (post.cover) {
      // Covers use the same card frame as the writing page.
      this.setBannerMode('drawn');
      this.setBannerPhoto(post.cover, post.coverPosition, 'card');
    } else {
      this.showDrawnHero();
    }
    this.renderBreadcrumb({ label: 'writing', hash: 'thoughts' }, post.title);

    // "next" walks backward in time, like flipping deeper into an archive.
    const older = this.posts[this.posts.indexOf(post) + 1];

    document.getElementById('thought-content').innerHTML = `
      <header class="article-header">
        <h1 class="article-title">${post.title}</h1>
        <time class="article-date">${this.formatDate(post.date)} · ${this.readingTime(post)} min read</time>
      </header>
      <div class="article-body">${post.content}</div>
      <footer class="article-footer">
        <a href="#thoughts">← all writing</a>
        ${older ? `<a href="#thought/${older.filename}">next: ${older.title} →</a>` : ''}
      </footer>
    `;

    this.enhanceArticleImages(document.getElementById('thought-content'));
    this.setupPhotoShuffle();
    this.updateBanner();

    this.syncUrl(`#thought/${postId}`);
  }

  // ========================================
  // PROJECTS
  // ========================================

  async showReadingList() {
    await this.fadeToView('reading-view', 'reading');
    this.showDrawnHero();
    this.renderBreadcrumb({ label: 'writing', hash: 'thoughts' }, 'reading');

    const list = document.getElementById('reading-list');
    list.innerHTML = this.reading.map(item => `
      <div class="reading-item">
        <div class="reading-item-title">
          ${item.url ? `<a href="${item.url}" target="_blank" rel="noopener">${item.title}</a>` : item.title}
        </div>
        ${item.author ? `<div class="reading-item-author">${item.author}</div>` : ''}
      </div>
    `).join('') || '<p class="empty-note">no readings yet.</p>';

    this.syncUrl('#reading');
  }

  // ========================================
  // FAVORITES
  // ========================================

  async showSolacesList() {
    await this.fadeToView('solaces-view', 'solaces');
    // Arriving at favs, the banner image is NOT swapped: the previous hero
    // stays beneath and the dealt tiles pop in over it — un-popped cells
    // show pieces of where you came from, never a second set. On a cold
    // load there is no previous hero, so the hand fills out over nothing
    // but the page itself.
    this.setBannerMode('photo');
    this.applyBannerMode(); // normalize chrome/gates + turn the grid on
    this.clearCollage();
    this.renderCollage(this.randomDeal(), true);
    this.warmFavsPhotos();
    this.renderBreadcrumb({ label: 'favs', hash: 'favorites' }, null);

    const container = document.getElementById('solaces-list');
    if (!container) return;

    // Categories whose items carry images render as shelves of torn-edge
    // photo cards (the banner's deckle language, miniature); the rest stay
    // quiet text lists.
    // The page is just the hero and this strip: each word is a button that
    // fills the hero grid with that category's photos. Categories without
    // photos yet sit disabled until they're uploaded.
    container.innerHTML = `<div class="solaces-strip">` +
      `<button class="strip-btn" data-cat="__random">randomize</button>` +
      this.solaces.map(c => {
        const has = this.categoryThings(c).length > 0;
        return `<button class="strip-btn" data-cat="${c.title}"${has ? '' : ' disabled'}>${c.title}</button>`;
      }).join('') +
      `</div>`;

    container.querySelectorAll('.strip-btn:not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.strip-btn').forEach(b => b.classList.remove('active'));
        if (btn.dataset.cat === '__random') {
          // an action, not a state: a fresh capped hand
          this.renderCollage(this.randomDeal(), true);
          return;
        }
        btn.classList.add('active');
        // a topic stays within itself: dealt from its own things only.
        // Re-clicking the active topic re-deals it — same things, unseen
        // stills, reshuffled slots. Only "randomize" leaves the topic.
        this.renderCollage(
          this.dealFresh(this.categoryThings(this.solaces.find(c => c.title === btn.dataset.cat))), true);
      });
    });

    this.syncUrl('#favorites');
  }

  // ========================================
  // STATS
  // ========================================

  async showStats() {
    await this.fadeToView('youre-already-here-view', 'stats');
    // Stats is a 60px bar — no room for the card, so it keeps the condensed
    // photo strip.
    this.setBannerMode('photo');
    {
      const photo = this.homePhoto();
      this.setBannerPhoto(photo.src, photo.position);
    }
    this.renderBreadcrumb(null, 'info');
    this.startAgeCounter();
    this.syncUrl('#stats');
  }

  startAgeCounter() {
    const el = document.getElementById('easter-age');
    if (!el) return;
    const birth = new Date('2004-06-10T08:00:00');
    const msPerYear = 365.2425 * 24 * 60 * 60 * 1000;
    const update = () => {
      el.textContent = ((Date.now() - birth.getTime()) / msPerYear).toFixed(9);
      this._ageFrame = requestAnimationFrame(update);
    };
    update();
  }

  stopAgeCounter() {
    if (this._ageFrame) {
      cancelAnimationFrame(this._ageFrame);
      this._ageFrame = null;
    }
  }

  // ========================================
  // CONTACT
  // ========================================

  // The email line copies the real address on click and briefly says so.
  setupCopyEmail() {
    const btn = document.getElementById('copy-email');
    if (!btn) return;
    const original = btn.textContent;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText('christopherli@nyu.edu');
      } catch (_) {
        return; // no clipboard access — leave the text as the hint it is
      }
      btn.textContent = 'copied :)';
      clearTimeout(this._copyT);
      this._copyT = setTimeout(() => { btn.textContent = original; }, 1600);
    });
  }

  // ========================================
  // ROUTING
  // ========================================

  async handleRoute() {
    const hash = window.location.hash.replace('#', '');

    if (!hash || hash === '/') {
      await this.showHome();
    } else if (hash === 'thoughts' || hash.startsWith('thoughts/')) {
      await this.showThoughtsList();
    } else if (hash === 'reading') {
      await this.showReadingList();
    } else if (hash === 'favorites' || hash === 'solaces') {
      await this.showSolacesList();
    } else if (hash === 'stats' || hash === 'youre-already-here') {
      await this.showStats();
    } else if (hash.startsWith('thought/')) {
      const postId = hash.replace('thought/', '');
      // On a direct load, inject the writing list behind the article so
      // browser-back lands there. In-app clicks already have it behind them.
      if (!this._routedOnce) {
        history.replaceState(null, '', '#thoughts');
        history.pushState(null, '', `#thought/${postId}`);
      }
      await this.showThought(postId);
    } else {
      await this.showHome();
    }

    this._routedOnce = true;
  }
}

// ========================================
// INITIALIZE
// ========================================

document.addEventListener('DOMContentLoaded', async () => {
  const site = new Site();
  window.site = site; // console/debug access

  await Promise.all([
    site.loadPosts(),
    site.loadReading(),
    site.loadSolaces()
  ]);

  // Warm every banner image up front — swaps gate on load, so anything not
  // already in cache would give the transition a visible loading beat.
  site.preloadImages(site.posts.map(p => p.cover));

  await site.handleRoute();

  document.documentElement.classList.remove('route-pending');
});
