# Getting AutonomOS to actually earn

Run `npm run earning-preflight` at any time. It checks the real earning lane against the
real environment and names the exact action for anything that blocks income. Everything
below explains what that report is checking and why.

## What can earn, and what cannot

**Can earn: GitHub bounties (Algora, Opire, IssueHunt).** These platforms exist so that
anyone can solve a funded issue and be paid, usually in USDC. Automated participation is
permitted, the payment is real crypto, and the whole lane is implemented here:
`free-revenue-global-work-hunter.js` searches the public GitHub API for funded issues,
`github-application.js` posts the claim comment, `accepted-job-engine.js` does the work,
`verified-github-pr.js` opens a pull request only after proving the tests pass on the fix
and fail on the base commit, and `github-job-monitor.js` watches for the merge and the
payment.

**Can earn: direct clients.** The Stripe checkout on the site is live and its revenue now
reaches the ledger, the 50/50 split, and the agents' spend pool.

**Cannot earn as things stand: the freelance marketplaces.** Upwork, Freelancer, Guru,
PeoplePerHour, Workana, Contra, Truelancer and the rest are all marked
`AUTOMATION_FORBIDDEN` with blocker `authenticated_account_and_policy_required` in
`dynamic-market-registry.json`. That is not a missing feature to be written. Those
platforms' terms require a real identified account holder and prohibit automated signup and
bot-submitted work. Building around that would mean building terms-of-service evasion, and
accounts created that way get banned and payouts withheld. The honest options are to use
them yourself with your own account, or to leave them alone.

**Cannot happen automatically: sending crypto out.** This system receives crypto and reads
balances. It holds no private key and there is no signing library here, so it cannot move
funds off your wallets. That is a deliberate safety property, not a gap.

**Cannot happen automatically: fiat to crypto.** `fiat-crypto-route-planner.js` plans the
route and lists what needs your decision; it never initiates a bank or exchange trade.
Converting fiat requires an identified account at a regulated on-ramp, which is yours.

## The honest cost of "free"

Agents can find and claim work for free. They cannot *do* it for free: solving an issue
means LLM calls, and running the tests means a sandbox. Both cost money.

This is why the spend pool exists, and why a cold start deadlocks without you: every
attempt books a cost, executors refuse to start at zero, and a job has to complete to earn
the revenue that would refill the pool. The seed float is capped at $50 on purpose, because
it is unearned spending. Use **Fund agent treasury** on the dashboard to record real
working capital; it writes an auditable `owner_funding` row and counts in full toward the
agents' half.

Budget roughly $25–50 to start. A single solved bounty typically pays more than that.

## What to set

| Variable | Why it is needed |
| --- | --- |
| `AUTONOMOS_ENABLED=true` | Nothing runs otherwise. |
| `GITHUB_TOKEN` | `public_repo` scope. Without it search is capped at 10 requests/minute and no claim comment or pull request can be posted at all. |
| `OPENAI_API_KEY` | The model calls that solve the issue. |
| `E2B_API_KEY` | The sandbox that runs the tests. No sandbox means no verified PR, so the lane stops before delivery. |
| `AUTONOMOS_OWNER_WALLET` | Your EVM address. Receives USDC on Base, Ethereum, Arbitrum, Polygon. |
| `AUTONOMOS_PHANTOM_WALLET` | Your Solana address. TaskForce settles USDC on Solana; without this those jobs are refused before they are claimed. |

## The step no code here can do for you

A bounty platform pays **the GitHub account that solved the issue**, into the wallet
connected to that account on *their* site. Nothing in this repository can read or set that.

Sign in to Algora / Opire / IssueHunt with the same GitHub account whose token you set
above, and connect your wallet there. Without it a merged pull request earns nothing, and
the system has no way to detect the omission — `earning-preflight` marks this `??` rather
than pretending to have checked it.

## What to expect

The preflight going green means every precondition this system can verify is satisfied. It
is not a forecast. Whether a given bounty is won depends on the quality of the patch and on
the maintainer merging it. Expect attempts that cost money and earn nothing; that is what
the profit gate and the spend cap are for.
