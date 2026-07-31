# remote-runner

Automatic execution of repository-defined workloads on a trusted remote workstation.

The project is currently in design. Ariadne is the first pilot: its full verification command will
run on a Tailscale-connected Linux workstation when healthy and fall back locally with a Telegram
alert when remote execution is unavailable.

The canonical design is
`docs/specs/2026-07-31-remote-runner-design.md`.
