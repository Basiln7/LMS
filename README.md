# LMS — Recorded Classes

Secure delivery of recorded courses: student management, DRM video playback, progress analytics, drip and quiz gating, lesson Q&A. Payments and the storefront live on an external platform that provisions access through a signed webhook.

- **Architecture, ERD and module designs:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **API (NestJS + Prisma + PostgreSQL):** [backend/](backend/)
  - Data model: [backend/prisma/schema.prisma](backend/prisma/schema.prisma) · SQL: [backend/prisma/migrations](backend/prisma/migrations)
  - Enrollment webhook: [backend/src/modules/enrollments/sync](backend/src/modules/enrollments/sync)

```bash
cd backend && cp .env.example .env && npm install && npx prisma migrate deploy && npm run build && npm start
```
