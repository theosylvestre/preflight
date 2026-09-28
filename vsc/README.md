# Preflight — Terraform Plan Viewer for AWS

[![CI](https://github.com/theosylvestre/preflight/actions/workflows/ci.yml/badge.svg)](https://github.com/theosylvestre/preflight/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/theosylvestre/preflight/blob/main/LICENSE)

Review Terraform plans and states of AWS infrastructure without scrolling through `terraform plan`
output. Preflight is a VS Code extension that opens the JSON output of `terraform show -json` as a plan
summary with filters by action, an attribute-by-attribute diff for each resource (unified or split view),
and a graph of who can access what through IAM.

![Demo](https://raw.githubusercontent.com/theosylvestre/preflight/main/assets/demo.gif)

## Installation

Install **Preflight** from the VS Code Marketplace, or build it from source, at the root of the
[repository](https://github.com/theosylvestre/preflight):

```sh
pnpm install
make install   # packages the .vsix and installs it in VS Code
```

## Requirements

- VS Code 1.138 or later.
- Terraform 0.12 or later, to produce `terraform show -json` output (plans or states).
  Terraform is only needed on your machine for the **Read with terraform show -json** state command.

## Usage

```sh
terraform plan -out=tfplan.bin
terraform show -json tfplan.bin > tfplan.json
```

Then, on `tfplan.json`:

- right-click in the explorer → **View as Terraform Plan**;
- or the preview icon in the editor title bar;
- or **Open With… → Preflight — Terraform Plan & State Viewer (AWS)**;
- or the **Preflight: View as Terraform Plan** command (file picker if no JSON file is open).

### States

**Preflight: View as Terraform State** opens a state in the same viewer (read-only attributes, sensitive
values masked, Graph tab included):

- right-click a `*.tfstate` / `*.tfstate.backup` file → **View as Terraform State**, or **Open With… → Preflight — Terraform Plan & State Viewer (AWS)**;
- from the command palette: pick a state file found in the workspace, browse for one, or
  **Read with terraform show -json** to load the current state of a Terraform folder (works with remote backends).

Both the raw `terraform.tfstate` (v4) and the `terraform show -json` state format are supported. A state has
no `configuration` section, so graph references are inferred from values (an attribute equal to another
resource's ARN / id / name, `s3://bucket/…` URLs) and completed with the dependencies recorded in the state.

The view refreshes when the file is regenerated. Shortcuts: `j` / `k` to move to the
next / previous resource.

### Supported plan features

- `create`, `update`, `replace` (with the attribute forcing the replacement), `delete`,
  `read` (data sources, shown as neutral lines), `forget` and `no-op` actions;
- `(known after apply)` from `after_unknown`, masked values from `*_sensitive`;
- nested blocks, maps, lists (set-based diff for lists of scalars);
- JSON strings (IAM policies…) expanded inside `jsonencode( … )` and diffed key by key;
- collapsible blocks, optional line numbers, "hide unchanged";
- action reason (`action_reason`), `moved`, deposed objects;
- AWS service icon next to each resource.

### Graph tab

The **Graph** tab shows access the way AWS models it, and nothing else:

```
resource ──runs as──▶ role ──uses policy──▶ policy ──allows (actions, conditions)──▶ resource
principal ──can assume──▶ role          user ──member of──▶ group ──uses policy──▶ policy
principal ──boundary──▶ policy          (permissions boundary / SCP: caps, never grants)
```

- *Runs as*: a resource using an IAM role (`role`, `role_arn`, `execution_role_arn`…, or an EC2
  `iam_instance_profile`), from references or from the role ARN value.
- *Can assume*: the principals of the role's trust policy.
- *Uses policy*: policies are nodes — customer policies, inline policies (`aws_iam_role_policy`,
  `inline_policy`), AWS managed policies, and resource policies (S3, SQS, SNS, KMS, ECR, Secrets
  Manager, API Gateway, OpenSearch, EventBridge, EFS, Backup, CloudWatch Logs, Glue, DynamoDB, Kinesis,
  VPC endpoints, CodeArtifact, Glacier, `aws_lambda_permission`…) used by the principals they name.
- *Allows*: what a policy allows on which resource, with its actions (`Deny` in red), its conditions
  and `NotResource` exceptions. Wildcard ARNs (`arn:aws:s3:::logs-*/*`) are matched against every
  resource of the project.
- *Member of* / *Boundary*: group membership, permissions boundaries and service control policies.

References passed through module variables and outputs are followed. Anything only referenced — an ARN
or an IAM role / user / group name — is recognised from its ARN (service, type, account) and shown,
dimmed, in an **External to project** frame, with the same logic applied. The only thing not interpreted
is the content of AWS managed policies, which is not part of a plan.

Clicking a node shows its role, groups, policies, boundaries and effective permissions (including those
inherited from its role or groups), or, for a target resource, who can access it and through which policy.
The eye on a node, or on a frame header for all of its resources at once, hides their links.

## Development

See the [repository README](https://github.com/theosylvestre/preflight#readme): the extension lives in
`vsc/`, the parsers and the viewer page it is built from in `core/`.

## Credits

AWS service icons come from the [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) pack.
Preflight is an independent project, not affiliated with or endorsed by Amazon Web Services or HashiCorp.

## License

[MIT](https://github.com/theosylvestre/preflight/blob/main/LICENSE)
