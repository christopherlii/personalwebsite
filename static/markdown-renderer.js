// ========================================
// SITE RENDERER
// ========================================

class Site {
  constructor() {
    this.posts = [];
    this.projects = [];
    this.reading = [];
    this.solaces = [];
    this.view = 'home';
    this.slug = null;
    this.darkMq = window.matchMedia('(prefers-color-scheme: dark)');
    this.init();
  }

  init() {
    this.setupNavigation();
    this.setupScrollLock();
    this.setupBanner();
    this.setupCopyEmail();
    // Photos can carry a night variant — swap when the scheme flips.
    this.darkMq.addEventListener('change', () => this.applyViewPhoto());
  }

  // ========================================
  // BANNER
  // ========================================
  //
  // One sticky banner sits above every view. On home and article pages it
  // opens to --banner-height and shrinks with the scroll; everywhere else it
  // stays a --banner-bar strip. Articles show their own cover, everything
  // else shows the home photo.

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
      const target = this.view === 'home' || this.view === 'thought' || this.view === 'solaces'
        ? this.bannerFull
        : this.bannerBar;

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

      const h = Math.max(this.bannerBar, target - window.scrollY);

      this.banner.style.height = `${h}px`;
      this.banner.classList.toggle('condensed', h <= this.bannerBar + 1);
      if (this.bannerSpacer) this.bannerSpacer.style.height = `${target - h}px`;

      // On an article the bar slides away once it has finished collapsing,
      // so long posts get the full column back.
      const past = Math.max(0, window.scrollY - (target - this.bannerBar));
      const top = this.view === 'thought' ? this.bannerTop - past : this.bannerTop;
      this.banner.style.top = `${top}px`;
    };

    this.onBannerResize = () => {
      this.readBannerTokens();
      this.updateBanner();
    };

    window.addEventListener('scroll', this.updateBanner, { passive: true });
    window.addEventListener('resize', this.onBannerResize);
    this.updateBanner();
  }

  // Articles and stats always scroll. Everything else is meant to be a fixed
  // frame — but only lock it when the page genuinely fits, otherwise a long
  // list (favorites and projects on a phone) would be unreachable.
  setupScrollLock() {
    this.syncScrollLock = () => {
      const root = document.documentElement;
      root.classList.remove('no-scroll');
      if (this.view === 'thought' || this.view === 'stats') return;

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
  }

  // Two stacked layers so a photo change cross-fades instead of cutting.
  // The swap waits for the image to decode, so the incoming layer never
  // fades in as the bare navy background while the photo downloads.
  setBannerPhoto(src, position) {
    if (!this.bannerLayers || this.bannerLayers.length < 2) return;
    const pos = position || 'center';
    if (this.bannerPhoto && this.bannerPhoto.src === src && this.bannerPhoto.position === pos) {
      return;
    }
    this.bannerPhoto = { src, position: pos };

    const swap = () => {
      // A later request may have superseded this one while it decoded.
      if (this.bannerPhoto.src !== src || this.bannerPhoto.position !== pos) return;

      const current = this.bannerLayers[this.activeLayer];
      const next = this.bannerLayers[1 - this.activeLayer];

      next.style.backgroundImage = `url("${src}")`;
      next.style.backgroundPosition = pos;
      next.offsetHeight; // commit the new image before flipping opacity
      next.classList.add('active');
      current.classList.remove('active');

      this.activeLayer = 1 - this.activeLayer;
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
    }, this.bannerMs + 60);
  }

  // Breadcrumb: name / section / detail. Clicking the name goes home, except
  // on the home page itself, where it opens the stats page.
  renderBreadcrumb(section, detail) {
    if (!this.breadcrumbEl) return;
    const parts = ['<span class="crumb-name" data-nav="name">Christopher Li</span>'];
    if (section) {
      parts.push('<span class="crumb-sep">/</span>');
      parts.push(`<a class="crumb-link" href="#${section.hash}">${section.label}</a>`);
    }
    if (detail) {
      parts.push('<span class="crumb-sep">/</span>');
      parts.push(`<span class="crumb-current">${detail}</span>`);
    }
    this.breadcrumbEl.innerHTML = parts.join('');

    // Hovering the name previews the home photo, same sticky fade as the
    // writing-list rows — but only on fixed-frame pages where the banner sits
    // condensed to the bar. Expanded heroes, articles, and any page that
    // scrolls are left alone.
    const nameEl = this.breadcrumbEl.querySelector('.crumb-name');
    if (nameEl) {
      nameEl.addEventListener('mouseenter', () => {
        const condensed = this.banner && this.banner.offsetHeight <= this.bannerBar + 2;
        const fixedFrame = document.documentElement.classList.contains('no-scroll');
        if (condensed && fixedFrame) {
          const photo = this.homePhoto();
          this.setBannerPhoto(photo.src, photo.position);
        }
      });
    }

    this.breadcrumbEl.querySelectorAll('[data-nav]').forEach(el => {
      el.addEventListener('click', () => {
        const nav = el.dataset.nav;
        if (nav === 'name') {
          if (this.view === 'home') this.showStats();
          else this.showHome();
        } else {
          window.location.hash = nav;
        }
      });
    });
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
          coverNight: e.coverNight || '',
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

  async loadProjects() {
    try {
      const resp = await fetch('/projects/index.json', { cache: 'no-store' });
      if (resp.ok) this.projects = await resp.json();
    } catch (e) { console.error(e); }
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

  // Photos come in a day and an optional night flavor: dark mode prefers the
  // night variant and falls back to the day one until it exists.
  homePhoto() {
    const day = { src: '/static/images/hero/rock.jpg', position: 'center 74%' };
    const night = null; // e.g. { src: '/static/images/hero/rock-night.jpg', position: 'center 74%' }
    return (this.darkMq.matches && night) || day;
  }

  postCover(post) {
    const src = (this.darkMq.matches && post.coverNight) || post.cover;
    return src ? { src, position: post.coverPosition || 'center' } : null;
  }

  // Re-pick the current view's photo (used when the color scheme flips).
  applyViewPhoto() {
    if (this.view === 'thought') {
      const post = this.posts.find(p => p.filename === this.slug);
      const cover = post && this.postCover(post);
      if (cover) this.setBannerPhoto(cover.src, cover.position);
    } else if (this.view === 'home') {
      const photo = this.homePhoto();
      this.setBannerPhoto(photo.src, photo.position);
    }
  }

  // Bar-only views don't pick a photo — the condensed bar keeps showing
  // whatever hero you just came from, so the collapse reads as that photo
  // condensing. The held photo is also what hover previews restore to.
  holdBannerPhoto() {
    if (!this.bannerPhoto) {
      const photo = this.homePhoto();
      this.setBannerPhoto(photo.src, photo.position);
    }
    this.heldPhoto = { ...this.bannerPhoto };
  }

  async showHome() {
    await this.fadeToView('home-view', 'home');
    const photo = this.homePhoto();
    this.setBannerPhoto(photo.src, photo.position);
    this.renderBreadcrumb(null, null);
    this.syncUrl('/');
  }

  async showThoughtsList() {
    await this.fadeToView('thoughts-view', 'thoughts');
    this.holdBannerPhoto();
    this.renderBreadcrumb({ label: 'writing', hash: 'thoughts' }, null);

    const list = document.getElementById('thoughts-full-list');
    list.innerHTML = this.posts.map(post => `
      <a class="thought-row" href="#thought/${post.filename}" data-post="${post.filename}">
        <span class="thought-title">${post.title}</span>
        <span class="thought-date">${this.formatDate(post.date)}</span>
      </a>
    `).join('') || '<p class="empty-note">no thoughts yet.</p>';

    this.preloadImages(this.posts.flatMap(p => [p.cover, p.coverNight]));

    list.querySelectorAll('.thought-row').forEach(item => {
      // Hovering a row fades the bar to that post's cover — and it sticks,
      // so clicking expands the photo already showing. No restore on leave;
      // the bar just keeps the last cover you previewed.
      item.addEventListener('mouseenter', () => {
        const post = this.posts.find(p => p.filename === item.dataset.post);
        const cover = post && this.postCover(post);
        if (cover) this.setBannerPhoto(cover.src, cover.position);
      });
    });

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

    const cover = this.postCover(post);
    if (cover) {
      this.setBannerPhoto(cover.src, cover.position);
    } else {
      this.holdBannerPhoto();
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

  statusPill(status) {
    if (!status) return '';
    const cls = `status-pill status-${String(status).toLowerCase()}`;
    return `<span class="${cls}">${status}</span>`;
  }

  getProjectSlug(project) {
    return project?.slug || project?.name?.toLowerCase().replace(/\s+/g, '-') || '';
  }

  getProjectIndex(slugOrIndex) {
    const parsed = parseInt(slugOrIndex, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < this.projects.length) return parsed;
    const slug = String(slugOrIndex);
    const idx = this.projects.findIndex(p => this.getProjectSlug(p) === slug);
    return idx >= 0 ? idx : -1;
  }

  async showProjectsList() {
    await this.fadeToView('projects-view', 'projects');
    this.holdBannerPhoto();
    this.renderBreadcrumb({ label: 'projects', hash: 'projects' }, null);

    const grid = document.getElementById('projects-full-list');
    grid.innerHTML = this.projects.map(p => `
      <a class="project-card" href="#projects/${this.getProjectSlug(p)}">
        <div class="project-image">
          ${p.image ? `<img src="${p.image}" alt="${p.name}">` : ''}
        </div>
        <div class="project-name">${p.name}</div>
        <div class="project-meta">
          ${this.statusPill(p.status)}
          ${p.year ? `<span>${p.year}</span>` : ''}
        </div>
      </a>
    `).join('') || '<p class="empty-note">no projects yet.</p>';

    this.syncUrl('#projects');
  }

  async showProjectDetail(slugOrIndex) {
    const index = this.getProjectIndex(slugOrIndex);
    const project = index >= 0 ? this.projects[index] : null;
    if (!project) return this.showProjectsList();

    await this.fadeToView('project-view', 'project');
    this.holdBannerPhoto();
    this.renderBreadcrumb({ label: 'projects', hash: 'projects' }, project.name);

    let bodyHtml = '';
    if (project.content) {
      try {
        const resp = await fetch(`/projects/${project.content}`, { cache: 'no-store' });
        if (resp.ok) {
          const raw = await resp.text();
          const { body } = this.parseFrontMatter(raw);
          bodyHtml = typeof marked !== 'undefined' ? marked.parse(body) : body;
        }
      } catch (_) {}
    }

    const isThisWebsite = project.name.toLowerCase() === 'this website';
    const linkHtml = isThisWebsite
      ? '<p class="project-link-row"><a href="#stats">enter the easter egg</a></p>'
      : project.link
        ? `<p class="project-link-row"><a href="${project.link}" target="_blank" rel="noopener">visit ↗</a></p>`
        : '';

    const content = document.getElementById('project-content');
    content.innerHTML = `
      <header class="project-header">
        <h1 class="project-title">${project.name}</h1>
        <div class="project-detail-meta">
          ${this.statusPill(project.status)}
          ${project.year ? `<span>${project.year}</span>` : ''}
          ${project.tech ? `<span>${project.tech}</span>` : ''}
        </div>
      </header>
      ${project.description ? `<p class="project-desc">${project.description}</p>` : ''}
      ${linkHtml}
      ${project.image ? `<figure class="project-shot"><img src="${project.image}" alt="${project.name}"></figure>` : ''}
      ${bodyHtml ? `<div class="article-body">${bodyHtml}</div>` : ''}
      <footer class="article-footer"><a href="#projects">← all projects</a></footer>
    `;

    this.syncScrollLock();

    this.syncUrl(`#projects/${this.getProjectSlug(project)}`);
  }

  // ========================================
  // READING
  // ========================================

  async showReadingList() {
    await this.fadeToView('reading-view', 'reading');
    this.holdBannerPhoto();
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
    this.holdBannerPhoto();
    this.renderBreadcrumb({ label: 'favorites', hash: 'favorites' }, null);

    const container = document.getElementById('solaces-list');
    if (!container) return;

    container.innerHTML = this.solaces.map(category => `
      <div class="solaces-category">
        <div class="solaces-category-title">${category.title}</div>
        <div class="solaces-category-items">
          ${category.items.map(item => {
            if (item.url) {
              return `<span class="solaces-item"><a href="${item.url}" target="_blank" rel="noopener">${item.name}</a></span>`;
            }
            if (item.previewImage) {
              return `<span class="solaces-item"><span class="solaces-item-hero" data-preview-img="${item.previewImage}">${item.name}</span></span>`;
            }
            return `<span class="solaces-item">${item.name}</span>`;
          }).join('')}
        </div>
      </div>
    `).join('') || '<p class="empty-note">nothing here yet.</p>';

    this.preloadImages(this.solaces.flatMap(c => c.items.map(i => i.previewImage)));

    // Clicking a favorite fades its image into the expanded hero, and it
    // stays until another one is picked.
    container.querySelectorAll('.solaces-item-hero').forEach(el => {
      el.addEventListener('click', () => {
        this.setBannerPhoto(el.dataset.previewImg, 'center');
      });
    });

    this.syncUrl('#favorites');
  }

  // ========================================
  // STATS
  // ========================================

  async showStats() {
    await this.fadeToView('youre-already-here-view', 'stats');
    this.holdBannerPhoto();
    this.renderBreadcrumb(null, 'stats');
    this.startAgeCounter();
    this.updateJsLines();
    this.syncUrl('#stats');
  }

  // Counts the renderer plus whatever inline script index.html carries.
  async updateJsLines() {
    const el = document.getElementById('easter-js-lines');
    if (!el) return;
    try {
      const resp = await fetch('/static/markdown-renderer.js', { cache: 'no-store' });
      if (!resp.ok) { el.textContent = '—'; return; }
      const external = (await resp.text()).split('\n').length;
      const inline = Array.from(document.querySelectorAll('script:not([src])'))
        .reduce((n, tag) => n + tag.textContent.trim().split('\n').length, 0);
      el.textContent = String(external + inline);
    } catch (_) {
      el.textContent = '—';
    }
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
    } else if (hash === 'projects') {
      await this.showProjectsList();
    } else if (hash.startsWith('projects/')) {
      await this.showProjectDetail(hash.replace('projects/', ''));
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

  await Promise.all([
    site.loadPosts(),
    site.loadProjects(),
    site.loadReading(),
    site.loadSolaces()
  ]);

  await site.handleRoute();

  document.documentElement.classList.remove('route-pending');
});
