import { photoSource } from './photo-links.js';

async function prepare(file){
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Choose a JPEG, PNG, or WebP photo.');
  if(file.size>25000000)throw new Error('This photo is too large to open. Try a smaller image.');
  let bitmap;
  try{bitmap=await createImageBitmap(file);}
  catch{throw new Error('This photo could not be opened. Try another image.');}
  try{
    const canvas=document.createElement('canvas'),context=canvas.getContext('2d');
    let scale=Math.min(1,2048/Math.max(bitmap.width,bitmap.height)),quality=.85;
    for(let attempt=0;attempt<6;attempt++){
      canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));
      if(blob&&blob.size<=1000000)return blob;
      scale*=.75;quality=Math.max(.55,quality-.08);
    }
    throw new Error('This photo could not be resized. Try a smaller image.');
  }finally{bitmap.close();}
}
export function createPhotos({api,getEditor,onBusy,onMessage}){
  const input=document.getElementById('photo-input');let job=null,controller=null,choice=null;
  function cancel(){controller?.abort();choice?.target.cancel();choice=null;input.value='';}
  async function add(files,selection){
    if(!files.length){selection?.target.cancel();return;}
    if(job){selection?.target.cancel();return;}
    if(files.length>10){selection?.target.cancel();onMessage(selection.owner,'Choose up to 10 photos at a time.');return;}
    controller=new AbortController();const signal=controller.signal;onBusy(true);onMessage(selection.owner,'');
    const timeout=setTimeout(()=>{onMessage(selection.owner,'Photo upload timed out. Try again.');controller?.abort();},30000);
    job=(async()=>{
      for(const file of files){
        const blob=await prepare(file);if(signal.aborted)throw new DOMException('Photo upload canceled.','AbortError');
        const id=crypto.randomUUID();
        const {photo}=await api(`photos/${id}`,{method:'PUT',body:blob,headers:{'Content-Type':blob.type},signal});
        if(signal.aborted)throw new DOMException('Photo upload canceled.','AbortError');
        if(!selection.target.insert(`![photo](${photoSource(photo)})`)){
          await api(`photos/${id}`,{method:'DELETE'}).catch(()=>{});throw new Error('The photo could not be added. Reopen the writing and try again.');
        }
      }
    })();
    try{await job;}catch(error){if(error.name!=='AbortError')onMessage(selection.owner,error.message);}
    finally{clearTimeout(timeout);selection.target.cancel();job=null;controller=null;onBusy(false);}
  }
  function selection(owner){const target=getEditor(owner)?.captureInsertion();return target?{owner,target}:null;}
  input.addEventListener('change',()=>{const selected=choice;choice=null;if(selected)add([...input.files],selected);input.value='';});
  input.addEventListener('cancel',()=>{choice?.target.cancel();choice=null;});
  for(const [id,owner]of [['composer-editor','composer'],['live-editor','reader']]){
    const parent=document.getElementById(id);
    parent.addEventListener('paste',event=>{const files=[...(event.clipboardData?.files||[])];if(!files.length)return;const selected=selection(owner);if(!selected)return;event.preventDefault();add(files,selected);},true);
    parent.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();});
    parent.addEventListener('drop',event=>{const files=[...(event.dataTransfer?.files||[])];if(!files.length)return;const selected=selection(owner);if(!selected)return;event.preventDefault();event.stopPropagation();add(files,selected);},true);
  }
  return{get busy(){return Boolean(job);},cancel,async finish(){try{await job;return true;}catch{return false;}},choose(owner){if(job)return;choice?.target.cancel();choice=selection(owner);if(choice){input.value='';input.click();}}};
}
