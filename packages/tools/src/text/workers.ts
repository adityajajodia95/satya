// Workers HTML-to-text adapter (streaming HTMLRewriter). Reports explicit tags to the shared collector.
import { type PageText, TextCollector, WATCHED_SELECTOR } from "./collector";

// Minimal ambient types so this package needs no @cloudflare/workers-types (which conflict with DOM libs).
interface RewriterElement {
  tagName: string;
  onEndTag(handler: (end: { name: string }) => void): void;
}
interface RewriterText {
  text: string;
}
declare class HTMLRewriter {
  on(selector: string, handlers: { element?(el: RewriterElement): void }): HTMLRewriter;
  onDocument(handlers: { text?(chunk: RewriterText): void }): HTMLRewriter;
  transform(response: Response): Response;
}

export async function htmlToTextWorkers(html: string | Response, maxChars: number): Promise<PageText> {
  const collector = new TextCollector();
  const rewriter = new HTMLRewriter()
    .on(WATCHED_SELECTOR, {
      element(el) {
        const tag = el.tagName;
        collector.open(tag);
        // An implied end reports the closing ancestor's name (e.g. "ul" for an unclosed <li>).
        el.onEndTag((end) => collector.close(end.name));
      },
    })
    .onDocument({ text: (chunk) => collector.text(chunk.text) });
  const response = typeof html === "string" ? new Response(html) : html;
  await rewriter.transform(response).arrayBuffer();
  return collector.finish(maxChars);
}
