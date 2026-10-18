const idPattern='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const reference=new RegExp(`^(?:\\./)?api/photos/(${idPattern})\\?width=(\\d{1,4})&height=(\\d{1,4})$`);
const publishedReference=new RegExp(`^https://christopherli\\.dev/journal/public/photos/(${idPattern})\\?width=(\\d{1,4})&height=(\\d{1,4})$`);
const image=new RegExp(`!\\[[^\\]\\r\\n]*\\]\\((?:\\./)?api/photos/${idPattern}\\?width=\\d{1,4}&height=\\d{1,4}\\)`,'gu');
export function photoReference(href){
  const match=typeof href==='string'&&(href.match(reference)||href.match(publishedReference));if(!match)return null;
  const width=Number(match[2]),height=Number(match[3]);
  return width>0&&height>0&&width<=4096&&height<=4096?{id:match[1],width,height}:null;
}
export const photoSource=photo=>`./api/photos/${photo.id}?width=${photo.width}&height=${photo.height}`;
export const plainPhotoLinks=source=>source.replace(image,'');
