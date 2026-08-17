# Session Log: 2026-08-17 Next.js Client Component Export Fix

## What was asked
- Fix the Next.js runtime error: `Application Error: async/await is not yet supported in Client Components, only Server Components. This error is often caused by accidentally adding 'use client' to a module that was originally written for the server.`

## Root Cause
- Client Components marked with `'use client'` were exporting `export const dynamic = 'force-dynamic'`, which is a Server Component configuration directive.
- This mismatched configuration caused Next.js 14 App Router bundler to treat client route pages as async Server Components during dynamic navigation.

## Fix Applied
- Removed `export const dynamic = 'force-dynamic'` from all `'use client'` pages (`host/page.tsx`, `play/page.tsx`, `results/page.tsx`, `lobby/[pin]/page.tsx`, `auth/page.tsx`, `dashboard/page.tsx`, `practice/page.tsx`, `studio/page.tsx`).

## Verification
- `npx tsc --noEmit` -> Passed with 0 errors (Exit Code 0).
- Git commit `9834ddd` pushed live to `main`.
