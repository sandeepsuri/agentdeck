# Mac app distribution and recovery

Issue #84 packages the existing AgentDeck service and browser workspace in a standalone Mac app. The app opens a WebKit window, starts the service on `127.0.0.1:4040`, monitors `/api/health`, and launches the existing menu bar companion through that service. The packaged service skips the optional Tailscale listener. CLI installs keep their existing remote behavior.

## Build and signing

- Build on macOS 13 or later, separately on Apple Silicon and Intel, with Xcode command line tools and the Node version used to install the native npm modules. Run `npm ci` followed by `npm run package:mac` for an ad hoc signed local test package. The output is `dist/mac/AgentDeck.app` and `dist/mac/AgentDeck-<architecture>.zip`.
- For distribution, install a valid **Developer ID Application** certificate in the build keychain and create a `notarytool` keychain profile with Apple team credentials. Set `AGENTDECK_SIGN_IDENTITY` to the full certificate identity and `AGENTDECK_NOTARY_PROFILE` to the profile name, then run `npm run package:mac:release`.
- The release script signs native modules, the embedded Node runtime with its JIT entitlements, the menu bar companion, and the outer app with hardened runtime. It verifies the signature, submits a ZIP to Apple notarization, staples the ticket to the app, assesses it with Gatekeeper, and creates the final install ZIP. Keep the signing certificate and notary credentials out of the repository.
- Release separately for `arm64` and `x64` on matching build hosts. The embedded Node executable and `better-sqlite3`/`node-pty` native modules must share the same architecture and Node ABI. Never substitute a build from a different Node installation after packaging.

## Clean-account demo and release gate

Use a fresh standard macOS account with no Node, Git, Tailscale, npm, shell profile, or AgentDeck data. Test the **release** ZIP, not the ad hoc package.

1. Download the ZIP through a browser, expand it in Finder, move `AgentDeck.app` to Applications, and open it normally. Check that Gatekeeper accepts it without an override, the workspace renders, and the menu bar companion appears. Check that `lsof -nP -iTCP:4040 -sTCP:LISTEN` shows only `127.0.0.1`.
2. Quit and reopen AgentDeck. Check that it starts the service, opens the workspace, and retains settings and history.
3. Restart the Mac, sign in, open AgentDeck from Applications, and repeat the health, workspace, and companion checks.
4. Exercise repair by occupying port 4040 before launch, or by temporarily removing the bundled service from a disposable local test copy. Verify the app shows the failure reason and **Repair Startup**, **Open Service Log**, and **Open Data Folder**. Free the port or restore the package, select Repair Startup, and verify recovery. Do not modify the signed release copy for Gatekeeper testing.
5. Inspect the app with `codesign --verify --deep --strict --verbose=2 /Applications/AgentDeck.app`, `spctl --assess --type execute --verbose=4 /Applications/AgentDeck.app`, and `xcrun stapler validate /Applications/AgentDeck.app`. Confirm `Contents/Resources/service/dist/ui`, `dist/server`, `dist/native/AgentDeckNotch.app`, `migrations`, and `node_modules` are present.

This clean-account test and Apple notarization require release signing credentials and a separate account. A local ad hoc build verifies assembly and runtime loading, but does not close that release gate.

## Data, update, and removal

The app uses the existing `~/.agentdeck/` data directory and numbered SQLite migrations. On startup, newer builds apply pending migrations. Before updating, quit the app and back up the whole directory, including `agentdeck.db`, `agentdeck.db-wal`, and `agentdeck.db-shm` if present. Replace the app in Applications and reopen it. If an update fails, restore the prior app **and its matching data backup** before reopening; an older binary is not guaranteed to read a newer migrated database. The startup screen links to `~/Library/Logs/AgentDeck/service.log` and the data folder for diagnosis.

To uninstall, quit AgentDeck, move the app from Applications to Trash, and optionally remove `~/Library/Logs/AgentDeck/`. Keep `~/.agentdeck/` if you plan to reinstall; removing it deletes settings, history, credentials, and work records. AgentDeck does not install a launch daemon or modify shell setup. Repository hooks installed separately by the CLI are managed by the existing `agentdeck uninstall-hooks` command and are not removed by deleting the app.
