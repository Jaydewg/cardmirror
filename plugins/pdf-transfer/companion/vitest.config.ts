import { defineConfig } from 'vitest/config';

// Plain Node: everything the companion tests is DOM-free (HTML goes
// through a fake DOM), and Electron is never loaded in tests.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
