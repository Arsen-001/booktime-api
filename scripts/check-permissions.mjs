// Сверка списка прав сервера с фронтом (PLAN.md §5: права — один список на сервер и фронт).
//   node scripts/check-permissions.mjs [путь к booking-platform]
import fs from 'node:fs';
import path from 'node:path';

const front = path.resolve(process.argv[2] ?? '../booking-platform', 'src/config/permissions.ts');
const server = path.resolve('src/common/permissions/permissions.ts');
const list = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  const body = text.slice(text.indexOf('PERMISSIONS = ['), text.indexOf('] as const'));
  return [...body.matchAll(/'([a-zA-Z.]+)'/g)].map((m) => m[1]);
};
const a = list(front);
const b = list(server);
const onlyFront = a.filter((p) => !b.includes(p));
const onlyServer = b.filter((p) => !a.includes(p));
if (onlyFront.length || onlyServer.length) {
  console.error(`Права расходятся.\n  только во фронте: ${onlyFront.join(', ') || '—'}\n  только на сервере: ${onlyServer.join(', ') || '—'}`);
  process.exit(1);
}
console.log(`Права совпадают: ${a.length}`);
