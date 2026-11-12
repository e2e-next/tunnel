# The panel

📖 [中文](zh-CN/panel.md)

<http://127.0.0.1:8000/> is one page, a React app built ahead of time, and
nothing is loaded from the internet: `make panel` writes
`assets/panel/panel.js`, `assets/panel/panel.css` and
`assets/panel/panel-InterVariable-latin.woff2`, and all three are committed,
so installing builds nothing and the panel comes up with the Wi-Fi off.

The sidebar holds the five pages, and with them everything that is true of the
whole run rather than of one page: the session switcher at its head; under
**This run** the default mode (**Live** or **Replay**, `tunnel mode`, with the
count of unmatched calls while replaying) and the record button
(`tunnel record`); and in its footer the proxy address a device needs, the
version, and a dot that goes grey and says `reconnecting…` when the event
stream drops. ⌘K reaches every page, both switches, every session and every
rule by key.

**Traffic** is the log as it arrives, over Server-Sent Events: the calls in a
list, one row each, and the one clicked in a pane beside it — the overview, what
answered it, then the request and the response with their headers and bodies (a
dialog rather than a pane when the window is too narrow for both). Search by
host, path, query, status or the rule that answered; narrow to one host, one
method or one status class, to **Unmatched** or to **Encrypted** rows; tick
**Search bodies** and the search goes to the server, which is where the bodies
are. **Pause** freezes the list while the run goes on underneath, **Clear**
empties the log, and every row has a menu: Open, **Mock this**, **Copy as
curl**, **Copy key**, only this host, the rule that answered — and **Decrypt
this host** for a tunnel nobody decrypted.

**Rules** lists every rule with its mode, status code, hit count and an on/off
switch, and a click opens it with every field it takes: the key — in three parts
while the rule is new, read-only afterwards, since a different endpoint is a
different rule — then the mode with only that mode's fields (a JSON body, a
JavaScript handler, a session and a strategy, or a target to forward to), the
status code, the delay, extra headers, a fault to inject, and a note for
whoever reads the rule next. New rule, Duplicate, Delete and Reset state are
`tunnel set`, `tunnel rm` and `tunnel reset` from here; a whole set at once
stays with `tunnel apply` and `tunnel export`.

**Recordings** lists the sessions on disk with how many recordings each holds,
which one this run is using and how long ago it was recorded into; a session
opens to the calls recorded into it, and a click opens one in full. A session is
made current, recorded into or deleted from here — `tunnel session`,
`tunnel record` and `tunnel recordings rm` — while export and import stay on the
command line.

**Connect a device** walks a device in, three steps, each ticked from the log
rather than from the page: the proxy addresses to set, one per network
interface, each with a copy button; the certificate — the `/ca.pem` download,
the `http://ca.tunnel/` page for the device, the fingerprint to check against
it, and the iOS and Android steps; and what to decrypt — the SSL proxying
switch, the include and exclude lists, and the hosts recently tunnelled through,
each with a **Decrypt** button (`tunnel ssl add`). Every client that has spoken
to the proxy is listed below, with when it was last seen.

**Settings** is what is set once: the default mode and the replay marker, how
many calls the log keeps and whether every run records itself, the headers
hidden in the log and in recordings, the allowed clients (read here, changed
with `tunnel config`), and where this server keeps its files, with the
certificate's fingerprint and the day it expires.
