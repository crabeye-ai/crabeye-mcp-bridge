import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "coverage/", "test/fixtures/", "test/_helpers/"],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "*.config.ts",
            "*.config.mjs",
          ],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
