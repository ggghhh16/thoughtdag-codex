# Desktop development and packaging

Run commands from the repository root. Install Node.js 22.12+ and authenticate Codex on the same operating-system account that runs the app.

```bash
npm ci
npm --prefix desktop ci
npm run desktop
```

The desktop shell adds native project selection, local Codex task import, and a stable local storage origin. It binds to `127.0.0.1:31173`; it refuses to start if another application owns that port.

## Build an installer

Build on the target operating system. For Windows x64:

```bash
npm run build
npm --prefix desktop run dist:win
```

For Linux x64 use `dist:linux`; on macOS use `dist:mac:x64` or `dist:mac:arm64`. Outputs are written to `desktop/out/` and are not committed. Packaging downloads platform-specific runtime dependencies from npm. Windows also uses the .NET Framework C# compiler to build the hidden-console launcher.

The payload includes only the built frontend, server modules, selected production dependencies, and license notices. It must not contain `.env`, Codex credentials, user configuration, conversations, or `codex-project.json`.

Signing and macOS notarization require the maintainer's own credentials. Never reuse upstream's release/update configuration or describe unsigned artifacts as signed. Automatic desktop updating is disabled until a trusted release feed is configured. A source/build check does not certify a newly packaged installer; inspect and test each distributed artifact separately.
