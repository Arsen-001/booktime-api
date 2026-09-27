import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Нужные сиду поля ядра мока (booking-platform/src/domain/core.ts) — только то, что читает сервер */
export interface MockAppUser {
  id: string;
  phone: string;
  name: string;
  gender?: string;
  birthday?: string;
  district?: string;
  locale?: string;
  createdAt?: string;
}
export interface MockStaff {
  id: string;
  businessId: string;
  name: string;
  phone?: string;
  role: 'owner' | 'admin' | 'master';
  login?: string;
  status: string;
}
export interface MockCore {
  appUsers: MockAppUser[];
  staff: MockStaff[];
  businesses: { id: string; name: string; kind: string; ownerStaffId: string; networkId?: string }[];
  [key: string]: unknown;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Демо-ядро фронта. Фронт ищется рядом (../booking-platform) или по FRONTEND_DIR. Снимок кладётся в
 * prisma/seed/.cache/core.json — без фронта сид берёт последний снимок.
 */
export function loadMockCore(): MockCore {
  const frontend = path.resolve(process.env.FRONTEND_DIR ?? path.join(here, '../../../booking-platform'));
  const cache = path.join(here, '.cache/core.json');
  if (fs.existsSync(path.join(frontend, 'src/mock/seed/index.ts'))) {
    // tsx сервера (devDependency), модули мока резолвятся из node_modules фронта (cwd)
    const tsx = path.join(here, '../../node_modules/.bin/tsx');
    const out = execFileSync(tsx, ['--tsconfig', path.join(frontend, 'tsconfig.json'), path.join(here, 'export-mock.ts')], {
      cwd: frontend,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
    });
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, out);
    return JSON.parse(out) as MockCore;
  }
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8')) as MockCore;
  throw new Error(`Нет фронта (${frontend}) и нет снимка ${cache}: задайте FRONTEND_DIR`);
}
