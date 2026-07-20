import type { VectorPlatform } from "./types";

export function resolveVectorPlatform(
  iosPlatform: VectorPlatform | null,
  electronPlatform: VectorPlatform | null,
): VectorPlatform | null {
  return iosPlatform ?? electronPlatform;
}
