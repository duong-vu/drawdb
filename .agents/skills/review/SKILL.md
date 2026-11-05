---
name: review
description: Review a change for bugs before it merges
---

1. Read the diff and the code around each change to understand its intent.
2. Look for logic errors, unhandled edge cases, and broken callers.
3. Check that the change follows the repository's existing conventions.
4. Run the linter and build to catch errors the diff alone does not show.
5. Report each problem with its file, line, and a suggested fix.
