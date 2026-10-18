import { searchTerms } from './public/search-terms.js';

// Only these terms are interpolated into an FTS expression. SQL values are bound.
export function ftsQuery(query, matchAll = false) {
  return searchTerms(query).map(term => `"${term}"*`).join(matchAll ? ' AND ' : ' OR ');
}

export const THOUGHT_FIELDS = ['seq', 'id', 'title', 'body', 'bookmarked', 'liked', 'created_at', 'updated_at', 'source_date', 'is_draft', 'revision'];
