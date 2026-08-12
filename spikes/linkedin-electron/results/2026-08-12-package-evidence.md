# U0 packaged-app evidence — 2026-08-12

This record contains only non-sensitive build and fixture-smoke evidence. It is
not a completed compatibility matrix and does not authorize U1-U8.

- Source commit: `054f03c`
- Host: macOS 26.5.2 (25F84), arm64
- Electron: 43.4.0
- Artifact: `dist/mac-arm64/Village LinkedIn Compatibility Spike.app`
- Packaged `app.asar` SHA-256: `04245fb8d4a42e1981b92bdd19ff96557228fccf925b24105b0395946301c727`
- Signature check: `codesign --verify --deep --strict` passed
- Entitlements observed: JIT, unsigned executable memory, and library-validation
  exception for the ad-hoc signed internal spike
- Owned loopback fixture: packaged app launched and remained running until the
  operator terminated it
- LinkedIn debugger/CDP attachments: 0
- Autonomous LinkedIn actions: 0
- Credential or cookie logging events: 0

Human LinkedIn sign-in, route classification, Chrome comparison, challenges,
failure rates, and three-restart retention remain pending.
