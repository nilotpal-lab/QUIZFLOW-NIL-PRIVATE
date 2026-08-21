# 📋 QuizFlow Session Log: Fixed 29 vs 30 Questions Parsing Bug (Apostrophe Quoting & Direct 2D Native Sheet Ingestion)

**Timestamp:** 2026-08-21T23:25:00+05:30  
**Status:** ✅ Successfully Built, Verified & Deployed

---

## 1. What Was Asked
The user uploaded an Excel file containing **30 questions**, but QuizFlow only parsed **29 questions** (dropping 1 question).

---

## 2. Root Cause Identified & The Fix

### A. Root Cause
In question 29:
> *"What happens to excess dietary protein beyond the **body's** growth and repair needs?"*

The word **`body's`** contains a single quote / apostrophe (`'`).
The CSV line tokenizer was checking `if (char === '"' || char === "'") inQuotes = !inQuotes;`.
Because single quotes were treated as CSV quote wrappers, the apostrophe in `body's` set `inQuotes = true` for the rest of the line (since there was no closing single quote). As a result, the subsequent commas were not recognized as cell separators, and the entire row was collapsed into 1 single token (`row.length = 1`). Since the parser requires `row.length >= 2`, Question 29 was skipped!

### B. The Solutions
1. **RFC 4180 Double-Quotes-Only CSV Tokenizer**:
   Updated `parseCSVLines()` so that ONLY double quotes (`"`) toggle `inQuotes`. Single quotes (`'`) are preserved as standard English apostrophes (`body's`, `cell's`, `Benedict's`, `let's`).
2. **Native 2D Array Ingestion for `.xlsx` / `.xls` Files**:
   Updated `parseExcelOrCSVFile()` to use SheetJS `XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })` which parses the binary Excel cells directly into native JavaScript 2D arrays, bypassing text serialization issues completely.
3. **Stricter Header Matcher**:
   Updated header detection so that words with the letter `'q'` (e.g. `sequence`, `quaternary`, `equilibrium`) do not trigger false header detections.

---

## 3. Verification & Build Results
- **Automated XLSX & CSV 30-Question Ingestion Test**: ✅ **30/30 Questions Parsed (including Question 29 `body's` with 100% correct Green answer key)**.
- **TypeScript Typecheck (`npx tsc --noEmit`)**: ✅ **0 Errors**
- **Next.js Production Build (`npm run build`)**: ✅ **28/28 Routes Cleanly Built**
