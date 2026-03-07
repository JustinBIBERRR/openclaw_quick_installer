# Changelog

All notable changes to the OpenClaw Installer for Windows are documented in this file.

## [1.3.0] - 2025-03-07

### Added

- **Feishu/Lark integration**: App ID and App Secret inputs with connectivity validation; config is persisted and passed to OpenClaw onboarding.
- **Unified config panel**: Single comprehensive configuration step combining API keys, Feishu credentials, daemon/channel, skills, hooks, and launch mode.
- **Manager-first flow**: Installed users are routed directly to the Manager instead of the wizard.
- **Manager enhancements**: Grouped actions (Common / Maintenance / Dangerous), config panel entry, and "Start and open Chat" shortcut.
- **UX test docs**: `UX_TEST_CHECKLIST.md` and `UX_TEST_REPORT_TEMPLATE.md` for QA.

### Changed

- **Wizard flow**: Reduced from 5 steps to 4 (syscheck → installing → comprehensive config → launching).
- **UI refresh**: Slate backgrounds, blue brand theme (coolBlue/brightBlue presets), updated StepBar and Manager styling.
- **Onboarding**: Extended to accept Feishu credentials and write them into OpenClaw config.

### Fixed

- **Step 3 white screen / freeze**: Resolved long unresponsive period during onboarding.
- **Gateway bind error**: Removed `--gateway-bind loopback` that caused "Bind: loopback" and onboarding failure.
- **Config file / doctor --fix**: Addressed post-Feishu config issues that triggered config file errors.

---

[1.3.0]: https://github.com/JustinBIBERRR/openclaw_quick_installer/releases/tag/v1.3.0
