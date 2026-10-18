// Only these terms are interpolated into an FTS expression. SQL values are bound.
export function ftsQuery(query) {
  return (query.match(/[\p{L}\p{N}]+/gu) || []).slice(0, 20).map(term => `"${term}"*`).join(' OR ');
}

export const THOUGHT_FIELDS = ['seq', 'id', 'body', 'bookmarked', 'created_at', 'updated_at'];
