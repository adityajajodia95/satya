// A tiny hand-written corpus shared by the fake-port unit test and the real-model (laptop) integration
// test: for each query exactly one passage is the obviously correct evidence.
import type { Passage } from "../schemas";

const p = (id: string, title: string, text: string): Passage => ({
  id,
  source: "wikipedia",
  url: `https://en.wikipedia.org/wiki/${title.replace(/ /g, "_")}`,
  title,
  text,
  published: null,
});

export const TINY_CORPUS: Passage[] = [
  p(
    "eiffel",
    "Eiffel Tower",
    "The Eiffel Tower is a wrought-iron lattice tower in Paris. Construction finished in March 1889, in time for the World's Fair.",
  ),
  p(
    "louvre",
    "Louvre",
    "The Louvre is the world's most-visited art museum, located on the Right Bank of the Seine in Paris.",
  ),
  p(
    "brandenburg",
    "Brandenburg Gate",
    "The Brandenburg Gate is an 18th-century neoclassical monument in Berlin, built on the orders of King Frederick William II.",
  ),
  p(
    "everest",
    "Mount Everest",
    "Mount Everest is Earth's highest mountain above sea level, located in the Mahalangur Himal sub-range of the Himalayas.",
  ),
  p(
    "water",
    "Boiling point",
    "At standard atmospheric pressure at sea level, pure water boils at 100 degrees Celsius.",
  ),
  p(
    "penicillin",
    "Penicillin",
    "Penicillin was discovered in 1928 by Scottish scientist Alexander Fleming at St Mary's Hospital in London.",
  ),
  p(
    "statue",
    "Statue of Liberty",
    "The Statue of Liberty is a colossal copper statue on Liberty Island in New York Harbor, dedicated in 1886.",
  ),
  p(
    "taj",
    "Taj Mahal",
    "The Taj Mahal is an ivory-white marble mausoleum in Agra, India, commissioned in 1631 by the emperor Shah Jahan.",
  ),
];

export const TINY_QUERIES: { query: string; expected: string }[] = [
  { query: "The Eiffel Tower was completed in 1889.", expected: "eiffel" },
  { query: "Water boils at 100 degrees Celsius at sea level.", expected: "water" },
  { query: "Alexander Fleming discovered penicillin.", expected: "penicillin" },
  { query: "The Taj Mahal was commissioned by Shah Jahan.", expected: "taj" },
];

export const RETRIEVAL_CONFIG = { bm25K: 20, denseK: 20, rrfK: 60, rerankTop: 20, finalK: 5 };
