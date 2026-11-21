"use client";

import dynamic from "next/dynamic";

export type { MapPoint } from "./PerimeterMapInner";

/** Leaflet touches `window`; load it on the client only. */
export const PerimeterMap = dynamic(() => import("./PerimeterMapInner"), {
  ssr: false,
  loading: () => <div className="h-[320px] animate-pulse border border-line bg-bg-soft" />,
});
