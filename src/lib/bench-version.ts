import { createHash } from "node:crypto";
import { cases } from "../../bench/panel/cases";
import { canonical } from "@/lib/proof/verify";

/** Proof Bench v2's version: a digest of every case and label (bench/panel/cases.ts). New terms pin it. */
export const PANEL_BENCH_VERSION = `panel-v2:${createHash("sha256").update(canonical(cases)).digest("hex").slice(0, 16)}`;
