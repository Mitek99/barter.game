import { readFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, sep } from 'node:path';
import type { AssetReader } from '@barter.game/bank-core';

/** AssetReader over a directory bundled with the Lambda (or checked out locally). */
export function fsAssets(dir: string): AssetReader {
  return {
    async read(path: string): Promise<Uint8Array | null> {
      const normalized = normalize(path);
      if (isAbsolute(normalized) || normalized.split(sep).includes('..')) {
        return null;
      }
      try {
        return new Uint8Array(await readFile(join(dir, normalized)));
      } catch {
        return null;
      }
    },
  };
}
