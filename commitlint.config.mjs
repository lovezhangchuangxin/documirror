export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-empty": [2, "never"],
    "scope-enum": [
      2,
      "always",
      [
        "repo",
        "docs",
        "cli",
        "core",
        "crawler",
        "parser",
        "i18n",
        "shared",
        "site-builder",
        "templates",
        "adapters-filequeue",
      ],
    ],
  },
};
