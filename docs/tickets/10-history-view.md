# 10: History view for ended managed sessions

**What to build:** Ended managed sessions leave the session rail after a grace period and remain browsable in a History view.

The case this serves is reopening a session minutes after it died to see what it was doing, so recency is what the rail should reflect.

**Blocked by:** 04 (Keep ended managed sessions) — ended sessions must exist; 09 (Persist and compact output) — History is only useful once there is scrollback to open

**Status:** ready-for-agent

- [ ] An ended session stays in the rail for roughly an hour, then moves to History
- [ ] Restarting the workspace moves ended sessions to History immediately
- [ ] History lists ended sessions with their repository, branch, and when they ran
- [ ] Opening a session from History shows its scrollback
