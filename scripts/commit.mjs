// Коммит без системного git (он заблокирован на этом маке лицензией Xcode). isomorphic-git пишет
// обычный .git, так что после принятия лицензии обычный `git` продолжит с того же места.
//
//   node scripts/commit.mjs "Что изменилось и зачем"
//
// Добавляет все новые, изменённые и удалённые файлы, которые не исключены .gitignore, и делает
// коммит в main. Без push и без remote. Если .git нет — сначала git init.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import git from 'isomorphic-git';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const message = process.argv.slice(2).join(' ').trim();
if (!message) {
  console.error('Использование: node scripts/commit.mjs "сообщение коммита"');
  process.exit(2);
}

if (!fs.existsSync(path.join(dir, '.git'))) {
  await git.init({ fs, dir, defaultBranch: 'main' });
  console.log('git init — создан репозиторий (ветка main)');
}

// [путь, HEAD, рабочая копия, индекс]: 0 — нет; 1 — как в HEAD; 2 — изменён; 3 — индекс отличается от обоих.
// Игнорируемые (.gitignore) файлы сюда не попадают.
const matrix = await git.statusMatrix({ fs, dir });
for (const [filepath, head, workdir, stage] of matrix) {
  if (workdir === 0 && (head === 1 || stage !== 0)) await git.remove({ fs, dir, filepath });
  else if (workdir === 2 && stage !== 2) await git.add({ fs, dir, filepath });
}

// Что попадёт в коммит: индекс против HEAD
const after = await git.statusMatrix({ fs, dir });
const added = after.filter(([, head, , stage]) => head === 0 && stage !== 0).length;
const changed = after.filter(([, head, , stage]) => head === 1 && (stage === 2 || stage === 3)).length;
const removed = after.filter(([, head, , stage]) => head === 1 && stage === 0).length;
if (added + changed + removed === 0) {
  console.log('nothing to commit');
  process.exit(0);
}

const author = { name: 'Claude', email: 'noreply@anthropic.com' };
const sha = await git.commit({ fs, dir, message, author, committer: author });
console.log(`${sha.slice(0, 12)} — новых ${added}, изменённых ${changed}, удалённых ${removed}`);
