"use client";

import React from "react";

/**
 * dock-ui.tsx — satu bahasa desain untuk SEMUA tab dock.
 *
 * Ergonomi diadopsi dari terminal institusional (referensi Exness WebTerminal):
 *  - panel duduk langsung di ground warna, dipisah hairline + tone, BUKAN
 *    kartu rounded ber-border (anti-slop: tidak ada uniform card grid).
 *  - square edges (radius 0), satu hue ramp ex-*, mono untuk angka.
 *  - type-scale kontras: micro-label 10px uppercase vs display angka besar.
 *  - ritme spacing 8px: toolbar h-9, body p-4, row ~28-32px.
 *
 * Semua tab memakai primitif yang sama (TabToolbar / Section / DataRow / Stat)
 * sehingga framework/layout konsisten walau kontennya berbeda.
 */

export type Tone = "blue" | "red" | "yellow" | "muted" | "text";

export const toneText: Record<Tone, string> = {
  blue: "text-ex-blue",
  red: "text-ex-red",
  yellow: "text-ex-yellow",
  muted: "text-ex-muted",
  text: "text-ex-text",
};

export const toneBadge: Record<Tone, string> = {
  blue: "border-ex-blue/40 text-ex-blue",
  red: "border-ex-red/40 text-ex-red",
  yellow: "border-ex-yellow/40 text-ex-yellow",
  muted: "border-ex-border text-ex-muted",
  text: "border-ex-border text-ex-text",
};

/** Micro-label: uppercase 10px ber-tracking, warna muted. Penanda seksi. */
export function MicroLabel({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`text-[10px] font-semibold uppercase tracking-[0.14em] text-ex-muted ${className}`}
    >
      {children}
    </span>
  );
}

/** Badge persegi (radius 0) untuk provenance / status / impact. */
export function Badge({
  tone = "muted",
  title,
  children,
  className = "",
}: {
  tone?: Tone;
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[9px] font-bold font-mono uppercase tracking-wider whitespace-nowrap ${toneBadge[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/**
 * Toolbar tab yang KONSISTEN untuk semua tab: tinggi h-9, px-4, hairline
 * bawah, judul micro-label di kiri + aksi di kanan. Inilah "shell" yang
 * menyamakan keempat tab.
 */
export function TabToolbar({
  title,
  meta,
  actions,
}: {
  title: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="min-h-9 shrink-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-1 border-b border-ex-border bg-[#10151D]">
      <div className="flex flex-wrap items-center gap-2.5 min-w-0">
        <MicroLabel className="text-ex-text whitespace-nowrap">{title}</MicroLabel>
        {meta ? <div className="flex flex-wrap items-center gap-2 min-w-0">{meta}</div> : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2 shrink-0">{actions}</div>
      ) : null}
    </div>
  );
}

/** Body tab: padding konsisten p-4, duduk di ground dock. */
export function DockBody({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}

/**
 * Seksi ber-label. Dipisah hairline (border-t) + jarak konsisten, bukan
 * kartu. `first` menghilangkan divider atas untuk seksi pertama.
 */
export function Section({
  label,
  aside,
  first = false,
  children,
  className = "",
}: {
  label?: string;
  aside?: React.ReactNode;
  first?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`${first ? "" : "border-t border-ex-border mt-3 pt-3"} ${className}`}
    >
      {label ? (
        <div className="flex items-center justify-between gap-2 mb-2">
          <MicroLabel>{label}</MicroLabel>
          {aside ? <div className="flex items-center gap-2">{aside}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Baris label→value rata kanan-kiri, angka mono. Ritme ~24px. */
export function DataRow({
  label,
  tone = "text",
  bold = false,
  children,
}: {
  label: React.ReactNode;
  tone?: Tone;
  bold?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px] text-[11px] leading-tight">
      <span className="text-ex-muted shrink-0">{label}</span>
      <span
        className={`font-mono text-right min-w-0 break-words ${toneText[tone]} ${
          bold ? "font-bold" : ""
        }`}
      >
        {children}
      </span>
    </div>
  );
}

/** Display angka besar (type-scale kontras) + micro-label + sub. */
export function Stat({
  label,
  value,
  tone = "text",
  sub,
  size = "xl",
}: {
  label: string;
  value: React.ReactNode;
  tone?: Tone;
  sub?: React.ReactNode;
  size?: "lg" | "xl" | "2xl" | "3xl";
}) {
  const sizeClass = {
    lg: "text-lg",
    xl: "text-xl",
    "2xl": "text-2xl",
    "3xl": "text-3xl",
  }[size];
  return (
    <div className="min-w-0">
      <MicroLabel>{label}</MicroLabel>
      <div
        className={`${sizeClass} font-black font-mono leading-none mt-1 ${toneText[tone]}`}
      >
        {value}
      </div>
      {sub ? (
        <div className="text-[10px] font-mono text-ex-muted mt-1 leading-tight">
          {sub}
        </div>
      ) : null}
    </div>
  );
}

/** Catatan kosong / data tidak tersedia — jujur, bukan angka fabrikasi. */
export function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] text-ex-muted leading-snug italic">{children}</p>
  );
}

/** Catatan kaki micro untuk disclaimer / metodologi. */
export function Footnote({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[9px] text-ex-muted leading-tight mt-2">{children}</p>
  );
}

/** Tombol aksi persegi konsolidasi (radius 0), satu ramp. */
export function ActionButton({
  onClick,
  disabled = false,
  title,
  variant = "ghost",
  children,
}: {
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  variant?: "ghost" | "primary";
  children: React.ReactNode;
}) {
  const base =
    "inline-flex items-center justify-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold border transition-colors disabled:opacity-40 disabled:cursor-not-allowed";
  const styles =
    variant === "primary"
      ? "bg-ex-blue border-ex-blue text-white hover:bg-[#1e4bd8]"
      : "bg-ex-panel border-ex-border text-ex-text hover:bg-[#253041]";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${styles}`}
    >
      {children}
    </button>
  );
}

/**
 * Tag provenance data. Memetakan sumber ke satu hue ramp ex-*:
 *  real/deriv/csv -> blue, estimated -> yellow, simulated -> red, unknown -> muted.
 * Tidak pernah menyajikan data simulasi sebagai real.
 */
export function ProvenanceTag({
  source,
  isSimulated,
}: {
  source?: string | null;
  isSimulated?: boolean | null;
}) {
  const sim = isSimulated === true || source === "simulated";
  if (sim) {
    return (
      <Badge tone="red" title="Data simulasi / placeholder — bukan cetakan pasar nyata.">
        SIM
      </Badge>
    );
  }
  if (source === "estimated") {
    return (
      <Badge tone="yellow" title="Bar diturunkan dari H1 — estimasi, bukan cetakan intraday nyata.">
        EST
      </Badge>
    );
  }
  if (source && source.startsWith("fred")) {
    return (
      <Badge tone="blue" title="Berasal dari dataset FRED (CSV historis).">
        FRED
      </Badge>
    );
  }
  if (source === "deriv-cfd") {
    return (
      <Badge tone="blue" title="Candle dari Deriv (CFD Gold/USD).">
        DERIV
      </Badge>
    );
  }
  if (source === "csv-historical" || source === "real") {
    return (
      <Badge tone="blue" title="Berasal dari dataset historis CSV.">
        CSV
      </Badge>
    );
  }
  return null;
}
