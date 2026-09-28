# Changelog

All notable changes to Preflight are documented in this file: the VS Code extension and the
JetBrains plugin share their version and this changelog (shipped in the `.vsix`, and as the change
notes of the plugin).
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-09-28

### Added

- **JetBrains plugin** for IntelliJ IDEA, PyCharm and the other JetBrains IDEs (2025.1 and later): the
  same viewer in a **Preflight** tab next to the text editor of Terraform states and of
  `terraform show -json` output, with **View as Terraform Plan** / **View as Terraform State**
  (project view, editor tab, Tools menu), including *Read with terraform show -json*.

### Changed

- **Graph** tab: layouts are computed in the background (Web Worker) as soon as a plan is opened, for
  every layout option, so switching between them is instant and the view never freezes; layout and link
  routing also take about a third less time, with the same result.
- Computed layouts are kept between sessions: reopening a plan already seen shows its graph at once.

### Development

- Repository split into `core/` (parsers, graph, viewer page), `vsc/` (VS Code extension) and
  `jetbrains/` (IntelliJ Platform plugin, Gradle), with a pnpm workspace.
- `make dist` builds both packages into `build/`; `make install` / `make install-jetbrains` install them;
  `make version V=x.y.z` sets the version of both and releases this changelog section.
- Test environments: core unit tests (mocha), VS Code integration tests, JetBrains unit and platform
  tests, sandbox IntelliJ IDEA / PyCharm (`make jb-run`, `make jb-run-pycharm`), Plugin Verifier.

## [0.1.0] - 2026-09-27

First public release.

### Added

- Plan viewer for `terraform show -json` output: summary, filters by action, per-resource
  attribute diff (unified or split), collapsible blocks, line numbers, "hide unchanged".
- Support for `create`, `update`, `replace`, `delete`, `read`, `forget` and `no-op` actions,
  `(known after apply)` values, sensitive values, `moved` and deposed objects.
- JSON strings (IAM policies…) expanded inside `jsonencode( … )` and diffed key by key.
- State viewer for `terraform.tfstate` (v4) and `terraform show -json` states, including remote
  backends through `terraform show -json`.
- **Graph** tab: IAM access graph (roles, trust policies, identity and resource policies,
  permission boundaries, SCPs) with effective permissions per node.
- AWS service icon next to each resource.
