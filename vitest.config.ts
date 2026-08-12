import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    // `.tsx` também: a marcação de erro nos formulários é comportamento, e o
    // jeito de travá-la é renderizar o componente (`renderToStaticMarkup`, sem
    // DOM nem biblioteca de teste nova).
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
