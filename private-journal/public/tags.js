import './vendor/marked.min.js';
import { thoughtLinks } from './thought-links.js';

const lexer = new globalThis.marked.Marked({gfm:true});
export function normalizeTag(value) {
  if (typeof value !== 'string') return null;
  const tag=value.normalize('NFC').toLowerCase();
  return tag.length<=64 && /^[\p{L}\p{M}\p{N}_-]+(?:\/[\p{L}\p{M}\p{N}_-]+)*$/u.test(tag) && /[\p{L}_-]/u.test(tag) ? tag : null;
}
export function textTags(text) {
  const result=[];
  for (const match of text.matchAll(/(?<![\p{L}\p{M}\p{N}_/#\\&])#([\p{L}\p{M}\p{N}_-]+(?:\/[\p{L}\p{M}\p{N}_-]+)*)(?![\p{L}\p{M}\p{N}_/-])/gu)) {
    const tag=normalizeTag(match[1]); if(tag)result.push({from:match.index,to:match.index+match[0].length,text:match[0],tag});
  }
  return result;
}
// Marked retains raw source per token. Map nested raw text back to the exact
// document positions, including prefixes removed from lists and blockquotes.
export function markdownTags(source) {
  const result=[], links=thoughtLinks(source);
  function walk(tokens,raw,positions) {
    let cursor=0;
    for(const token of tokens) {
      const value=token.raw ?? token.text ?? '';
      let start=raw.indexOf(value,cursor), map=[];
      if(start>=0){map=positions.slice(start,start+value.length);cursor=start+value.length;}
      else {
        let at=cursor;
        for(const point of value){const next=raw.indexOf(point,at);if(next<0){map=[];break;}for(let i=0;i<point.length;i++)map.push(positions[next+i]);at=next+point.length;}
        if(map.length)cursor=at;
      }
      if(!map.length)continue;
      if(['code','codespan','html','link','image','escape'].includes(token.type))continue;
      if(token.tokens)walk(token.tokens,value,map);
      else if(token.type==='text')for(const tag of textTags(value)) {
        const from=map[tag.from],to=map[tag.to-1]+1;
        if(source.slice(from,to)===tag.text&&!links.some(link=>from<link.to&&to>link.from))result.push({...tag,from,to});
      }
      if(token.items)walk(token.items,value,map);
      if(Array.isArray(token.header))walk(token.header,value,map);
      if(token.rows)for(const row of token.rows)walk(row,value,map);
    }
  }
  walk(lexer.lexer(source),source,Array.from({length:source.length},(_,i)=>i));
  return result.sort((a,b)=>a.from-b.from);
}
export const tagNames = source => [...new Set(markdownTags(source).map(match=>match.tag))];
