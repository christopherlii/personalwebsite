import { searchTerms } from './public/search-terms.js';

// Only these terms are interpolated into an FTS expression. SQL values are bound.
export function ftsQuery(query) {
  return searchTerms(query).map(term => `"${term}"*`).join(' OR ');
}

export const THOUGHT_FIELDS = ['seq', 'id', 'title', 'body', 'bookmarked', 'created_at', 'updated_at', 'source_date'];
