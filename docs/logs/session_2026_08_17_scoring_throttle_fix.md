# Session Log: Duplicate Scoring Elimination & 400-Player Write Throttling

## Date: 2026-08-17

### 1. What was asked:
- Diagnose why bots were scoring 28,425 points and showing 28/30 correct answers in a 7-question quiz.
- Diagnose why there was high lag on the leaderboard and questions took 5-6 seconds to load on friends' devices.

### 2. What was planned:
- Forensic trace of `submit_answer` reception in `sessionStore.ts` and `loadtest_playwright.js`.
- Add strict deduplication guard (`lastAnsweredQIdx` and `hasAnswered`) to prevent duplicate point additions per question.
- Implement `queueBatchedPlayerAnswer` to throttle 400-player writes into 150ms batches, eliminating UI freezes and network bottleneck.

### 3. What was done:
- **Deduplicated Scoring (`sessionStore.ts`)**:
  - Added `lastAnsweredQIdx?: number` to `Player` interface.
  - Guarded `submit_answer` event handler so that each player can ONLY score once per question index (`p.hasAnswered || p.lastAnsweredQIdx === qIdx`).
  - Added point capping to max 1,000 pts per question.
  - Reset `lastAnsweredQIdx: undefined` on `startGame` and `nextQuestion`.
- **400-Player Write Batching (`sessionStore.ts`)**:
  - Added `queueBatchedPlayerAnswer` to batch incoming answers every 150ms instead of running 400 synchronous full-state JSON serializations per second.
- **Simulator Optimization (`loadtest_playwright.js`)**:
  - Replaced 400 separate listener loops with 1 centralized Supabase Realtime channel handler.
  - Configured realistic accuracy (~65% correct) and human response delays (800ms - 3200ms).

### 4. Verification:
- **Type Check**: `npx tsc --noEmit` passed with 0 errors.
- **Git Push**: Commit `ace97ad` pushed live to `https://github.com/nilotpal-lab/QUIZFLOW-NIL-PRIVATE.git`.
