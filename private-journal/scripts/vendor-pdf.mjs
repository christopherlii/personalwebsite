// Copies the pinned PDF.js build into public/vendor so PDFs render with no
// external runtime assets. Standard fonts cover PDFs that do not embed theirs.
import { copyFile, mkdir, readdir } from 'node:fs/promises';

const from = new URL('../node_modules/pdfjs-dist/', import.meta.url), to = new URL('../public/vendor/', import.meta.url);
await mkdir(new URL('standard_fonts/', to), { recursive: true });
await copyFile(new URL('build/pdf.min.mjs', from), new URL('pdf.min.mjs', to));
await copyFile(new URL('build/pdf.worker.min.mjs', from), new URL('pdf.worker.min.mjs', to));
await copyFile(new URL('LICENSE', from), new URL('pdfjs-LICENSE.txt', to));
for (const file of await readdir(new URL('standard_fonts/', from))) await copyFile(new URL(`standard_fonts/${file}`, from), new URL(`standard_fonts/${file}`, to));
