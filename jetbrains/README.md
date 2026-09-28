# Preflight for JetBrains IDEs

IntelliJ Platform plugin: the Preflight viewer in IntelliJ IDEA, PyCharm and the other JetBrains
IDEs (2025.1 and later). Same page as the VS Code extension — parsers, diff, IAM graph and AWS icons
come from [`../core`](../core) — hosted in the IDE's embedded browser (JCEF).

## Usage

- A `*.tfstate` / `*.tfstate.backup` file, or a JSON file produced by `terraform show -json`, gets a
  **Preflight** tab next to its text editor (bottom of the editor).
- **View as Terraform Plan** (project view, editor tab context menu, **Tools** menu or *Find Action*):
  opens any JSON file in Preflight, or asks for one.
- **View as Terraform State**: opens the selected state, or offers the states of the project, a file from
  disk, or **Read with terraform show -json…** in a Terraform folder (works with remote backends).
- The view follows the file (regenerated plan, edits in the text tab). Settings (gear at the bottom right
  of the page) are shared by every Preflight tab.

## How it works

```
PreflightFileEditor ── JCEF browser ── https://preflight.local/index.html  (served from the plugin jar)
       │                                  core/media/viewer.html + preflight-core.js + jetbrains-host.js
       │  executeJavaScript: PreflightHost._load({ path, modulesJson, settings })
       │◀─ JBCefJSQuery:     ready / settings / openExternal / loadLayouts (answered) / saveLayout
       └─ resource handler:  /__source → text of the file (the page builds the model with PreflightCore)
```

The graph layouts are computed in the page by a Web Worker (`core/media/graphLayout.js`, allowed by
`worker-src blob:`), and kept between sessions by
[`LayoutCache`](src/main/kotlin/io/github/theosylvestre/preflight/LayoutCache.kt): one JSON file per layout
in `<IDE system dir>/preflight/layouts`, the least recently used removed beyond 200.

- [`PreflightEditorProvider`](src/main/kotlin/io/github/theosylvestre/preflight/PreflightEditorProvider.kt):
  which files get the tab (`PLACE_AFTER_DEFAULT_EDITOR`), and `open()` for the actions.
- [`PreflightView`](src/main/kotlin/io/github/theosylvestre/preflight/PreflightView.kt): the browser,
  its resource handler, the bridge, reloads on document / VFS changes.
- [`PreflightWeb`](src/main/kotlin/io/github/theosylvestre/preflight/PreflightWeb.kt): packaged page files,
  page template filling and content security policy.
- [`jetbrains-host.js`](src/main/resources/preflight-web/jetbrains-host.js): page side of the bridge; gives
  `viewer.js` the API of the VS Code webview (`postMessage`, `getState`, `setState`).
- [`TerraformShow`](src/main/kotlin/io/github/theosylvestre/preflight/TerraformShow.kt): *Read with terraform
  show -json*, run in the background, output saved in the IDE system folder.

The build copies `../core/media` and the bundle `../core/dist/preflight-core.js` (built with Node.js by the
`buildCoreBundle` task) into the plugin resources (`webResources` task): edit them in `core/`, not here.

## Development

Requirements:

- a JDK 17+ to run Gradle — `make jb-*` at the root uses `JAVA_HOME`, or the runtime bundled with
  IntelliJ IDEA on macOS. The JDK 21 used to compile is downloaded by Gradle if missing;
- Node.js 22+ and `pnpm install` at the root (esbuild, for the core bundle).

Open **this folder** (`jetbrains/`) in IntelliJ IDEA as a Gradle project: the run configurations of
[`.run/`](.run/) are then available.

| Run configuration | Gradle task | `make` at the root | What it does |
|---|---|---|---|
| Run IDE with Plugin | `runIde` | `make jb-run` | Sandbox IntelliJ IDEA 2025.1 with the plugin, opened on [`tf-test/`](../tf-test/) |
| Run PyCharm with Plugin | `runPyCharm` | `make jb-run-pycharm` | Same in PyCharm 2025.1 |
| Run Tests | `check` | `make jb-test` | All the tests below |
| Verify Plugin | `verifyPlugin` | `make jb-verify` | IntelliJ Plugin Verifier against the recommended IDEs |
| — | `buildPlugin` | `make jb-build` | `build/distributions/preflight-jetbrains-<version>.zip` |

To try the plugin in an IDE installed on the machine rather than a downloaded one, set
`localIde=/Applications/IntelliJ IDEA.app` in `~/.gradle/gradle.properties` (or pass
`-PlocalIde=…`) and run `./gradlew runLocalIde`. The sandbox IDEs keep their settings in
`build/idea-sandbox/`; the debugger attaches to them when the run configuration is started with *Debug*.

### Tests

- `src/test/kotlin`, JUnit (`./gradlew test`):
  - plain unit tests: file recognition, JSON escaping, packaged page and its CSP, URL → resource mapping,
    layout cache (keys checked, corrupted files skipped, least recently used removed);
  - platform tests (`BasePlatformTestCase`, headless IDE): editor provider registration and file
    acceptance, opening a file in the Preflight tab, action visibility in context menus.
    JCEF is disabled in tests (`ide.browser.jcef.enabled=false`): the editor shows its fallback message
    there, and the page is tested apart.
- `src/test/js`, Node.js test runner (`./gradlew testWebHost`): `jetbrains-host.js` with the real core
  bundle — message queue until the plugin connects, file loading, errors, concurrent reloads, settings,
  layout cache requests.
- The parsers, graph and view model are tested in [`../core/test`](../core/test) (`pnpm test` at the root).

### Publishing

`./gradlew signPlugin publishPlugin` with a JetBrains Marketplace token and a signing certificate,
passed as environment variables: `PUBLISH_TOKEN`, `CERTIFICATE_CHAIN`, `PRIVATE_KEY`,
`PRIVATE_KEY_PASSWORD` (see the `signing` and `publishing` blocks of `build.gradle.kts`).
