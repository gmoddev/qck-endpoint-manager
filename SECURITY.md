# Security Policy

## Supported version

Security fixes target the latest release on the default branch.

## Reporting a vulnerability

Please do not open a public issue for an unpatched vulnerability. Use GitHub's private vulnerability reporting feature on this repository when available, or contact the repository owner privately through their GitHub profile.

Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not include real OAuth secrets, session cookies, database contents, or private workspace files.

## Security boundaries

- The management hostname must remain separate from the public-content hostname.
- Only the configured OAuth user ID may receive a management session.
- Mutating workspace operations require both a valid session and CSRF token.
- Workspace paths must remain confined to their configured static-site directory.
- Recovery history, environment files, databases, and Docker control interfaces must never be publicly served.
- The application port is expected to be reachable only by the reverse proxy or another trusted private network.
