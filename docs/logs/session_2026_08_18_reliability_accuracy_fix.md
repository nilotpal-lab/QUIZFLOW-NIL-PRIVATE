# Session Log: Accuracy Evaluation Fix & Low-Latency Sync Recovery

**Date**: 2026-08-18  
**Author**: Antigravity AI  

## What was asked
User reported 4 critical live issues:
1. Bots stopped answering after 10 questions.
2. In friend's mobile question arrived 6 seconds faster than user's mobile.
3. For user & friend, questions stopped arriving for ~10 seconds once or twice.
4. Correct answer was marked as wrong (green choice button, footer showed wrong with explanation).

## Root Cause Analysis & Fixes
1. **Issue #4 (Right answer marked wrong)**:
   - When \correct_index\ was stripped on the client during \question_active\, \submitAnswer()\ evaluated \selectedIndex === q.correct_index\ as \alse\ because \q.correct_index\ was \undefined\.
   - On \question_reveal\, \q.correct_index\ was populated, turning the choice button green, but \me.lastAnswerCorrect\ remained \alse\.
   - Fix: In \play/page.tsx\, on \question_reveal\, compute \myCorrect\ authoritatively from \me.selectedIndex === q.correct_index\. In \sessionStore.ts\ \submitAnswer\, preserve \isKnownCorrect\ as null when sanitized.
2. **Issue #2 & #3 (6s - 10s question delay on mobile)**:
   - Mobile devices that briefly sleep/background throttled polling to 3000ms.
   - When WebSocket hit transient \CHANNEL_ERROR\ on mobile data, it did not immediately force-poll.
   - Fix: Lower poll interval to responsive 1000ms with zero-delay trigger on \isibilitychange\ & \ocus\, and force immediate poll when Supabase channel encounters network blips.
3. **Issue #1 (Bots stopping after 10 questions)**:
   - Simulator had \HOLD_MS = 300000\ (5 minutes), which timed out around Question 10 on a 12-question quiz.
   - Fix: Increase \HOLD_MS\ to 30 minutes (\1800000\ ms).

## Verification
- \
px tsc --noEmit\ -> 0 errors.
- \
pm run build\ -> Passed cleanly.
