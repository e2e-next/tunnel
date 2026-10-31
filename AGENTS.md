# AGENTS.md

The guide for coding agents lives at **[assets/AGENTS.md](assets/AGENTS.md)**.

It sits inside the package rather than here so that it ships in the npm
package: from any project, with tunnel installed, `tunnel agents` prints it,
and what it prints is the version that is installed rather than whatever is on
the default branch.

To give an agent working in another project a way in, put one line in whichever
file that agent reads by itself — `CLAUDE.md`, `AGENTS.md`, or its own:

```
Working with tunnel (the local mock proxy)? Run `tunnel agents` first — it prints
the command reference and the handler(ctx) API for the installed version.
```

A line rather than a copy. The guide is 23 KB, so pasting it in puts it in every
prompt whether it is needed or not, and freezes it at the version it was pasted
from.

It is one file, not two: this page is a pointer, so the two can never drift.
