/** ~100 m grid: lat/lon rounded to 3 decimal places. */
export function toCell(lat: number, lon: number): string {
  return `${round3(lat)},${round3(lon)}`;
}

function round3(n: number): string {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}
