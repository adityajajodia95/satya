// Runs inside workerd: the HTMLRewriter adapter must reproduce the Node adapter's golden output exactly.
import { describe, expect, it } from "vitest";
import { htmlToTextWorkers } from "../src/text/workers";
import cdc from "./fixtures/pages/cdc-flu.html?raw";
import cdcExpected from "./fixtures/pages/cdc-flu.expected.json";
import govuk from "./fixtures/pages/govuk-passport.html?raw";
import govukExpected from "./fixtures/pages/govuk-passport.expected.json";
import mdn from "./fixtures/pages/mdn-html.html?raw";
import mdnExpected from "./fixtures/pages/mdn-html.expected.json";
import nasa from "./fixtures/pages/nasa-moon.html?raw";
import nasaExpected from "./fixtures/pages/nasa-moon.expected.json";
import wiki from "./fixtures/pages/wikipedia-eiffel.html?raw";
import wikiExpected from "./fixtures/pages/wikipedia-eiffel.expected.json";

const FETCH_TEXT_CHARS = 20_000;

describe("Workers adapter == Node adapter on 5 real pages", () => {
  it.each([
    ["cdc-flu", cdc, cdcExpected],
    ["govuk-passport", govuk, govukExpected],
    ["mdn-html", mdn, mdnExpected],
    ["nasa-moon", nasa, nasaExpected],
    ["wikipedia-eiffel", wiki, wikiExpected],
  ])("%s", async (_name, html, expected) => {
    expect(await htmlToTextWorkers(html, FETCH_TEXT_CHARS)).toEqual(expected);
  });

  it("applies the same implied-end and entity rules as Node", async () => {
    const page = await htmlToTextWorkers(
      "<title>T &amp; U</title><ul><li>lead <p>inner &eacute;</p> tail<li>two</ul><p>a<p>b</p>outside<h2>H</h2>",
      1000,
    );
    expect(page).toEqual({ title: "T & U", text: "lead\ninner é\ntail\ntwo\na\nb\nH" });
  });
});
