// Solver interface for in-app splat creation (brief section 3b, milestone M1b).
// Two backends are planned: Vauss (video) and COLMAP + Brush (photos). Both run as subprocesses,
// so they need the desktop shell; in the browser build neither is available.
// Per the brief: take exact commands and flags from the tool's own README / --help. Never guess them.

export interface SolveRequest {
  /** Source video(s) or a folder of photos. */
  inputs: string[];
  preset: 'preview' | 'show';
  /** Upper bound on the number of Gaussians. */
  splatCap?: number;
  /** Optional crop region in solver coordinates. */
  crop?: { min: [number, number, number]; max: [number, number, number] };
  /** Job folder in the project cache. */
  workDir: string;
}

export interface SolveResult {
  splatFile: string;
  /** Solved camera poses: used to orient normals towards the capture cameras. */
  camerasFile?: string;
  /** Textured mesh: shadow and normal proxy. */
  meshFile?: string;
  /** Stored with the asset so any scan can be retrained later. */
  recipe: { solver: string; version: string; sourceHash: string; settings: Record<string, unknown> };
}

export interface SplatSolver {
  readonly id: 'vauss' | 'colmap-brush';
  readonly accepts: 'video' | 'photos';
  /** Is the tool installed and runnable on this machine? */
  available(): Promise<{ ok: boolean; version?: string; reason?: string }>;
  run(req: SolveRequest, onProgress: (fraction: number, stage: string) => void, signal: AbortSignal): Promise<SolveResult>;
}

const needsShell = 'Needs the desktop shell to run a subprocess.';

export const solvers: SplatSolver[] = [
  { id: 'vauss', accepts: 'video', available: async () => ({ ok: false, reason: needsShell }), run: async () => { throw new Error(needsShell); } },
  { id: 'colmap-brush', accepts: 'photos', available: async () => ({ ok: false, reason: needsShell }), run: async () => { throw new Error(needsShell); } },
];
