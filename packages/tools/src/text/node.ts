// Node HTML-to-text adapter (htmlparser2). Reports only explicit tags to the shared collector.
import { Parser } from "htmlparser2";
import { type PageText, TextCollector } from "./collector";

export function htmlToTextNode(html: string, maxChars: number): Promise<PageText> {
  const collector = new TextCollector();
  const parser = new Parser(
    {
      onopentagname: (name) => collector.open(name),
      onclosetag: (name, isImplied) => {
        if (!isImplied) collector.close(name);
      },
      ontext: (text) => collector.text(text),
    },
    { decodeEntities: false, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();
  return Promise.resolve(collector.finish(maxChars));
}
