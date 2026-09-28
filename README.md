# Preflight — Terraform Plan Viewer for AWS

[![CI](https://github.com/theosylvestre/preflight/actions/workflows/ci.yml/badge.svg)](https://github.com/theosylvestre/preflight/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Review Terraform plans and states of AWS infrastructure without scrolling through `terraform plan`
output: the JSON output of `terraform show -json` (or a `terraform.tfstate`) opened as a plan summary
with filters by action, an attribute-by-attribute diff for each resource, and a graph of who can access
what through IAM.

![Demo](assets/demo.gif)

| IDE | Folder | Documentation |
|---|---|---|
| VS Code | [`vsc/`](vsc/) | [vsc/README.md](vsc/README.md) (Marketplace page: usage, supported features, graph) |

## Repository layout

- [`core/`](core/): everything that does not depend on an IDE.
  - [`src/planParser.js`](core/src/planParser.js): turns the JSON plan into diff lines.
  - [`src/planGraph.js`](core/src/planGraph.js): builds the IAM graph (roles, policies, permissions).
  - [`src/stateParser.js`](core/src/stateParser.js): turns a state into a plan-shaped document (inferred references).
  - [`src/viewModel.js`](core/src/viewModel.js): the model the viewer displays (icons, graph groups, module sources).
  - [`src/awsServices.js`](core/src/awsServices.js) + [`media/aws-icons/`](core/media/aws-icons/): AWS service
    icon per resource (official AWS Architecture Icons pack; `make clean-icons` keeps only the 64 px `.svg` files).
  - [`media/`](core/media/): the viewer page (`viewer.html`, `viewer.js` for the plan, `graph.js` for the graph, CSS).
  - [`test/`](core/test/): parser, graph, state and view model unit tests (mocha, no IDE needed).
- [`vsc/`](vsc/): the VS Code extension.
  - [`extension.js`](vsc/extension.js): activation, commands.
  - [`src/planEditor.js`](vsc/src/planEditor.js): read-only custom editor (webview).
  - [`scripts/build.mjs`](vsc/scripts/build.mjs): bundles `core` into `vsc/dist/` and copies `core/media`
    into `vsc/media/` (vsce only packages the extension folder).
  - [`test/`](vsc/test/): VS Code integration tests.
- [`tf-test/`](tf-test/): sample Terraform project with a generated `plan.json`, for trying the extensions.

## Development

Requirements: Node.js 22+ and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm test      # lint, core unit tests and VS Code integration tests
make package   # builds preflight-tf-aws-<version>.vsix at the root
make install   # same, then installs it in VS Code
```

- `F5` ("Run Extension" config): builds the extension and starts a VS Code window with it loaded.
- `make run`: same, without debugger, opened on the sample project [`tf-test/`](tf-test/) and its `plan.json`.
- If the debugger fails to connect to the extension host (`ECONNREFUSED ::1`), use the
  "Run Extension (attach 127.0.0.1)" config instead: it runs `make debug` (inspector on
  `127.0.0.1:9229`) and attaches over IPv4.

## Credits

AWS service icons come from the [AWS Architecture Icons](https://aws.amazon.com/architecture/icons/) pack.
Preflight is an independent project, not affiliated with or endorsed by Amazon Web Services or HashiCorp.

## License

[MIT](LICENSE)
