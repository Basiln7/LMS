import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// DATABASE_URL is only needed by commands that connect (migrate, studio).
// `prisma generate` must work in CI/Docker builds without database credentials.
const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  ...(url ? { datasource: { url } } : {}),
});
