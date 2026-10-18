import { passwordHash, hex } from '../auth.mjs';
import { writeFile } from 'node:fs/promises';

if (process.stdin.isTTY) {
  process.stderr.write('Pipe a password from your password manager or read it with a hidden shell prompt. See README.md.\n');
  process.exit(1);
}
let input = '';
for await (const chunk of process.stdin) input += chunk;
const password = input.replace(/\r?\n$/, '');
if (password.length < 16 || password.length > 1024) {
  process.stderr.write('Use a password between 16 and 1024 characters.\n');
  process.exit(1);
}
const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
const value = `pbkdf2-sha256$600000$${salt}$${await passwordHash(password, salt)}`;
if (process.argv[2] === '--local') {
  // Refuse to overwrite an existing configuration or its optional Jev key.
  await writeFile(new URL('../.dev.vars', import.meta.url), `JOURNAL_PASSWORD_HASH="${value}"\n`, { mode: 0o600, flag: 'wx' });
  process.stderr.write('Wrote owner-only .dev.vars.\n');
} else {
  process.stdout.write(value + '\n');
}
