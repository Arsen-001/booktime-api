import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// process.env, а не env() из prisma/config: env() падает без переменной, а на Railway теневой базы нет
// (она нужна только `prisma migrate dev` на машине разработчика), DATABASE_URL при сборке может ещё не быть.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations', seed: 'tsx prisma/seed.ts' },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
});
