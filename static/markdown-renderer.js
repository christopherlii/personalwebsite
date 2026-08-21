// ========================================
// SITE RENDERER
// ========================================

class Site {
  constructor() {
    this.posts = [];
    this.projects = [];
    this.reading = [];
    this.solaces = [];
    this.init();
  }

  // Initialize
  init() {
    this.setupNavigation();
    this.setupContactReveal();
    this.setupBanners();
  }

  // ========================================
  // COLLAPSING BANNER (home + article)
  // ========================================

  setupBanners() {
    const styles = getComputedStyle(document.documentElement);
    this.bannerFull = parseInt(styles.getPropertyValue('--banner-height'), 10) || 380;
    this.bannerBar = parseInt(styles.getPropertyValue('--banner-bar'), 10) || 64;

    this.updateBanners = () => {
      const full = this.bannerFull;
      const bar = this.bannerBar;
      const h = Math.max(bar, full - window.scrollY);

      document.querySelectorAll('.view:not(.hidden) > .banner').forEach(banner => {
        const sib = banner.nextElementSibling;
        const spacer = sib && sib.classList.contains('banner-spacer') ? sib : null;
        if (banner.classList.contains('banner--bare')) {
          if (spacer) spacer.style.height = '0px';
          return;
        }

        banner.style.height = `${h}px`;
        if (spacer) spacer.style.height = `${full - h}px`;
      });
    };

    // Re-read the token on resize — it drops to 300px on narrow screens.
    this.onBannerResize = () => {
      const s = getComputedStyle(document.documentElement);
      this.bannerFull = parseInt(s.getPropertyValue('--banner-height'), 10) || 380;
      this.updateBanners();
    };

    window.addEventListener('scroll', this.updateBanners, { passive: true });
    window.addEventListener('resize', this.onBannerResize);
    this.updateBanners();
  }

  setPostCover(post) {
    const banner = document.querySelector('#thought-view > .banner');
    const media = document.getElementById('thought-cover');
    if (!banner || !media) return;

    if (post && post.cover) {
      banner.classList.remove('banner--bare');
      media.style.backgroundImage = `url('${post.cover}')`;
      media.style.backgroundPosition = post.coverPosition || 'center';
    } else {
      banner.classList.add('banner--bare');
      media.style.backgroundImage = '';
    }
    this.updateBanners();
  }

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

  setupContactReveal() {
    const els = document.querySelectorAll('.contact-email');
    if (!els.length) return;
    const prevIntersecting = new Map();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        const prev = prevIntersecting.get(e.target);
        prevIntersecting.set(e.target, e.isIntersecting);
        if (prev === false && e.isIntersecting) e.target.classList.add('reveal');
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -20px 0px' });
    els.forEach((el) => observer.observe(el));
    setTimeout(() => {
      els.forEach((el) => {
        if (!el.classList.contains('reveal') && prevIntersecting.get(el)) {
          el.classList.add('reveal');
        }
      });
    }, 300);
  }

  // Navigation setup
  setupNavigation() {
    // Home links (logo and breadcrumb)
    document.querySelectorAll('a[href="/"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.showHome();
      });
    });

    // Section links
    document.querySelectorAll('a[href="#thoughts"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.showThoughtsList();
      });
    });

    document.querySelectorAll('a[href="#projects"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.showProjectsList();
      });
    });

    document.querySelectorAll('a[href="#reading"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.showReadingList();
      });
    });

    document.querySelectorAll('a[href="#favorites"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.showSolacesList();
      });
    });

    // Handle browser back/forward and hash changes
    window.addEventListener('popstate', () => {
      this._fromPopstate = true;
      this.handleRoute();
    });
    window.addEventListener('hashchange', () => {
      this._fromPopstate = false;
      this.handleRoute();
    });
  }

  formatArticleDate(dateStr) {
    if (!dateStr) return '';
    const m = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return dateStr;
    const [, year, month, day] = m;
    return `${parseInt(month, 10)}.${parseInt(day, 10)}.${year}`;
  }

  // Data loading
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

  async loadPosts() {
    try {
      let mdFiles = [];
      try {
        const resp = await fetch('/posts/index.json', { cache: 'no-store' });
        if (resp.ok) mdFiles = (await resp.json()).filter(f => f.endsWith('.md'));
      } catch (_) {}

      if (!mdFiles.length) {
        const resp = await fetch('/posts/');
        const text = await resp.text();
        mdFiles = text.match(/href="([^"]*\.md)"/g)?.map(m => m.slice(6, -1)) || [];
      }

      for (const file of mdFiles) {
        try {
          const resp = await fetch(`/posts/${file}`);
          const content = await resp.text();
          const { attributes, body } = this.parseFrontMatter(content);
          if (String(attributes.published).toLowerCase() === 'false') continue;
          this.posts.push({
            filename: file.replace('.md', ''),
            title: attributes.title || file.replace('.md', '').replace(/-/g, ' '),
            date: attributes.date || '',
            tags: attributes.tags || [],
            description: attributes.description || '',
            cover: attributes.cover || '',
            coverPosition: attributes.coverPosition || '',
            content: typeof marked !== 'undefined' ? marked.parse(body) : body
          });
        } catch (e) { console.error(e); }
      }
      // Sort by date, most recent first
      this.posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    } catch (e) { console.error(e); }
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



  // View management with fade transitions
  async fadeToView(viewId) {
    const currentView = document.querySelector('.view:not(.hidden)');
    const targetView = document.getElementById(viewId);
    
    if (currentView && currentView.id === 'youre-already-here-view') {
      this.stopEasterEggAge();
    }
    
    if (currentView && currentView !== targetView) {
      currentView.classList.add('fade-out');
      await new Promise(resolve => setTimeout(resolve, 150));
      currentView.classList.add('hidden');
      currentView.classList.remove('fade-out');
    }
    
    if (targetView) {
      targetView.classList.add('fade-out');
      targetView.classList.remove('hidden');
      targetView.offsetHeight; // Force reflow
      targetView.classList.remove('fade-out');
    }
    
    window.scrollTo(0, 0);
    if (this.updateBanners) this.updateBanners();
  }

  async showHome() {
    await this.fadeToView('home-view');
    history.pushState(null, '', '/');
  }

  async showThoughtsList(activeFilter = 'updates') {
    await this.fadeToView('thoughts-view');

    // Nav bar filter: updates, random
    const tagOrder = ['updates', 'random'];

    // Render simple text filters
    const filters = document.getElementById('thoughts-filters');
    if (tagOrder.length > 0) {
      filters.innerHTML = tagOrder.map(tag => `<span class="filter-link" data-filter="${tag}">${tag}</span>`).join('');

      filters.querySelectorAll('.filter-link').forEach(link => {
        link.addEventListener('click', () => {
          filters.querySelectorAll('.filter-link').forEach(l => l.classList.remove('active'));
          link.classList.add('active');
          this.filterThoughts(link.dataset.filter);
        });
      });

      const activeLink = filters.querySelector(`[data-filter="${activeFilter}"]`) || filters.querySelector('[data-filter="updates"]');
      if (activeLink) activeLink.classList.add('active');
      this.filterThoughts(activeFilter);
    } else {
      filters.innerHTML = '';
      this.renderThoughts(this.posts);
    }
    const hash = activeFilter === 'updates' ? '#thoughts' : `#thoughts/${activeFilter}`;
    history.pushState(null, '', hash);
  }

  async filterThoughts(filter) {
    const list = document.getElementById('thoughts-full-list');
    list.classList.add('fading');
    await new Promise(r => setTimeout(r, 150));
    
    const filtered = this.posts.filter(p => p.tags?.includes(filter));
    this.renderThoughts(filtered);
    
    list.classList.remove('fading');

    // Update URL so back button returns to this filter
    const hash = filter === 'updates' ? '#thoughts' : `#thoughts/${filter}`;
    history.replaceState(null, '', hash);
  }

  renderThoughts(posts) {
    const list = document.getElementById('thoughts-full-list');
    list.innerHTML = posts.map(post => `
      <div class="thought-row" data-post="${post.filename}">
        <span class="thought-title">${post.title}</span>
        <span class="thought-date">${post.date || ''}</span>
      </div>
    `).join('') || '<p style="color:var(--fg-muted);font-size:14px;">no thoughts yet.</p>';

    list.querySelectorAll('.thought-row').forEach(item => {
      item.addEventListener('click', () => this.showThought(item.dataset.post));
    });
  }

  async showThought(postId, skipHistoryPush) {
    const post = this.posts.find(p => p.filename === postId);
    if (!post) return;

    await this.fadeToView('thought-view');

    // Update breadcrumb with post title
    const breadcrumb = document.getElementById('thought-breadcrumb');
    if (breadcrumb) {
      breadcrumb.textContent = post.title.toLowerCase();
    }

    const descriptionHtml = post.description && typeof marked !== 'undefined'
      ? marked.parse(post.description) : (post.description || '');
    const formattedDate = this.formatArticleDate(post.date);
    document.getElementById('thought-content').innerHTML = `
      <header class="article-header">
        <h1 class="article-title">${post.title}</h1>
        ${descriptionHtml ? `<div class="article-description">${descriptionHtml}</div>` : ''}
      </header>
      <div class="article-body">${post.content}</div>
      ${formattedDate ? `<footer class="article-footer"><time class="article-date">${formattedDate}</time></footer>` : ''}
    `;

    this.setPostCover(post);
    this.enhanceArticleImages(document.getElementById('thought-content'));
    this.setupPhotoShuffle();

    if (!skipHistoryPush) {
      history.pushState(null, '', `#thought/${postId}`);
    }
  }

  async showProjectsList() {
    await this.fadeToView('projects-view');

    const grid = document.getElementById('projects-full-list');
    grid.innerHTML = this.projects.map((p, i) => `
      <div class="project-card" data-project="${i}" data-slug="${p.slug || p.name.toLowerCase().replace(/\s+/g, '-')}"${p.gradient ? ` style="background: ${p.gradient}"` : ''}>
        <div class="project-image">
          ${p.image
            ? `<img src="${p.image}" alt="${p.name}">`
            : `<div class="project-image-placeholder">
                <div class="project-cubes">
                  ${Array(6).fill('<div class="project-cube"></div>').join('')}
                </div>
              </div>`
          }
        </div>
        <div class="project-name">${p.name}</div>
        ${p.description ? `<div class="project-desc">${p.description}</div>` : ''}
        <div class="project-meta">
          ${p.tech ? `<span class="project-tech">${p.tech}</span>` : ''}
          ${p.year ? `<span class="project-status">${p.year}</span>` : ''}
        </div>
      </div>
    `).join('') || '<p style="color:var(--fg-muted);font-size:14px;">no projects yet.</p>';

    grid.querySelectorAll('.project-card').forEach(card => {
      card.addEventListener('click', () => {
        const idx = parseInt(card.dataset.project);
        this.showProjectDetail(idx);
      });
    });

    this.applyProjectCardGradients();

    history.pushState(null, '', '#projects');
  }

  getProjectSlug(project) {
    return project?.slug || project?.name?.toLowerCase().replace(/\s+/g, '-') || '';
  }

  getProjectIndex(slugOrIndex) {
    const parsed = parseInt(slugOrIndex, 10);
    if (!isNaN(parsed) && parsed >= 0 && parsed < this.projects.length) return parsed;
    const slug = String(slugOrIndex);
    const idx = this.projects.findIndex(p => (p.slug || p.name.toLowerCase().replace(/\s+/g, '-')) === slug);
    return idx >= 0 ? idx : -1;
  }

  applyProjectCardGradients() {
    document.querySelectorAll('.project-card .project-image img').forEach(img => {
      const card = img.closest('.project-card');
      if (card.style.background) return;
      const applyGradient = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          const w = Math.min(img.naturalWidth, 60);
          const h = Math.min(img.naturalHeight, 60);
          if (!w || !h) return;
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h).data;

          const sample = (x, y) => {
            const i = (Math.floor(y) * w + Math.floor(x)) * 4;
            return [data[i], data[i + 1], data[i + 2]];
          };
          const topLeft = sample(0, 0);
          const topRight = sample(w - 1, 0);
          const bottom = sample(w / 2, h - 1);

          const soften = (rgb) => rgb.map((c) => Math.round(c * 0.35 + 255 * 0.65));
          const c1 = soften(topLeft);
          const c2 = soften(topRight);
          const c3 = soften(bottom);

          card.style.background = `linear-gradient(180deg, rgb(${c1.join(',')}) 0%, rgb(${c2.join(',')}) 45%, rgb(${c3.join(',')}) 100%)`;
        } catch (_) {}
      };

      if (img.complete && img.naturalWidth) {
        applyGradient();
      } else {
        img.addEventListener('load', applyGradient);
      }
    });
  }

  async showYoureAlreadyHere() {
    await this.fadeToView('youre-already-here-view');
    history.pushState(null, '', '#youre-already-here');
    this.startEasterEggAge();
    this.updateEasterEggJsLines();
    this.updateQueensStreak();
  }

  updateQueensStreak() {
    const el = document.getElementById('easter-queens-streak');
    if (!el) return;
    const baseDate = new Date('2026-02-15');
    const baseValue = 211;
    const now = new Date();
    const diffDays = Math.floor((now - baseDate) / (24 * 60 * 60 * 1000));
    el.textContent = String(Math.max(0, baseValue + diffDays));
  }

  async updateEasterEggJsLines() {
    const el = document.getElementById('easter-js-lines');
    if (!el) return;
    try {
      const mainRes = await fetch('/static/markdown-renderer.js', { cache: 'no-store' });
      if (mainRes.ok) {
        const mainJs = await mainRes.text();
        const mainLines = mainJs.split('\n').length;
        const inlineLines = 4; // route-pending script in index.html
        el.textContent = String(mainLines + inlineLines);
      } else {
        el.textContent = '—';
      }
    } catch {
      el.textContent = '—';
    }
  }

  startEasterEggAge() {
    const el = document.getElementById('easter-age');
    if (!el) return;
    const birth = new Date('2004-06-10T08:00:00');
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const setAge = () => {
      const now = new Date();
      const ageYears = (now - birth) / msPerYear;
      el.textContent = ageYears.toFixed(14);
    };
    setAge(); // Set immediately
    const update = () => {
      setAge();
      this._easterAgeFrame = requestAnimationFrame(update);
    };
    this._easterAgeFrame = requestAnimationFrame(update);
  }

  stopEasterEggAge() {
    if (this._easterAgeFrame) {
      cancelAnimationFrame(this._easterAgeFrame);
      this._easterAgeFrame = null;
    }
  }

  renderWorkDetail(work, options = {}) {
    const { isVibecode = false, linkLabel = 'view project' } = options;
    const statusHtml = work.status
      ? `<span class="work-status work-status-${(work.status || '').toLowerCase()}">${work.status}</span>`
      : '';
    const meta = isVibecode
      ? `${work.tech || ''} · ${work.date || ''}`.replace(/^ · | · $/g, '').trim()
      : `${work.tech || ''}`.trim();
    const primaryLink = work.name.toLowerCase() === 'this website'
      ? { href: '#youre-already-here', label: 'enter the easter egg' }
      : work.link
        ? { href: work.link, label: `${linkLabel} →`, external: true }
        : null;
    const imageHtml = work.image
      ? `<div class="project-doc-hero">
          <img src="${work.image}" alt="${work.name}">
          ${statusHtml ? `<div class="project-doc-hero-status">${statusHtml}</div>` : ''}
        </div>`
      : '';
    let html = `
      <div class="project-detail-page">
        ${imageHtml}
        <header class="project-doc-header project-detail-header">
          <h1 class="project-doc-title">${work.name}</h1>
          ${meta ? `<p class="project-detail-tech">${meta}</p>` : ''}
        </header>
        <div class="project-detail-content article-body">
          <p class="work-description">${work.description || 'No description.'}</p>
          ${primaryLink ? `<p class="project-detail-link-row"><a href="${primaryLink.href}" class="project-detail-link"${primaryLink.external ? ' target="_blank"' : ''}>${primaryLink.label}</a></p>` : ''}
    `;
    if (work.thoughtProcess) {
      html += `<section class="work-section"><h2 class="work-section-title">thought process</h2><div class="work-section-body">${work.thoughtProcess}</div></section>`;
    }
    if (work.prd) {
      const prdContent = work.prd.startsWith('http') ? `<a href="${work.prd}" target="_blank">view PRD →</a>` : `<div class="work-section-body">${work.prd}</div>`;
      html += `<section class="work-section"><h2 class="work-section-title">PRD</h2>${prdContent}</section>`;
    }
    if (work.howBuilt) {
      html += `<section class="work-section"><h2 class="work-section-title">how i built it</h2><div class="work-section-body">${work.howBuilt}</div></section>`;
    }
    if (work.stills && work.stills.length > 0) {
      html += `<section class="work-section"><h2 class="work-section-title">stills</h2><div class="work-stills">${work.stills.map(src => `<figure><img src="${src}" alt=""></figure>`).join('')}</div></section>`;
    }
    html += '</div></div>';
    return html;
  }

  async showProjectDetail(slugOrIndex) {
    const index = this.getProjectIndex(slugOrIndex);
    const project = index >= 0 ? this.projects[index] : null;
    if (!project) return this.showProjectsList();

    await this.fadeToView('project-view');

    const breadcrumb = document.getElementById('project-breadcrumb');
    if (breadcrumb) breadcrumb.textContent = project.name;

    const content = document.getElementById('project-content');

    if (project.content) {
      try {
        const resp = await fetch(`/projects/${project.content}`, { cache: 'no-store' });
        if (resp.ok) {
          const raw = await resp.text();
          const { body } = this.parseFrontMatter(raw);
          const htmlBody = typeof marked !== 'undefined' ? marked.parse(body) : body;
          content.innerHTML = this.renderProjectDoc(project, htmlBody);
          this.setupProjectDocSidebar(content);
        } else {
          content.innerHTML = this.renderWorkDetail(project, { linkLabel: 'view project' });
        }
      } catch (_) {
        content.innerHTML = this.renderWorkDetail(project, { linkLabel: 'view project' });
      }
    } else {
      content.innerHTML = this.renderWorkDetail(project, { linkLabel: 'view project' });
    }

    const slug = this.getProjectSlug(project);
    history.pushState(null, '', `#projects/${slug}`);
  }

  renderProjectDoc(project, htmlBody) {
    const statusHtml = project.status
      ? `<span class="work-status work-status-${(project.status || '').toLowerCase()}">${project.status}</span>`
      : '';

    const headings = [];
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlBody;
    tempDiv.querySelectorAll('h2, h3').forEach(h => {
      const id = h.id || h.textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      if (!h.id) h.id = id;
      headings.push({ level: h.tagName === 'H2' ? 2 : 3, id, text: h.textContent });
    });
    const updatedBody = tempDiv.innerHTML;

    const sidebarHtml = headings.length > 0 ? `
      <nav class="project-doc-sidebar">
        ${headings.map(h => `<a href="#${h.id}" class="project-doc-sidebar-link${h.level === 3 ? ' indent' : ''}" data-target="${h.id}">${h.text}</a>`).join('')}
        ${project.link ? `<div class="project-doc-sidebar-divider"></div><a href="${project.link}" target="_blank" class="project-doc-sidebar-link external">github ↗</a>` : ''}
      </nav>
    ` : '';

    const imageHtml = project.image
      ? `<div class="project-doc-hero">
          <img src="${project.image}" alt="${project.name}">
          ${statusHtml ? `<div class="project-doc-hero-status">${statusHtml}</div>` : ''}
        </div>`
      : '';

    return `
      <div class="project-doc">
        ${imageHtml}
        <div class="project-doc-header">
          <h1 class="project-doc-title">${project.name}</h1>
        </div>
        <div class="project-doc-layout">
          ${sidebarHtml}
          <div class="project-doc-content article-body">
            ${updatedBody}
          </div>
        </div>
      </div>
    `;
  }

  setupProjectDocSidebar(container) {
    const sidebar = container.querySelector('.project-doc-sidebar');
    if (!sidebar) return;

    const links = sidebar.querySelectorAll('.project-doc-sidebar-link[data-target]');
    const sections = [];
    links.forEach(link => {
      const target = container.querySelector(`#${link.dataset.target}`);
      if (target) sections.push({ link, target });
    });

    // Click to scroll
    links.forEach(link => {
      link.addEventListener('click', (e) => {
        if (link.classList.contains('external')) return;
        e.preventDefault();
        const target = container.querySelector(`#${link.dataset.target}`);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });

    // Highlight active section on scroll
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          links.forEach(l => l.classList.remove('active'));
          const active = sidebar.querySelector(`[data-target="${entry.target.id}"]`);
          if (active) active.classList.add('active');
        }
      });
    }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });

    sections.forEach(s => observer.observe(s.target));
  }

  async showReadingList() {
    await this.fadeToView('reading-view');
    
    const list = document.getElementById('reading-list');
    list.innerHTML = this.reading.map(item => `
      <div class="reading-item">
        <div class="reading-item-title">
          ${item.url ? `<a href="${item.url}" target="_blank">${item.title}</a>` : item.title}
        </div>
        ${item.author ? `<div class="reading-item-author">${item.author}</div>` : ''}
      </div>
    `).join('') || '<p style="color:var(--fg-muted);font-size:14px;">no readings yet.</p>';

    history.pushState(null, '', '#reading');
  }

  setupSolacePreviews() {
    if ('ontouchstart' in window) return;
    const wrappers = document.querySelectorAll('.solaces-item-wrapper');
    let previewEl = document.getElementById('solace-preview');
    if (!previewEl) {
      previewEl = document.createElement('div');
      previewEl.id = 'solace-preview';
      previewEl.className = 'solace-preview';
      previewEl.innerHTML = '<img src="" alt="" />';
      previewEl.style.pointerEvents = 'none';
      document.body.appendChild(previewEl);
    }
    const img = previewEl.querySelector('img');

    const gapBelow = 8;
    const previewWidth = 240;
    const previewHeight = 160;
    const lerpFactor = 0.12;
    let targetLeft = 0;
    let targetTop = 0;
    let currentLeft = 0;
    let currentTop = 0;
    let rafId = null;

    const horizontalDampen = 0.25;

    const updatePosition = (wrapper, clientX) => {
      const rect = wrapper.getBoundingClientRect();
      const linkCenterX = rect.left + rect.width / 2;
      const targetCenterX = linkCenterX + (clientX - linkCenterX) * horizontalDampen;
      let left = targetCenterX - previewWidth / 2;
      if (left + previewWidth > window.innerWidth) left = window.innerWidth - previewWidth;
      if (left < 0) left = 0;
      const top = rect.bottom + gapBelow;
      if (top + previewHeight > window.innerHeight) {
        targetTop = Math.max(0, rect.top - previewHeight - gapBelow);
      } else {
        targetTop = top;
      }
      targetLeft = left;
    };

    const animate = () => {
      currentLeft += (targetLeft - currentLeft) * lerpFactor;
      currentTop += (targetTop - currentTop) * lerpFactor;
      previewEl.style.left = `${currentLeft}px`;
      previewEl.style.top = `${currentTop}px`;
      if (previewEl.classList.contains('visible')) {
        rafId = requestAnimationFrame(animate);
      }
    };

    wrappers.forEach(wrapper => {
      wrapper.addEventListener('mouseenter', (e) => {
        const src = wrapper.dataset.previewImg;
        if (src) {
          img.src = src;
          img.alt = '';
          const rect = wrapper.getBoundingClientRect();
          const linkCenterX = rect.left + rect.width / 2;
          const targetCenterX = linkCenterX + (e.clientX - linkCenterX) * horizontalDampen;
          const top = rect.bottom + gapBelow;
          let left = targetCenterX - previewWidth / 2;
          if (left + previewWidth > window.innerWidth) left = window.innerWidth - previewWidth;
          if (left < 0) left = 0;
          targetLeft = left;
          targetTop = top + previewHeight > window.innerHeight
            ? Math.max(0, rect.top - previewHeight - gapBelow)
            : top;
          currentLeft = targetLeft;
          currentTop = targetTop;
          previewEl.style.left = `${currentLeft}px`;
          previewEl.style.top = `${currentTop}px`;
          previewEl.classList.add('visible');
          if (!rafId) rafId = requestAnimationFrame(animate);
        }
      });
      wrapper.addEventListener('mousemove', (e) => {
        if (previewEl.classList.contains('visible')) {
          updatePosition(wrapper, e.clientX);
        }
      });
      wrapper.addEventListener('mouseleave', () => {
        previewEl.classList.remove('visible');
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
      });
    });
  }

  async showSolacesList() {
    await this.fadeToView('solaces-view');
    
    const container = document.getElementById('solaces-list');
    if (!container) return;

    const placeholderImg = '/static/images/blogs/2025_q4/apt_view.jpg';
    container.innerHTML = this.solaces.map(category => `
      <div class="solaces-category">
        <div class="solaces-category-title">${category.title}</div>
        <div class="solaces-category-items">
          ${category.items.map(item => {
            const hasPreview = (category.title === 'films' || category.title === 'sports') && item.previewImage;
            const previewImg = item.previewImage || placeholderImg;
            if (hasPreview) {
              return `
            <div class="solaces-item">
              <span class="solaces-item-wrapper" data-preview-img="${previewImg}">${item.name}</span>
            </div>`;
            }
            return `
            <div class="solaces-item">
              ${item.url ? `<a href="${item.url}" target="_blank">${item.name}</a>` : item.name}
            </div>`;
          }).join('')}
          ${category.more ? `<div class="solaces-item solaces-more"><a href="${category.more.url}">${category.more.text}</a></div>` : ''}
        </div>
      </div>
    `).join('') || '<p style="color:var(--fg-muted);">nothing here yet.</p>';

    this.setupSolacePreviews();

    history.pushState(null, '', '#favorites');
  }

  // Routing
  async handleRoute() {
    const hash = window.location.hash.replace('#', '');
    if (!hash || hash === '/') {
      await this.fadeToView('home-view');
    } else if (hash === 'thoughts' || hash.startsWith('thoughts/')) {
      const tagOrder = ['updates', 'random'];
      const filter = hash === 'thoughts' ? 'updates' : hash.replace('thoughts/', '');
      const validFilter = tagOrder.includes(filter) ? filter : 'updates';
      await this.showThoughtsList(validFilter);
    } else if (hash === 'reading') {
      await this.showReadingList();
    } else if (hash === 'projects') {
      await this.showProjectsList();
    } else if (hash.startsWith('projects/')) {
      const slugOrIndex = hash.replace('projects/', '');
      await this.showProjectDetail(slugOrIndex);
    } else if (hash === 'favorites' || hash === 'solaces') {
      await this.showSolacesList();
    } else if (hash === 'youre-already-here') {
      await this.showYoureAlreadyHere();
    } else if (hash.startsWith('thought/')) {
      const postId = hash.replace('thought/', '');
      // When not from back/forward, inject thoughts list so browser back goes to writing list
      if (!this._fromPopstate) {
        history.replaceState(null, '', '#thoughts');
        history.pushState(null, '', `#thought/${postId}`);
      }
      await this.showThought(postId, true); // skip push - we injected or history already correct
    } else {
      await this.fadeToView('home-view');
    }
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

  // Show content after routing (prevents flash of home when reloading with hash)
  document.documentElement.classList.remove('route-pending');
});
