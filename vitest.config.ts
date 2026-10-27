import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // 화면 테스트는 파일 맨 위에 `// @vitest-environment jsdom` 을 둔다.
  },
});
