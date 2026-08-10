export type ExportFormat = 'csv' | 'json';

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function escapeCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCSV(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return lines.join('\n');
}

export function downloadCSV(filename: string, rows: Array<Record<string, unknown>>) {
  const blob = new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8;' });
  downloadBlob(blob, filename);
}

export function downloadJSON(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });
  downloadBlob(blob, filename);
}

export function exportData(format: ExportFormat, filename: string, data: unknown) {
  if (format === 'csv') {
    const rows = Array.isArray(data) ? data : (data as { rows?: unknown[] }).rows;
    const rowsArray = Array.isArray(rows)
      ? rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      : [];
    downloadCSV(filename, rowsArray);
  } else {
    downloadJSON(filename, data);
  }
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
