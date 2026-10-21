import { useMemo } from "react";
import { sealRings } from "@/lib/client/seal";

// The terms fingerprint as a banknote seal. Pale and dashed until both sides sign; inked once sealed.
export function GuillocheSeal({ hash, sealed, size = 168, label = true }: { hash: string | null; sealed: boolean; size?: number; label?: boolean }) {
  const rings = useMemo(() => sealRings(hash ?? "", 200), [hash]);
  const short = hash ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : "no terms yet";
  return (
    <figure className="flex flex-col items-center gap-2" aria-label={sealed ? `Terms sealed, fingerprint ${short}` : `Terms not sealed yet, fingerprint ${short}`}>
      <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-hidden="true" className={sealed ? "" : "opacity-40"}>
        <circle cx="100" cy="100" r="97" fill="none" stroke="var(--seal-2)" strokeWidth="0.8" strokeDasharray={sealed ? undefined : "3 3"} />
        <circle cx="100" cy="100" r="93" fill="none" stroke="var(--seal-2)" strokeWidth="0.4" />
        {hash &&
          rings.map((r, i) => (
            <path key={i} d={r.d} fill="none" stroke={r.tone === 0 ? "var(--seal)" : "var(--seal-2)"} strokeWidth={r.width} strokeLinejoin="round" opacity={sealed ? 0.9 : 0.6} />
          ))}
        <circle cx="100" cy="100" r="22" fill="var(--panel)" stroke="var(--seal-2)" strokeWidth="0.6" />
        <text x="100" y="98" textAnchor="middle" fontSize="7.5" fontFamily="var(--font-geist-mono)" fill="var(--ink)">
          {hash ? hash.slice(0, 6) : "------"}
        </text>
        <text x="100" y="108" textAnchor="middle" fontSize="7.5" fontFamily="var(--font-geist-mono)" fill="var(--ink-2)">
          {hash ? hash.slice(-4) : "----"}
        </text>
      </svg>
      {label && (
        <figcaption className="text-center text-xs text-ink-2">
          {sealed ? "Sealed by both sides" : "Not sealed yet"}
          <span className="block font-mono text-[11px] text-ink-3">{short}</span>
        </figcaption>
      )}
    </figure>
  );
}
