# Historical baseline archive verification

The following records the prior ZIP. See ISOLATION_TEST_REPORT.md for current archive verification.

# ZIP verification

Validated locally on 2026-09-25 with Node 24.19.0 and npm 11.9.0.

| Check | Result |
|---|---|
| Clean release directory, fresh `npm ci --ignore-scripts --no-audit --no-fund` | PASS |
| Clean release `npm run test:next` | 87 PASS, 0 FAIL, 0 SKIPPED |
| Clean release syntax checks | 236 files PASS |
| Archive integrity / required files / single repository root | PASS |
| Archive excludes node_modules, .git, runtime data, caches, logs and production dumps | PASS |
| Credential filename/pattern review and configuration review | No production credentials found; local fixture values only |
| Extract archive into a new directory and fresh install | PASS |
| Extracted `npm run test:next` | 87 PASS, 0 FAIL, 0 SKIPPED |
| Extracted payment-currency regression | PASS, 11 assertions; local fixture bank accounts |
| Extracted admin integration | PASS; real localhost HTTP and JSDOM |
| Extracted startup/source smoke | PASS |

The new journey suite starts the actual web process, checks public/private/admin flows, verifies bank-transfer price and payment-state controls, and confirms web survival after worker failure. No separate frontend build is required.

Existing regression chain was also rerun on final source: 100 command checks PASS, 1 legacy FAIL, 1 prohibited-commit SKIPPED. See TEST_REPORT.md for exact command list and reasons. These command totals are not individual test-case totals.

No deployment, Git mutation, production migration, real payment, real message or external account modification was performed. This archive is a local foundation with explicit PARTIAL components, not a claim of complete live implementation support.
