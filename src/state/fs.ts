// Project storage. In the desktop app the project is a real folder on disk (electron/main.cjs);
// in a plain browser it falls back to the Origin Private File System.
import { native } from './native';

async function dir(path: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
  let d = await navigator.storage.getDirectory();
  for (const p of path) d = await d.getDirectoryHandle(p, { create });
  return d;
}
const split = (path: string) => { const parts = path.split('/').filter(Boolean); return { dirs: parts.slice(0, -1), name: parts[parts.length - 1] }; };

export async function writeFile(path: string, data: Blob | ArrayBuffer | string): Promise<void> {
  if (native) {
    await native.fs.write(path, typeof data === 'string' ? data : new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data));
    return;
  }
  const { dirs, name } = split(path);
  const fh = await (await dir(dirs, true)).getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data as any);
  await w.close();
}

export async function readFile(path: string): Promise<File | null> {
  if (native) {
    const data = await native.fs.read(path);
    return data ? new File([data as Uint8Array<ArrayBuffer>], split(path).name) : null;
  }
  try {
    const { dirs, name } = split(path);
    return await (await (await dir(dirs, false)).getFileHandle(name)).getFile();
  } catch { return null; }
}

export async function removeFile(path: string): Promise<void> {
  if (native) { await native.fs.remove(path); return; }
  try { const { dirs, name } = split(path); await (await dir(dirs, false)).removeEntry(name); } catch { /* already gone */ }
}

export function download(name: string, data: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
