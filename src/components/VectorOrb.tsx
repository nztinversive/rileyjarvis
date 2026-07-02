import type { CSSProperties } from "react";
import type { MouthShape, RickyMood } from "../lib/realtime";

type VectorOrbProps = {
  mood: RickyMood;
  mouthShape: MouthShape;
};

export function VectorOrb({ mood, mouthShape }: VectorOrbProps) {
  return (
    <div
      className={`vector-orb vector-orb-${mood}`}
      style={
        {
          "--audio-open": mouthShape.open.toFixed(3),
          "--audio-width": mouthShape.width.toFixed(3),
          "--audio-round": mouthShape.round.toFixed(3),
          "--audio-teeth": mouthShape.teeth.toFixed(3),
        } as CSSProperties
      }
      aria-label={`Vector mood: ${mood}`}
    >
      <div className="orb-halo orb-halo-outer" />
      <div className="orb-halo orb-halo-inner" />
      <div className="orb-ring orb-ring-primary" />
      <div className="orb-ring orb-ring-secondary" />
      <div className="orb-shell">
        <div className="orb-glass" />
        <div className="orb-aperture">
          <span />
          <span />
          <span />
        </div>
        <div className="orb-wave orb-wave-a" />
        <div className="orb-wave orb-wave-b" />
      </div>
      <div className="orb-ticks" aria-hidden="true">
        {Array.from({ length: 18 }, (_, index) => (
          <span key={index} style={{ "--tick-index": index } as CSSProperties} />
        ))}
      </div>
    </div>
  );
}
