// Client-side markdown renderer
class MarkdownRenderer {
  constructor() {
    this.posts = [];
    this.currentPost = null;
    this.currentPage = 'home';
  }

  // Parse front matter from markdown content
  parseFrontMatter(content) {
    const frontMatterRegex = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;
    const match = content.match(frontMatterRegex);
    
    if (!match) {
      return {
        attributes: {},
        body: content
      };
    }

    const frontMatter = match[1];
    const body = match[2];

    // Parse YAML-like front matter
    const attributes = {};
    frontMatter.split('\n').forEach(line => {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        let value = line.substring(colonIndex + 1).trim();
        
        // Remove quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) || 
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        
        // Parse arrays
        if (value.startsWith('[') && value.endsWith(']')) {
          value = value.slice(1, -1).split(',').map(item => 
            item.trim().replace(/"/g, '').replace(/'/g, '')
          );
        }
        
        attributes[key] = value;
      }
    });

    return { attributes, body };
  }

  // Markdown to HTML using the marked library
  markdownToHtml(markdown) {
    if (typeof marked !== 'undefined') {
      return marked.parse(markdown);
    }
    return markdown;
  }

  // Load all markdown posts
  async loadPosts() {
    try {
      // Prefer a static index for production (GitHub Pages blocks dir listing)
      let mdFiles = [];
      try {
        const indexResp = await fetch('/posts/index.json', { cache: 'no-store' });
        if (indexResp.ok) {
          const index = await indexResp.json();
          if (Array.isArray(index)) {
            mdFiles = index.filter(name => typeof name === 'string' && name.endsWith('.md'));
          }
        }
      } catch (_) {}

      // Fallback to directory listing if index.json not available (local dev)
      if (mdFiles.length === 0) {
        const response = await fetch('/posts/');
        const text = await response.text();
        mdFiles = text.match(/href="([^"]*\.md)"/g)?.map(match => 
          match.replace('href="', '').replace('"', '')
        ) || [];
      }
      
      this.posts = [];
      
      for (const filename of mdFiles) {
        try {
          const postResponse = await fetch(`/posts/${filename}`);
          const content = await postResponse.text();
          
          const { attributes, body } = this.parseFrontMatter(content);
          const htmlContent = this.markdownToHtml(body);
          
          this.posts.push({
            filename: filename.replace('.md', ''),
            title: attributes.title || filename.replace('.md', '').replace(/-/g, ' '),
            date: attributes.date || new Date().toLocaleDateString('en-US', {
              month: 'numeric',
              day: 'numeric',
              year: 'numeric'
            }),
            tags: attributes.tags || [],
            description: attributes.description || '',
            content: htmlContent
          });
        } catch (error) {
          console.error(`Error loading ${filename}:`, error);
        }
      }

      return this.posts;
    } catch (error) {
      console.error('Error loading posts:', error);
      return [];
    }
  }


  // Add click handlers for post links
  addPostClickHandlers(container) {
    const scope = container || document;
    const postLinks = scope.querySelectorAll('.writing-entry[data-post]');
    postLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const postId = link.getAttribute('data-post');
        this.showPost(postId);
      });
    });
  }

  // Show a specific post
  showPost(postId) {
    const post = this.posts.find(p => p.filename === postId);
    if (!post) return;

    this.currentPost = post;
    this.currentPage = 'post';

    // Hide all existing pages
    this.hideAllPages();

    // Create post HTML with proper container structure
    const postHTML = `
      <div class="post-content">
        <h1>${post.title}</h1>
        <div class="date">${post.date}</div>
        <div class="content">
          ${post.content}
        </div>
        <a href="#" class="return-button" id="return-to-writing">← Back to writing</a>
      </div>
    `;

    // Create a new page div for the post
    const postPage = document.createElement('div');
    postPage.id = 'post-page';
    postPage.className = 'page-section';
    postPage.innerHTML = postHTML;
    document.querySelector('.main-content').appendChild(postPage);

    // Add return button handler
    document.getElementById('return-to-writing').addEventListener('click', (e) => {
      e.preventDefault();
      this.showWriting();
      // Update URL to show writing in the URL bar
      history.pushState(null, '', '/#writing');
    });

    // Update navigation
    this.updateNavigation('writing');

    // Update URL to show the specific post
    history.pushState(null, '', `/#post/${postId}`);
  }

  // Show writing list
  showWriting() {
    this.currentPage = 'writing';

    // Hide all existing pages
    this.hideAllPages();

    // Remove any existing dynamic writing page to avoid duplicate handlers
    const existing = document.getElementById('writing-page-dynamic');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    // Create writing page with proper container structure
    const writingHTML = `
      <div class="filter-container">
        <div class="filter-pills">
          <div class="filter-pill" data-filter="thoughts">
            <div class="filter-indicator"></div>
            <span>Thoughts</span>
          </div>
          <div class="filter-pill" data-filter="volumes">
            <div class="filter-indicator"></div>
            <span>Volumes</span>
          </div>
          <div class="filter-pill" data-filter="random">
            <div class="filter-indicator"></div>
            <span>Random</span>
          </div>
        </div>
      </div>

      <div class="writing-list">
        ${this.posts.map(post => {
          const tagsString = post.tags.join(',');
          return `<a href="#" class="writing-entry" data-tags="${tagsString}" data-post="${post.filename}">
            <h3>${post.title}</h3>
            <div class="date">${post.date}</div>
            <p>${post.description}</p>
          </a>`;
        }).join('')}
      </div>

      <div class="no-results hidden">
        <p>No posts match the selected filters.</p>
      </div>
    `;

    // Create a new writing page div
    const writingPage = document.createElement('div');
    writingPage.id = 'writing-page-dynamic';
    writingPage.className = 'page-section';
    writingPage.innerHTML = writingHTML;
    document.querySelector('.main-content').appendChild(writingPage);

    // Reinitialize writing functionality
    this.initializeWriting(writingPage);
    this.addPostClickHandlers(writingPage);

    // Update navigation
    this.updateNavigation('writing');
  }

  // Hide all pages
  hideAllPages() {
    const pages = document.querySelectorAll('[id$="-page"], [id$="-page-dynamic"]');
    pages.forEach(page => {
      page.classList.add('hidden');
    });
  }

  // Show about page
  showAbout() {
    this.currentPage = 'about';
    this.hideAllPages();
    document.getElementById('about-page').classList.remove('hidden');
    this.updateNavigation('about');
  }

  // Show projects page
  showProjects() {
    this.currentPage = 'projects';
    this.hideAllPages();
    document.getElementById('projects-page').classList.remove('hidden');
    this.updateNavigation('projects');
  }

  // Initialize writing filtering scoped to a container
  initializeWriting(container) {
    const scope = container || document;
    const filterPills = scope.querySelectorAll('.filter-pill');
    const writingEntries = scope.querySelectorAll('.writing-entry');
    const noResults = scope.querySelector('.no-results');

    let activeFilter = 'thoughts'; // Default to 'thoughts'

    // Set the default active filter on initialization
    filterPills.forEach(pill => {
      if (pill.dataset.filter === 'thoughts') {
        pill.classList.add('active');
      }
    });

    // Apply initial filter
    this.applyFilters(writingEntries, noResults, activeFilter);

    filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        const filter = pill.dataset.filter;

        // If clicking the already active filter, do nothing (mutually exclusive - must have one active)
        if (activeFilter === filter) {
          return;
        }

        // Remove active class from all pills
        filterPills.forEach(p => p.classList.remove('active'));

        // Set new active filter
        activeFilter = filter;
        pill.classList.add('active');

        this.applyFilters(writingEntries, noResults, activeFilter);
      });
    });
  }

  // Apply filters to writing
  applyFilters(writingEntries, noResults, activeFilter) {
    let visibleCount = 0;

    writingEntries.forEach(entry => {
      const tags = entry.dataset.tags.split(',');

      // Since we always have an active filter, check if entry has that tag
      if (tags.includes(activeFilter)) {
        entry.classList.remove('hidden');
        visibleCount++;
      } else {
        entry.classList.add('hidden');
      }
    });

    if (visibleCount === 0) {
      noResults.classList.remove('hidden');
    } else {
      noResults.classList.add('hidden');
    }
  }

  // Update navigation state
  updateNavigation(page) {
    const navLinks = document.querySelectorAll('.sidebar-nav a');
    navLinks.forEach(link => {
      link.classList.remove('active');
      if (link.getAttribute('data-page') === page) {
        link.classList.add('active');
      }
    });
  }

  // Handle navigation clicks
  handleNavigation(page) {
    switch(page) {
      case 'about':
        this.showAbout();
        break;
      case 'writing':
        this.showWriting();
        break;
      case 'projects':
        this.showProjects();
        break;
    }
  }
}

// Initialize the markdown renderer
document.addEventListener('DOMContentLoaded', function() {
  const renderer = new MarkdownRenderer();

  // Load posts when the page loads
  renderer.loadPosts().then(() => {
    console.log('Posts loaded successfully');
    // After posts are loaded, handle initial hash navigation (e.g., #writing, #post/volume1)
    const initialHash = window.location.hash.replace('#', '');
    if (initialHash) {
      if (initialHash.startsWith('post/')) {
        const postId = initialHash.replace('post/', '');
        renderer.showPost(postId);
      } else {
        renderer.handleNavigation(initialHash);
      }
    }
  });

  // Override all navigation to use the renderer
  const navLinks = document.querySelectorAll('.sidebar-nav a');
  navLinks.forEach(link => {
    link.addEventListener('click', function(e) {
      e.preventDefault();
      const page = this.getAttribute('data-page');
      renderer.handleNavigation(page);

      // Update URL without triggering a page reload
      history.pushState(null, '', this.getAttribute('href'));
    });
  });

  // Handle browser back/forward buttons
  window.addEventListener('popstate', () => {
    const hash = window.location.hash.replace('#', '');
    if (hash) {
      if (hash.startsWith('post/')) {
        const postId = hash.replace('post/', '');
        renderer.showPost(postId);
      } else {
        renderer.handleNavigation(hash);
      }
    } else {
      // If no hash, show about page
      renderer.showAbout();
    }
  });
}); 