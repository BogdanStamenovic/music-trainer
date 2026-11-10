"use client";
import { useEffect, useRef } from "react";

// abcjs is loaded lazily: it is ~400 KB and only needed when notation is shown.
export function Abc({ abc, scale = 1.3 }: { abc: string; scale?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    import("abcjs").then((m) => {
      if (alive && ref.current) m.default.renderAbc(ref.current, abc, { scale, responsive: "resize", add_classes: true, paddingtop: 0, paddingbottom: 0 });
    });
    return () => {
      alive = false;
    };
  }, [abc, scale]);
  return <div className="abc" ref={ref} />;
}
