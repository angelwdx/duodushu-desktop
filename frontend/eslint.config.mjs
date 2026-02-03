import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 忽略第三方 JS 库文件
    "public/**/*.js",
    "public/**/*.mjs",
    "scripts/**/*.js",
  ]),
  // 允许在组件中使用内联样式（PDF 阅读器中的动态定位需要）
  // 注意：react/no-inline-styles 全局禁用，因为 PDFReader 组件需要大量内联样式进行动态定位
  // 如果其他组件不需要内联样式，应在这些组件中避免使用
  {
    rules: {
      "react/forbid-component-props": "off",
      "react/no-inline-styles": "off",
      "@next/next/no-css-tags": "off",
      "react-hooks/set-state-in-effect": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
]);

export default eslintConfig;
