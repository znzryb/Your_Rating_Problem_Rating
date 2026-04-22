import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

const BUILD_TIME = new Date().toISOString();

export default defineConfig({
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'Your Rating · Problem Rating',
        namespace: 'https://github.com/znzryb/Your-Rating-Problem-Rating',
        // Surface the build time in the userscript header so it's visible in Tampermonkey
        // dashboard without having to open the file.
        description: `Codeforces userscript: Carrot-style rating delta + reverse-Elo problem rating.  [build ${BUILD_TIME}]`,
        author: 'znzryb',
        match: [
          'https://codeforces.com/contest/*',
          'https://codeforces.com/contest/*/standings*',
          'https://codeforces.com/contest/*/problem/*',
          'https://codeforces.com/problemset/problem/*',
        ],
        connect: ['codeforces.com'],
        grant: [
          'GM_getValue',
          'GM_setValue',
          'GM_deleteValue',
          'GM_xmlhttpRequest',
        ],
        'run-at': 'document-end',
      },
      build: {
        fileName: 'your-rating-problem-rating.user.js',
      },
    }),
  ],
});
