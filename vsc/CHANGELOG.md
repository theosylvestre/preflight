# Changelog

All notable changes to this extension are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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
