// Railway: API и воркер в одном контейнере — общий диск для файлов (STORAGE_DRIVER=local, выгрузки отчётов пишет
// воркер, раздаёт API). Падает любой из двух — выходим, Railway перезапускает сервис целиком. Когда появится S3,
// их можно разнести на два сервиса (start:api / start:worker).
import { spawn } from 'node:child_process';

const procs = ['dist/main.js', 'dist/worker.js'].map((entry) => {
  const p = spawn(process.execPath, ['--enable-source-maps', entry], { stdio: 'inherit', env: process.env });
  p.on('exit', (code, signal) => {
    console.error(`[railway-start] ${entry} завершился (code=${code}, signal=${signal}) — останавливаю сервис`);
    for (const other of procs) if (other !== p && other.exitCode === null) other.kill('SIGTERM');
    process.exit(code ?? 1);
  });
  return p;
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    for (const p of procs) if (p.exitCode === null) p.kill(sig);
  });
}
