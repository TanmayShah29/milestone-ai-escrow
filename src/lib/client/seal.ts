// Guilloche seal geometry: banknote-style rosettes generated from a contract's SHA-256 fingerprint.
// Deterministic: the same hash always draws the same seal; a one-character change draws a different one.
// Like a banknote rosette, each band is several phase-shifted copies of one wave, r(θ) = R + A·sin(kθ + φ),
// woven into a mesh; the hash sets each band's radius, amplitude, frequency and twist.

export type SealRing = { d: string; tone: 0 | 1; width: number };

function bytes(hash: string): number[] {
  const clean = /^[0-9a-f]{64}$/i.test(hash) ? hash : "0".repeat(64);
  return Array.from({ length: 32 }, (_, i) => parseInt(clean.slice(i * 2, i * 2 + 2), 16));
}

export function sealRings(hash: string, size = 200): SealRing[] {
  const b = bytes(hash);
  const c = size / 2;
  const rings: SealRing[] = [];
  const bands = 3;
  for (let band = 0; band < bands; band++) {
    const base = c * [0.78, 0.6, 0.42][band]!; // outer, middle, inner band
    const amp = c * (0.05 + (b[band * 4]! / 255) * 0.06);
    const k = 9 + (b[band * 4 + 1]! % 10) + band * 2; // waves around the circle
    const twist = (b[band * 4 + 2]! / 255) * Math.PI * 2;
    const copies = 5 + (b[band * 4 + 3]! % 3); // threads woven in the band
    for (let j = 0; j < copies; j++) {
      const phase = twist + (j * Math.PI * 2) / (k * copies) * k * 0.5;
      const steps = 360;
      let d = "";
      for (let s = 0; s <= steps; s++) {
        const t = (s / steps) * Math.PI * 2;
        const r = base + amp * Math.sin(k * t + phase) + amp * 0.35 * Math.sin(2 * k * t - phase);
        d += `${s === 0 ? "M" : "L"}${(c + r * Math.cos(t)).toFixed(2)} ${(c + r * Math.sin(t)).toFixed(2)}`;
      }
      rings.push({ d: `${d}Z`, tone: (band % 2) as 0 | 1, width: 0.5 });
    }
  }
  return rings;
}
