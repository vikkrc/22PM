// Project storage. In the browser the "project folder" is the Origin Private File System;
// a native shell can swap this module for real disk access without touching the rest of the app.
async function dir(path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let d = await navigator.storage.getDirectory();
  for (const p of path) d = await d.getDirectoryHandle(p, { create });
  return d;
}
const split = (path: string) => { const parts = path.split('/').filter(Boolean); return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] }; };

export async function writeFile(path: string, data: Blob | ArrayBuffer | string): Promise<void> {
  const { dirs, name } = split(path);
  const fh = await (await dir(dirs, true)).getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data as any);
  await w.close();
}
export async function readFile(path: string): Promise<File | null> {
  try {
    const { dirs, name } = split(path);
    return await (await (await dir(dirs, false)).getFileHandle(name)).getFile();
  } catch { return null; }
}
export async function removeFile(path: string): Promise<void> {
  try { const { dirs, name } = split(path); await (await dir(dirs, false)).removeEntry(name); } catch { /* already gone */ }
}
export async function storageEstimate(): Promise<{ usage: number; quota: number }> {
  const e = await navigator.storage.estimate();
  return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
}
export function download(name: string, data: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
