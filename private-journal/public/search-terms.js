// Function words should not make an unfinished sentence match the whole feed.
const commonWords = new Set('a an and are as at be been being but by can could did do does doing for from had has have how i if in into is it its just me might more my of on or our should so some than that the their them then there these they this those to too us was we were what when where which who why will with would you your'.split(' '));

export function searchTerms(query = '') {
  const words = query.match(/[\p{L}\p{N}]+/gu) || [];
  const specific = words.filter(word => !commonWords.has(word.toLowerCase()));
  return (specific.length ? specific : words).slice(0, 20);
}
