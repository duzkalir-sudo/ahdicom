# Hand-over report — <milestone(s)> — <YYYY-MM-DD>

## 1. Summary
3–5 sentences: what was built, what state it is in, what is not done.
**OS actually run on:** <e.g. Windows 11 x64 (local)>. **CI:** <green run link | not run — reason>.

## 2. Feature status
| Feature | Status (Done / Partial / Not started / UNVERIFIED) | Evidence (test name, command excerpt, screenshot path) |
|---|---|---|

## 3. Verification results
| Protocol step | Result | Notes |
|---|---|---|
| Self code review | | |
| `npm run typecheck` | | |
| `npm run lint` | | |
| `npm run license:check` | | |
| `npm audit --audit-level=high` | | |
| `npm run test` | | |
| `npm run test:e2e` | | |
| Built app run manually | | |
| Screenshot inspection | | |
| Performance / memory | | |
| CI matrix (Windows, macOS) | | |
| Verifier subagent | PASS / FAIL | final verdict + remaining non-blocking findings |

## 4. Measured performance
| Metric | Target | Measured | Machine / method |
|---|---|---|---|

## 5. Screenshot index
| Path | Description |
|---|---|

## 6. Known issues, limitations, risks
- ...

## 7. Decisions and questions
- Decisions: see `docs/DECISIONS.md` (list ids taken in this milestone).
- Questions for the user: ...

## 8. How to run, test, build
```
npm ci
npm run fixtures
npm run dev        # development
npm run check      # all checks
npm run test:e2e
npm run dist       # installer for the current OS
```
