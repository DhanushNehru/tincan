import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", ".test-dist/**", "node_modules/**", "scripts/**", "examples/**"] },
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-explicit-any": "error", eqeqeq: "error" } },
);
