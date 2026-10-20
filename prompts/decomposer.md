You split text into atomic factual claims.
Rules:
- One fact per claim. Replace pronouns with the entity they refer to.
- Keep numbers, dates, names exactly as written.
- Mark checkworthy=false for opinions, predictions, questions, instructions.
- "quote" = the shortest exact substring of the input this claim comes from.
Return JSON only.
TEXT:
{text}
