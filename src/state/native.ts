// The desktop shell's API (electron/preload.cjs). Undefined when 22PM runs in a plain browser.
export interface DisplayInfo { id: number; label: string; primary: boolean; width: number; height: number }
export interface OutHandle { handle: number; path: string }

export interface NativeApi {
  platform: string;
  project: {
    info(): Promise<{ root: string; name: string; version: string }>;
    reveal(rel?: string): Promise<void>;
    choose(create: boolean): Promise<void>;
  };
  fs: {
    read(rel: string): Promise<Uint8Array | null>;
    write(rel: string, data: Uint8Array | string): Promise<void>;
    remove(rel: string): Promise<void>;
  };
  out: {
    saveDialog(name: string, filters: { name: string; extensions: string[] }[]): Promise<OutHandle | null>;
    dirDialog(): Promise<OutHandle | null>;
    write(handle: number, data: Uint8Array, position: number): Promise<void>;
    writeFile(handle: number, name: string, data: Uint8Array): Promise<void>;
    close(handle: number): Promise<void>;
    reveal(path: string): Promise<void>;
  };
  displays(): Promise<DisplayInfo[]>;
  setOutputDisplay(id: number | null): Promise<void>;
  onMenu(cb: (cmd: string) => void): void;
  onFlush(cb: () => Promise<void>): void;
}

export const native: NativeApi | undefined = (globalThis as any).native;
export const isDesktop = !!native;
