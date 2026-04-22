// Codeforces rating-tier colors (hex to match the official palette closely).
export function ratingColor(r: number): string {
  if (r < 1200) return '#808080'; // gray — newbie
  if (r < 1400) return '#008000'; // green — pupil
  if (r < 1600) return '#03a89e'; // cyan — specialist
  if (r < 1900) return '#0000ff'; // blue — expert
  if (r < 2100) return '#aa00aa'; // purple — candidate master
  if (r < 2400) return '#ff8c00'; // orange — master / intl master
  return '#ff0000'; // red — grandmaster and above
}

export function deltaColor(d: number): string {
  if (d > 0) return '#008000';
  if (d < 0) return '#cc0000';
  return '#808080';
}
