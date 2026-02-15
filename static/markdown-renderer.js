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
    this.setupPanel();
    this.setupNavigation();
    this.setupTimelineReveal();
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

  setupTimelineReveal() {
    const els = document.querySelectorAll('.timeline-label, .timeline-row, .contact-email');
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

  // Panel setup
  setupPanel() {
    const overlay = document.getElementById('panel-overlay');
    const closeBtn = document.getElementById('panel-close');

    overlay?.addEventListener('click', () => this.closePanel());
    closeBtn?.addEventListener('click', () => this.closePanel());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePanel();
    });
  }

  openPanel(content) {
    document.getElementById('panel-content').innerHTML = content;
    document.getElementById('detail-panel').classList.add('open');
    document.getElementById('panel-overlay').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  closePanel() {
    const panel = document.getElementById('detail-panel');
    panel?.classList.remove('open');
    document.getElementById('panel-overlay')?.classList.remove('open');
    document.body.style.overflow = '';
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

    document.querySelectorAll('a[href="#solaces"]').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.showSolacesList();
      });
    });

    // Handle browser back/forward and hash changes
    window.addEventListener('popstate', () => this.handleRoute());
    window.addEventListener('hashchange', () => this.handleRoute());
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
          this.posts.push({
            filename: file.replace('.md', ''),
            title: attributes.title || file.replace('.md', '').replace(/-/g, ' '),
            date: attributes.date || '',
            tags: attributes.tags || [],
            description: attributes.description || '',
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
  }

  async showHome() {
    await this.fadeToView('home-view');
    history.pushState(null, '', '/');
  }

  async showThoughtsList(activeFilter = 'thoughts') {
    await this.fadeToView('thoughts-view');

    // Nav bar filter: thoughts, updates, random (no all, default to thoughts)
    const tagOrder = ['thoughts', 'updates', 'random'];

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

      const activeLink = filters.querySelector(`[data-filter="${activeFilter}"]`) || filters.querySelector('[data-filter="thoughts"]');
      if (activeLink) activeLink.classList.add('active');
      this.filterThoughts(activeFilter);
    } else {
      filters.innerHTML = '';
      this.renderThoughts(this.posts);
    }
    const hash = activeFilter === 'thoughts' ? '#thoughts' : `#thoughts/${activeFilter}`;
    history.pushState(null, '', hash);
  }

  async filterThoughts(filter) {
    const list = document.getElementById('thoughts-full-list');
    list.classList.add('fading');
    await new Promise(r => setTimeout(r, 150));
    
    const filtered = filter === 'all'
      ? this.posts
      : this.posts.filter(p => p.tags?.includes(filter));
    this.renderThoughts(filtered);
    
    list.classList.remove('fading');

    // Update URL so back button returns to this filter
    const hash = filter === 'thoughts' ? '#thoughts' : `#thoughts/${filter}`;
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

  async showThought(postId) {
    const post = this.posts.find(p => p.filename === postId);
    if (!post) return;

    await this.fadeToView('thought-view');

    // Update breadcrumb with post title
    const breadcrumb = document.getElementById('thought-breadcrumb');
    if (breadcrumb) {
      breadcrumb.textContent = post.title.toLowerCase();
    }

    document.getElementById('thought-content').innerHTML = `
      <header class="article-header">
        <h1 class="article-title">${post.title}</h1>
        <div class="article-date">${post.date}</div>
      </header>
      <div class="article-body">${post.content}</div>
    `;

    this.setupPhotoShuffle();

    history.pushState(null, '', `#thought/${postId}`);
  }

  async showProjectsList() {
    await this.fadeToView('projects-view');

    const grid = document.getElementById('projects-full-list');
    grid.innerHTML = this.projects.map((p, i) => `
      <div class="project-card" data-project="${i}"${p.gradient ? ` style="background: ${p.gradient}"` : ''}>
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
        const isMobile = window.matchMedia('(max-width: 640px)').matches;
        if (isMobile) {
          this.showProjectDetail(idx);
        } else {
          this.showProjectItem(this.projects[idx], idx);
        }
      });
    });

    this.applyProjectCardGradients();

    history.pushState(null, '', '#projects');
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

  showProjectItem(project, index) {
    const projectIdx = index ?? this.projects.findIndex(p => p.name === project.name);
    const imageHtml = project.image
      ? `<div class="panel-image"><img src="${project.image}" alt="${project.name}"></div>`
      : '';
    this.openPanel(`
      <div class="panel-layout">
        <div class="panel-main">
          <div class="panel-top-row">
            <div class="panel-top-content">
              <div class="panel-title">${project.name}</div>
              <div class="panel-author">${project.tech || ''}</div>
              <div class="panel-section">
                <div class="panel-label">description</div>
                <div class="panel-notes">${project.description || '<span class="panel-empty">no description.</span>'}</div>
              </div>
              <div class="panel-section">
                <a href="#projects/${projectIdx}" class="panel-expand-link" data-project-expand="${projectIdx}">view full page →</a>
              </div>
            </div>
            ${imageHtml}
          </div>
          <div class="panel-meta">
            <div class="panel-meta-item">
              <div class="panel-meta-label">year</div>
              <div class="panel-meta-value">${project.year || '—'}</div>
            </div>
            <div class="panel-meta-item">
              <div class="panel-meta-label">status</div>
              <div class="panel-meta-value">${project.status || '—'}</div>
            </div>
            <div class="panel-meta-item">
              <div class="panel-meta-label">link</div>
              <div class="panel-meta-value">${project.link ? `<a href="${project.link}" target="_blank" class="panel-link">view →</a>` : '—'}</div>
            </div>
          </div>
        </div>
      </div>
    `);
    // Delegate click for expand link (content is dynamically added)
    document.getElementById('panel-content').querySelector('[data-project-expand]')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.closePanel();
      this.showProjectDetail(parseInt(e.currentTarget.dataset.projectExpand));
    });
  }

  async showProjectDetail(index) {
    const project = this.projects[index];
    if (!project) return this.showProjectsList();

    await this.fadeToView('project-view');

    const breadcrumb = document.getElementById('project-breadcrumb');
    if (breadcrumb) breadcrumb.textContent = project.name;

    const content = document.getElementById('project-content');
    content.innerHTML = `
      <header class="article-header">
        <h1 class="article-title">${project.name}</h1>
        <div class="article-date">${project.tech || ''} · ${project.year || ''}</div>
      </header>
      <div class="article-body">
        <p>${project.description || 'No description.'}</p>
        ${project.link ? `<p><a href="${project.link}" target="_blank">view project →</a></p>` : ''}
      </div>
    `;

    history.pushState(null, '', `#projects/${index}`);
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

  async showSolacesList() {
    await this.fadeToView('solaces-view');
    
    const container = document.getElementById('solaces-list');
    if (!container) return;

    container.innerHTML = this.solaces.map(category => `
      <div class="solaces-category">
        <div class="solaces-category-title">${category.title}</div>
        <div class="solaces-category-items">
          ${category.items.map(item => `
            <div class="solaces-item">
              ${item.url ? `<a href="${item.url}" target="_blank">${item.name}</a>` : item.name}
            </div>
          `).join('')}
          ${category.more ? `<div class="solaces-item solaces-more"><a href="${category.more.url}">${category.more.text}</a></div>` : ''}
        </div>
      </div>
    `).join('') || '<p style="color:var(--fg-muted);">nothing here yet.</p>';

    history.pushState(null, '', '#solaces');
  }

  // Routing
  async handleRoute() {
    const hash = window.location.hash.replace('#', '');
    if (!hash || hash === '/') {
      await this.fadeToView('home-view');
    } else if (hash === 'thoughts' || hash.startsWith('thoughts/')) {
      const tagOrder = ['thoughts', 'updates', 'random'];
      const filter = hash === 'thoughts' ? 'thoughts' : hash.replace('thoughts/', '');
      const validFilter = tagOrder.includes(filter) ? filter : 'thoughts';
      await this.showThoughtsList(validFilter);
    } else if (hash === 'reading') {
      await this.showReadingList();
    } else if (hash === 'projects') {
      await this.showProjectsList();
    } else if (hash.startsWith('projects/')) {
      const idx = parseInt(hash.replace('projects/', ''), 10);
      if (!isNaN(idx)) await this.showProjectDetail(idx);
      else await this.showProjectsList();
    } else if (hash === 'solaces') {
      await this.showSolacesList();
    } else if (hash.startsWith('thought/')) {
      await this.showThought(hash.replace('thought/', ''));
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
