import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlToTextNode } from "../src/text/node";
import { CONFIG, fixture } from "./helpers";

const text = async (html: string, max = 10_000) => htmlToTextNode(html, max);

describe("HTML-to-text rules (shared collector, Node adapter)", () => {
  it("collects title, h1–h3, p and li; ignores everything else", async () => {
    const page = await text(
      "<html><head><title>T</title></head><body><nav><a>skip</a></nav><h1>H1</h1><h4>no</h4><div>loose</div>" +
        "<p>Para one.</p><ul><li>Item</li></ul><h3>H3</h3><table><td>cell</td></table></body></html>",
    );
    expect(page).toEqual({ title: "T", text: "H1\nPara one.\nItem\nH3" });
  });

  it("decodes entities and collapses whitespace", async () => {
    const page = await text("<p>  Caf&eacute; &amp; cr&#232;me\n\n  &#x2014; ok </p>");
    expect(page.text).toBe("Café & crème — ok");
  });

  it("skips script, style, noscript and template content", async () => {
    const page = await text(
      '<p>a<script>var x = "<p>bad</p>";</script>b</p><style>p{}</style><noscript><p>n</p></noscript>',
    );
    expect(page.text).toBe("ab");
  });

  it("applies implied end tags: <p> closes <p>, headings close <p>, <li> closes <li>, </ul> closes items", async () => {
    const page = await text("<p>one<p>two<h2>head</h2>after<ul><li>x<li>y</ul>tail");
    expect(page.text).toBe("one\ntwo\nhead\nx\ny");
  });

  it("splits nested blocks without duplicating text", async () => {
    const page = await text("<ul><li>lead <p>inner</p> tail</li></ul>");
    expect(page.text).toBe("lead\ninner\ntail");
  });

  it("caps output at maxChars", async () => {
    const page = await text(`<p>${"word ".repeat(100)}</p>`, 23);
    expect(page.text).toHaveLength(23);
  });

  it.each(readdirSync(new URL("./fixtures/pages/", import.meta.url)).filter((f) => f.endsWith(".html")))(
    "%s matches its golden file",
    async (file) => {
      const expected = JSON.parse(fixture(`pages/${file.replace(/\.html$/, ".expected.json")}`));
      expect(await htmlToTextNode(fixture(`pages/${file}`), CONFIG.fetchTextChars)).toEqual(expected);
    },
  );
});
