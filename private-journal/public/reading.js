import { plainThoughtLinks } from './thought-links.js';

const $ = selector => document.querySelector(selector);
const node = (tag, className, text) => { const el=document.createElement(tag); if(className)el.className=className; if(text)el.textContent=text; return el; };
const label = entry => entry.title || new URL(entry.url).hostname + (new URL(entry.url).pathname === '/' ? '' : new URL(entry.url).pathname);
const host = url => new URL(url).hostname.replace(/^www\./,'');
const external = (entry) => { const a=node('a','reading-title',label(entry)); a.href=entry.url; a.target='_blank'; a.rel='noopener noreferrer'; return a; };
export function createReading({api,navigateThought}) {
  let generation=0, filter='unread', next=null, saving=false, pending=null, relatedGeneration=0, relatedKey='', relatedEditing=false, relatedHasResults=false;
  const entries=new Map();
  function item(entry) {
    const article=node('article','reading-item'); article.dataset.id=entry.id;
    article.append(node('p','reading-meta',host(entry.url)),external(entry));
    const actions=node('div','reading-actions');
    const toggle=node('button','',entry.read_at ? 'mark unread' : 'mark read'); toggle.type='button';
    const remove=node('button','','remove'); remove.type='button';
    toggle.addEventListener('click',async()=>{
      toggle.disabled=true;
      try { await api(`reading/${entry.id}`,{method:'PATCH',body:JSON.stringify({read:!entry.read_at})}); entries.delete(entry.id); article.remove(); empty(); }
      catch(error){$('#reading-message').textContent=error.message;toggle.disabled=false;}
    });
    remove.addEventListener('click',async()=>{
      if(remove.dataset.confirm!=='yes'){remove.dataset.confirm='yes';remove.textContent='remove link?';return;}
      remove.disabled=true;
      try{await api(`reading/${entry.id}`,{method:'DELETE'});entries.delete(entry.id);article.remove();empty();}
      catch(error){$('#reading-message').textContent=error.message;remove.disabled=false;}
    });
    remove.addEventListener('blur',()=>{if(!remove.disabled){delete remove.dataset.confirm;remove.textContent='remove';}});
    actions.append(toggle,remove);article.append(actions);return article;
  }
  function empty(){ $('#reading-empty').textContent=entries.size ? '' : filter==='read' ? 'nothing marked read yet.' : 'no links saved for later.'; }
  async function load(append=false){
    const current=++generation, selected=filter;
    try{
      const data=await api(`reading?read=${filter==='read'?1:0}${append&&next ? `&cursor=${next}` : ''}`);
      if(current!==generation||selected!==filter)return;
      if(!append){entries.clear();$('#reading-list').replaceChildren();}
      for(const entry of data.entries)if(!entries.has(entry.id)){entries.set(entry.id,entry);$('#reading-list').append(item(entry));}
      next=data.next;$('#reading-more').hidden=next===null;empty();
      for(const button of document.querySelectorAll('[data-reading-filter]'))button.setAttribute('aria-current',button.dataset.readingFilter===filter?'page':'false');
    }catch(error){if(current===generation)$('#reading-message').textContent=error.message;}
  }
  for(const button of document.querySelectorAll('[data-reading-filter]'))button.addEventListener('click',()=>{filter=button.dataset.readingFilter;$('#reading-message').textContent='';load();});
  $('#reading-more').addEventListener('click',()=>load(true));
  $('#reading-form').addEventListener('submit',async event=>{
    event.preventDefault();if(saving)return;
    const url=$('#reading-url').value.trim();
    if(!pending||pending.url!==url)pending={id:crypto.randomUUID(),url};
    saving=true;$('#reading-save').disabled=true;$('#reading-message').textContent='';
    try{
      const data=await api('reading',{method:'POST',body:JSON.stringify(pending)});
      pending=null;$('#reading-url').value='';filter=data.entry.read_at?'read':'unread';
      $('#reading-message').textContent=data.existing?'already saved.':'saved.';await load();
    }catch(error){$('#reading-message').textContent=error.message;}
    finally{saving=false;$('#reading-save').disabled=false;}
  });
  function hideRelated(){ relatedGeneration++;relatedKey='';relatedHasResults=false;$('#related').replaceChildren();$('#related').hidden=true; }
  return {
    async show(){ $('#reading').hidden=false;await load(); },
    hide(){ generation++;$('#reading').hidden=true; },
    clear(){ generation++;entries.clear();pending=null;$('#reading-list').replaceChildren();$('#reading-url').value='';$('#reading-message').textContent='';hideRelated(); },
    editing(value){relatedEditing=value;$('#related').hidden=value||!relatedHasResults;},
    hideRelated,
    async related(entry){
      const key=entry.id+'\n'+entry.title+'\n'+entry.body;if(key===relatedKey)return;hideRelated();relatedKey=key;
      const current=relatedGeneration;
      try{
        const data=await api(`thoughts/${entry.id}/related`,{method:'POST',body:'{}'});
        if(current!==relatedGeneration)return;
        const fragment=document.createDocumentFragment();
        for(const thought of data.thoughts){
          const row=node('div','related-item');row.append(node('p','reading-meta',thought.published_slug?'your writing':'thought'));
          const open=node('button','related-title',thought.title||plainThoughtLinks(thought.body).replace(/^[ \t]*\/(idea|project|curious|hm)[ \t]+/gim,''));open.type='button';open.addEventListener('click',()=>navigateThought(thought.id));row.append(open);fragment.append(row);
        }
        for(const saved of data.reading){const row=node('div','related-item');row.append(node('p','reading-meta',host(saved.url)),external(saved));fragment.append(row);}
        relatedHasResults=Boolean(fragment.childNodes.length);
        if(relatedHasResults)$('#related').append(node('h2','','related'),fragment);
        $('#related').hidden=relatedEditing||!relatedHasResults;
      }catch{/* Reading suggestions never replace the writing or its errors. */}
    }
  };
}
