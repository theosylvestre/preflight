import globals from "globals";

export default [{
    ignores: ["**/.vscode-test/**", "**/dist/**", "vsc/media/**", "jetbrains/build/**", "jetbrains/.intellijPlatform/**"],
}, {
    files: ["**/*.js"],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
        },

        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "no-const-assign": "warn",
        "no-this-before-super": "warn",
        "no-undef": "warn",
        "no-unreachable": "warn",
        "no-unused-vars": "warn",
        "constructor-super": "warn",
        "valid-typeof": "warn",
    },
}, {
    files: ["core/media/**/*.js"],
    languageOptions: {
        sourceType: "script",
        globals: {
            ...globals.browser,
            acquireVsCodeApi: "readonly",
        },
    },
}];