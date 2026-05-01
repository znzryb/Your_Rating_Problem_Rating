export const SPOILER_KEY = 'yrpr:spoiler-mode';

export function isSpoilerEnabled(): boolean {
  try {
    return localStorage.getItem(SPOILER_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function spoilerCss(): string {
  return `
    .inner.spoiler:not(:hover) {
      color: transparent !important;
      border-color: transparent !important;
      background-color: rgba(128,128,128,0.18) !important;
      transition: color .15s, border-color .15s, background-color .15s;
      cursor: help;
    }
    .inner.spoiler:hover {
      transition: color .15s, border-color .15s, background-color .15s;
    }
  `;
}

export const SPOILER_HINT =
  '\n\n（防剧透模式：hover 显示 rating；关闭：localStorage.setItem("yrpr:spoiler-mode","false") 后刷新）';
