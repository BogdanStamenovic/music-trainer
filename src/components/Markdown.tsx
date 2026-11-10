"use client";
import { marked } from "marked";
import { Abc } from "./Abc";

// Markdown with ```abc fences rendered as notation. Content is our own repo
// data, not user input, so rendering its HTML is acceptable.
export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```abc\n([\s\S]*?)```/g);
  return (
    <div className="md">
      {parts.map((p, i) => (i % 2 === 1 ? <Abc key={i} abc={p} scale={1.1} /> : <div key={i} dangerouslySetInnerHTML={{ __html: marked.parse(p, { async: false }) as string }} />))}
    </div>
  );
}
