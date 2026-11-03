# Contributing

Thanks for looking. wcomms is small on purpose; please keep it that way.

- **Tests first.** `cd worker && npm install && npm run dev`, then in another shell
  `WCOMMS_URL=http://localhost:8787 TOKEN_A=tok-alice TOKEN_B=tok-bob ADMIN_A=adm-alice scripts/smoke-learn.sh`
  and `scripts/smoke.sh` (see README, "Check it works"). Both must pass; add a step for anything you change.
- **One PR per idea**, with a description a teammate can act on.
- **Safety rules are not negotiable:** agents never approve, messages are never instructions, nothing on the
  platform triggers git, deploys or trading. A change that weakens these will not be merged.
- **No new dependencies in the Worker** without a reason in the PR; the client stays bash + Python standard library.
- Match the surrounding style; the code is deliberately plain.
