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
      // Fetch the list of markdown files
      const response = await fetch('/posts/');
      const text = await response.text();
      
      // Extract .md files from the directory listing
      const mdFiles = text.match(/href="([^"]*\.md)"/g)?.map(match => 
        match.replace('href="', '').replace('"', '')
      ) || [];
      
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
      
      this.updateArchivesList();
      return this.posts;
    } catch (error) {
      console.error('Error loading posts:', error);
      return [];
    }
  }

  // Update the archives list on the homepage
  updateArchivesList() {
    const archivesList = document.querySelector('.archives-list');
    if (!archivesList) return;

    const archivesEntries = this.posts.map(post => {
      const tagsString = post.tags.join(',');
      return `<a href="#" class="archives-entry" data-tags="${tagsString}" data-post="${post.filename}">
        <h3>${post.title}</h3>
        <p>${post.description}</p>
      </a>`;
    }).join('');

    archivesList.innerHTML = archivesEntries;
    
    // Add click handlers for the new entries
    this.addPostClickHandlers();
  }

  // Add click handlers for post links
  addPostClickHandlers(container) {
    const scope = container || document;
    const postLinks = scope.querySelectorAll('.archives-entry[data-post]');
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
        <a href="#" class="return-button" id="return-to-archives">← Return to Archives</a>
      </div>
    `;

    // Create a new page div for the post with fixed width
    const postPage = document.createElement('div');
    postPage.id = 'post-page';
    postPage.style.cssText = 'width: 600px; max-width: 600px; margin: 0 auto;';
    postPage.innerHTML = postHTML;
    document.querySelector('.content').appendChild(postPage);

    // Add return button handler
    document.getElementById('return-to-archives').addEventListener('click', (e) => {
      e.preventDefault();
      this.showArchives();
    });

    // Update navigation
    this.updateNavigation('archives');
  }

  // Show archives list
  showArchives() {
    this.currentPage = 'archives';
    
    // Hide all existing pages
    this.hideAllPages();
    
    // Remove any existing dynamic archives page to avoid duplicate handlers
    const existing = document.getElementById('archives-page-dynamic');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    // Create archives page with proper container structure
    const archivesHTML = `
      <div>
        <h2>Archives</h2>
      </div>
      
      <div class="filter-container">
        <div class="filter-pills">
          <div class="filter-pill" data-filter="nyu">
            <div class="filter-indicator"></div>
            <span>NYU</span>
          </div>
          <div class="filter-pill" data-filter="thoughts">
            <div class="filter-indicator"></div>
            <span>Thoughts</span>
          </div>
              <div class="filter-pill" data-filter="updates">
                <div class="filter-indicator"></div>
                <span>Updates</span>
              </div>
              
          <div class="filter-pill" data-filter="random">
            <div class="filter-indicator"></div>
            <span>Random</span>
          </div>
        </div>
      </div>

      <div class="archives-list">
        ${this.posts.map(post => {
          const tagsString = post.tags.join(',');
          return `<a href="#" class="archives-entry" data-tags="${tagsString}" data-post="${post.filename}">
            <h3>${post.title}</h3>
            <p>${post.description}</p>
          </a>`;
        }).join('')}
      </div>

      <div class="no-results hidden">
        <p>No posts match the selected filters.</p>
      </div>
    `;

    // Create a new archives page div with fixed width
    const archivesPage = document.createElement('div');
    archivesPage.id = 'archives-page-dynamic';
    archivesPage.style.cssText = 'width: 600px; max-width: 600px; margin: 0 auto;';
    archivesPage.innerHTML = archivesHTML;
    document.querySelector('.content').appendChild(archivesPage);

    // Reinitialize archives functionality
    this.initializeArchives(archivesPage);
    this.addPostClickHandlers(archivesPage);
    
    // Update navigation
    this.updateNavigation('archives');
  }

  // Hide all pages
  hideAllPages() {
    const pages = document.querySelectorAll('[id$="-page"], [id$="-page-dynamic"]');
    pages.forEach(page => {
      page.classList.add('hidden');
    });
  }

  // Show home page
  showHome() {
    this.currentPage = 'home';
    this.hideAllPages();
    document.getElementById('home-page').classList.remove('hidden');
    this.updateNavigation('home');
  }

  // Show contact page
  showContact() {
    this.currentPage = 'contact';
    this.hideAllPages();
    document.getElementById('contact-page').classList.remove('hidden');
    this.updateNavigation('contact');
  }

  // Initialize archives filtering scoped to a container
  initializeArchives(container) {
    const scope = container || document;
    const filterPills = scope.querySelectorAll('.filter-pill');
    const archiveEntries = scope.querySelectorAll('.archives-entry');
    const noResults = scope.querySelector('.no-results');
    
    let activeFilters = new Set();

    filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        const filter = pill.dataset.filter;
        
        if (activeFilters.has(filter)) {
          activeFilters.delete(filter);
          pill.classList.remove('active');
        } else {
          activeFilters.add(filter);
          pill.classList.add('active');
        }
        
        this.applyFilters(archiveEntries, noResults, activeFilters);
      });
    });
  }

  // Apply filters to archives
  applyFilters(archiveEntries, noResults, activeFilters) {
    let visibleCount = 0;
    
    archiveEntries.forEach(entry => {
      const tags = entry.dataset.tags.split(',');
      
      if (activeFilters.size === 0) {
        entry.classList.remove('hidden');
        visibleCount++;
      } else {
        const hasActiveFilter = Array.from(activeFilters).some(filter => 
          tags.includes(filter)
        );
        
        if (hasActiveFilter) {
          entry.classList.remove('hidden');
          visibleCount++;
        } else {
          entry.classList.add('hidden');
        }
      }
    });
    
    if (visibleCount === 0 && activeFilters.size > 0) {
      noResults.classList.remove('hidden');
    } else {
      noResults.classList.add('hidden');
    }
  }

  // Update navigation state
  updateNavigation(page) {
    const navLinks = document.querySelectorAll('.nav a');
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
      case 'home':
        this.showHome();
        break;
      case 'archives':
        this.showArchives();
        break;
      case 'contact':
        this.showContact();
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
    // After posts are loaded, handle initial hash navigation (e.g., #archives)
    const initialHash = window.location.hash.replace('#', '');
    if (initialHash) {
      renderer.handleNavigation(initialHash);
    }
  });

  // Override all navigation to use the renderer
  const navLinks = document.querySelectorAll('.nav a');
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
      renderer.handleNavigation(hash);
    }
  });
}); 