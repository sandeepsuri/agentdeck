# 13: Reflowed session view on mobile

**What to build:** On a phone, a managed session's output is readable as reflowing text sized to the screen, rather than a fixed-width grid letterboxed down to something unreadable.

The rendering runs only while a remote viewer is actually watching that session, and the desktop terminal is left exactly as it is.

**Blocked by:** 05 (Tailscale token authentication) — a phone must be able to reach the workspace; 09 (Persist and compact output) — reuses the same conversion that produces readable scrollback

**Status:** ready-for-agent

- [ ] Output is legible on a phone without pinch-zooming or horizontal scrolling
- [ ] The view updates as the session produces output
- [ ] The desktop terminal is unchanged
- [ ] Rendering runs only while a remote viewer is watching that session, and stops when they leave
- [ ] No rendering work happens when no remote viewer is connected
