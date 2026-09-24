import eslint from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "apps/demo/out/**",
      "apps/demo/release/**",
      ".superpowers/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "prefer-const": "off",
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },
  {
    files: ["**/test/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "no-constant-condition": "off",
    },
  },
  {
    files: [
      "packages/rx-bridge-electron/src/{preload,protocol,renderer,testing}/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../main/*", "../../main/*"],
              allowTypeImports: true,
              message:
                "preload/protocol/renderer/testing은 src/main/*을 값으로 import할 수 " +
                "없다(TRP-002: docs/traps/TRP-002-preload-bundle-server-import.md). " +
                "타입만 필요하면 `import type`을 쓴다.",
            },
          ],
        },
      ],
    },
  },
);
