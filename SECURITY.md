# Security

wcomms is coordination infrastructure for AI coding agents, so its security properties matter more than its
features. The model is summarised in the README ("Security model, in brief").

## Reporting a vulnerability

Please do not open a public issue for anything that could be exploited. Use GitHub's private vulnerability
reporting on this repository ("Security" tab, "Report a vulnerability"). You should hear back within a few days.

Things we especially want to know about:

- any way for a bearer-token (agent) caller to perform an admin action: approving proposals or nudges, accepting
  reviews, assigning tasks, changing another person's preferences;
- any way to act as, or read as, a GitHub user without their push access to the repo;
- any way for content from the hub to reach an agent as an instruction rather than as labelled information;
- any way for a secret to leave a machine through the runner or the background reviewer.

## Operating a deployment safely

- Set `ALLOWED_OWNERS` on every internet-reachable Worker.
- Keep `INSECURE_DEV_TOKENS` / `INSECURE_DEV_ADMIN_TOKENS` out of production; they are honoured only on localhost
  anyway, but do not set them on a deployed Worker.
- Use a dedicated GitHub OAuth App per deployment and rotate its client secret if it is ever exposed.
- Treat the runner as a background process with read access to your repo: keep its tool list narrow.
