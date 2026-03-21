import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    extends: [eslint.configs.recommended],
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
