import { bootstrapProblemBadge } from './ui/problemBadge';

console.log(
  `%c[YRPR] loaded · build ${__BUILD_TIME__}`,
  'color:#bfa640; font-weight:600',
);

function route(): void {
  const path = location.pathname;

  if (
    /\/contest\/\d+\/problem\/[A-Za-z]/.test(path) ||
    /\/problemset\/problem\/\d+\/[A-Za-z]/.test(path) ||
    /^\/contest\/\d+\/?$/.test(path)
  ) {
    void bootstrapProblemBadge();
  }
}

route();
